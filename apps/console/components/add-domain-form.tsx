"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Check, ChevronDown, Info, Plug, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/components/collapsible"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { ProviderMark } from "@/components/provider-mark"
import { createDomain, lookupDns } from "@/lib/actions"
import type { DnsInspection } from "@/lib/types"

/**
 * Adding a domain.
 *
 * ⚠ THE DNS LOOKUP HAPPENS *BEFORE* THE DOMAIN IS CREATED, WHICH IS WHY IT
 * TAKES A NAME RATHER THAN AN ID. The whole value of it is telling somebody who
 * hosts their DNS while they are still deciding how to set this up — asking
 * them to create a row first, find out we cannot help, and then delete it is a
 * worse flow than not detecting anything at all.
 *
 * ⚠ AND DELEGATION IS THE DEFAULT, NOT THE FALLBACK. Twenty-two of the forty
 * providers in the registry have no usable per-customer API, and the two
 * largest registrars gate theirs behind spend thresholds — so "connect your
 * provider" is the exception. Delegation also removes an entire class of
 * failure: the records cannot drift, because the customer does not hold them.
 *
 * ⚠ THE CHOICE IS RECORDED AT CREATION AND CANNOT BE CHANGED THROUGH THIS FORM.
 * Switching a live domain between delegated and manual changes which records
 * must exist, so doing it silently would stop mail. The API's `delegated` flag
 * is deliberately create-only for the same reason.
 */

type Mode = "delegate" | "manual"

export function AddDomainForm({ onCreated }: { onCreated?: (id: string) => void }) {
  const router = useRouter()

  const [name, setName] = React.useState("")
  const [chosenMode, setChosenMode] = React.useState<Mode>("delegate")
  const [returnPath, setReturnPath] = React.useState("")
  /*
   * ⚠ THE ANSWER IS STORED WITH THE QUESTION IT ANSWERS, AND THAT IS THE WHOLE
   * REASON THIS IS A PAIR RATHER THAN A `DnsInspection | null`. "Which domain
   * have we finished looking up" and "what did we find" are different facts, and
   * a failed lookup has the first without the second. Collapsing them meant a
   * failure was indistinguishable from "still waiting", so the spinner spun for
   * ever on any domain whose lookup errored — and the submit guard below, which
   * waits for the lookup, would have made that a form that can never be
   * submitted.
   */
  const [answered, setAnswered] = React.useState<{
    domain: string
    inspection: DnsInspection | null
  } | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<{ message: string; name: string } | null>(
    null,
  )

  const candidate = name.trim().toLowerCase()
  const plausible = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate)

  /*
   * ⚠ DERIVED, NOT STATE. "Are we looking one up" is entirely a function of what
   * has been typed and what has been answered — a `looking` flag set inside the
   * debounce effect would be a second source of truth for the same fact, and it
   * is exactly the kind of state that gets stuck true when a request is dropped.
   *
   * ⚠ AND IT IS COMPARED AGAINST `answered.domain`, NOT AGAINST A RESULT. A
   * failed lookup still answers the question "have we finished with this name",
   * which is what this is asking.
   */
  const looking = plausible && answered?.domain !== candidate

  /*
   * ⚠ THE LOOKUP IS DEBOUNCED AND GUARDED BY A REQUEST TOKEN. Typing
   * "acme.com" fires eight renders; without the debounce that is eight DNS
   * lookups, and without the token the answer for "acme.c" can land after the
   * answer for "acme.com" and overwrite it — so the screen shows the provider
   * for a domain that was never submitted. The counter is compared on arrival
   * and a stale response is dropped.
   */
  const request = React.useRef(0)

  React.useEffect(() => {
    // Not yet a plausible apex. Nothing to look up, and nothing to clear —
    // `looking` is derived and `inspection` is compared against the current
    // candidate wherever it is read.
    if (!plausible) return

    const token = ++request.current

    const timer = setTimeout(async () => {
      const result = await lookupDns(candidate)
      // ⚠ A STALE ANSWER IS DROPPED. The response for "acme.c" can land after
      // the response for "acme.com" and would otherwise overwrite it — showing
      // the provider for a domain that was never submitted.
      if (token !== request.current) return
      // ⚠ A FAILURE IS RECORDED AS AN ANSWER, NOT AS AN ABSENCE. Detection is a
      // convenience; a resolver that times out must leave somebody able to add
      // their domain, which means the form has to know the attempt is over.
      setAnswered({ domain: candidate, inspection: result.ok ? result.data : null })
    }, 500)

    return () => clearTimeout(timer)
  }, [candidate, plausible])

  // ⚠ ONLY TRUSTED WHEN IT IS THE ANSWER FOR WHAT IS CURRENTLY TYPED. Holding
  // the last successful inspection while somebody edits the field would leave
  // the previous domain's provider on screen next to the new name.
  const current = answered?.domain === candidate ? answered.inspection : null
  const provider = current?.provider ?? null

  /*
   * ⚠ A RESOLVER IS NOT A HOST, AND THIS IS THE ONE CASE THE UI MUST EXPLAIN
   * RATHER THAN SOLVE. It cannot actually be reached by detection — 8.8.8.8
   * never appears in an NS record set — but the registry carries the two
   * resolvers so that any surface offering a provider list can say so. Kept
   * here because the same component will grow a manual picker.
   */
  const resolverConfusion = provider?.kind === "resolver"

  // ⚠ DELEGATION IS DISABLED, NOT HIDDEN, WHERE THE PROVIDER'S EDITOR HAS NO NS
  // ROW. Hiding it would leave somebody wondering why the recommended option
  // vanished; disabling it with the reason attached answers the question before
  // it is asked. Shopify and Wix are the live examples.
  const delegationBlocked = provider !== null && !provider.nsDelegation

  /*
   * ⚠ DERIVED RATHER THAN CORRECTED. Forcing the stored choice back to `manual`
   * in an effect would overwrite what the person picked — so if they then typed
   * a different domain whose provider DOES support NS records, their original
   * preference would be gone. Keeping the choice and resolving it at the point
   * of use means the form remembers what they asked for.
   */
  const mode: Mode = delegationBlocked ? "manual" : chosenMode

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setError(null)

    const result = await createDomain({
      name: name.trim().toLowerCase(),
      delegated: mode === "delegate",
      ...(returnPath.trim() ? { custom_return_path: returnPath.trim() } : {}),
    })

    setSubmitting(false)

    if (!result.ok) {
      setError({ message: result.error, name: result.name })
      return
    }

    toast.success(`${result.data.name} added`, {
      description:
        mode === "delegate"
          ? "Publish the NS records to finish."
          : "Publish the records to finish.",
    })

    if (onCreated) onCreated(result.data.id)
    else router.push(`/domains/${result.data.id}`)
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="domain">Domain</Label>
        <div className="relative">
          <Input
            id="domain"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            // ⚠ `url` WOULD BE WRONG HERE. It offers a keyboard with a "/" key
            // and browsers autofill it with whole URLs — and `https://acme.com`
            // creates a domain that can never verify.
            inputMode="url"
            className="font-mono"
            required
          />
          {looking && (
            <Spinner className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The apex, or a subdomain you send from. A subdomain like{" "}
          <code className="font-mono">mail.example.com</code> keeps your sending
          reputation separate from the rest of your mail.
        </p>
      </div>

      {current && (
        <div className="rounded-lg border">
          <div className="flex items-start gap-3 px-4 py-3">
            {provider ? (
              <ProviderMark
                slug={provider.slug}
                name={provider.name}
                className="mt-0.5 size-4"
              />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              {provider ? (
                <>
                  <p className="text-sm">
                    DNS hosted by{" "}
                    <strong className="font-medium">{provider.name}</strong>
                    {current.confidence === "partial" && (
                      <span className="text-muted-foreground">
                        {" "}
                        — though not all of your nameservers point there
                      </span>
                    )}
                  </p>
                  {current.confidence === "partial" && (
                    /*
                     * ⚠ A GENUINE AND COMMON STATE, NOT A ROUNDING ERROR. A
                     * domain part-way through a migration answers with two
                     * providers' nameservers at once, and records published at
                     * one of them resolve unpredictably. Saying so now saves an
                     * afternoon of "I added the record and it does not verify".
                     */
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      Your nameservers are split between providers. Records added at one
                      of them may not resolve until the migration finishes.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm">
                  {current.nameservers.length > 0
                    ? "We could not match your nameservers to a provider we know."
                    : "No nameservers found for that domain yet."}
                </p>
              )}

              {current.nameservers.length > 0 && (
                <p className="font-mono text-2xs break-all text-muted-foreground">
                  {current.nameservers.join("  ·  ")}
                </p>
              )}

              {resolverConfusion && (
                <p className="text-xs text-muted-foreground">
                  {provider?.name} is a public <em>resolver</em> — it answers DNS
                  questions but does not host anyone&rsquo;s records. Your DNS host is
                  whoever your domain&rsquo;s nameservers point to, usually your
                  registrar.
                </p>
              )}
            </div>
          </div>

          {provider?.canConnect && (
            <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
              <p className="text-xs text-muted-foreground">
                We can publish the records for you.
              </p>
              {/*
               * ⚠ DISABLED AND LABELLED, NOT HIDDEN. The provider adapters —
               * OAuth for Cloudflare, DigitalOcean, DNSimple, Linode, Netlify
               * and Vercel; a pasted token for the rest — are the next piece of
               * work, and the registry already carries everything they need.
               * Hiding the button would make the capability invisible; showing
               * it live would be a lie. See docs/decisions/console.md §7.
               */}
              <Button type="button" variant="outline" size="sm" disabled>
                <Plug />
                Connect {provider.name}
                <span className="text-muted-foreground">· soon</span>
              </Button>
            </div>
          )}
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">How should we set this up?</legend>

        <ModeCard
          selected={mode === "delegate"}
          disabled={delegationBlocked}
          onSelect={() => setChosenMode("delegate")}
          icon={<Wand2 className="size-4" />}
          title="Delegate to i10"
          recommended
          description={
            delegationBlocked
              ? `${provider?.name ?? "This provider"}'s DNS editor does not offer NS records, so delegation is not possible there.`
              : "Delegate three names to us once. We serve the mail subdomains ourselves, so SPF, DKIM, DMARC and MX stay correct forever — including when they change."
          }
        />

        <ModeCard
          selected={mode === "manual"}
          onSelect={() => setChosenMode("manual")}
          icon={<Check className="size-4" />}
          title="Publish the records myself"
          description={
            provider?.manualPath
              ? `Six records to add at ${provider.name} — ${provider.manualPath}.`
              : "Six records to add at your DNS provider. We check them for you and tell you which are still missing."
          }
        />
      </fieldset>

      <Collapsible>
        <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="space-y-2">
            <Label htmlFor="return-path">Return-Path subdomain</Label>
            <Input
              id="return-path"
              value={returnPath}
              onChange={(event) => setReturnPath(event.target.value)}
              placeholder="send"
              className="max-w-xs font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Where bounces are collected. Defaults to{" "}
              <code className="font-mono">send</code>. Changing it after verification
              means re-publishing records, so pick it now if you care.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {error && (
        <div
          className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            error.name === "plan_limit_exceeded"
              ? "border-warning/25 bg-warning/5"
              : "border-danger/25 bg-danger/5",
          )}
        >
          <p>{error.message}</p>
          {/*
           * ⚠ A PLAN LIMIT GETS A BUTTON, NOT JUST A MESSAGE. It is the one
           * refusal on this surface that the person can resolve in ten seconds,
           * and burying the route to it inside a red error box turns a sale
           * into a support ticket.
           */}
          {error.name === "plan_limit_exceeded" && (
            <Button size="sm" className="mt-2" asChild>
              <a href="/settings/billing">See plans</a>
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        {/*
         * ⚠ DISABLED WHILE THE LOOKUP IS IN FLIGHT, BECAUSE `mode` IS NOT
         * DECIDED UNTIL IT LANDS. `delegationBlocked` comes from the detected
         * provider, so submitting during the debounce sends `delegated: true`
         * for a Wix or Shopify domain whose DNS editor has no NS row — a domain
         * created in a configuration that can never verify, and one this form
         * refuses to create a second later. The wait is bounded: a failed lookup
         * still answers, so this cannot latch.
         */}
        <Button
          type="submit"
          disabled={submitting || looking || name.trim().length === 0}
        >
          {submitting && <Spinner />}
          Add domain
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function ModeCard({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  description,
  recommended,
}: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  description: string
  recommended?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      /*
       * ⚠ `aria-pressed` RATHER THAN A HIDDEN RADIO INPUT. A visually hidden
       * radio with a label wrapping a card is the usual trick and it breaks the
       * moment the card contains its own interactive element — which this one
       * will, as soon as "Connect" moves inside it. A toggle button announces
       * its state correctly and has no such constraint.
       */
      aria-pressed={selected}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "duration-(--duration-instant) ease-(--ease-linear)",
        selected ? "border-foreground/40 bg-muted/40" : "hover:bg-muted/30",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 shrink-0",
          selected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {recommended && !disabled && (
            <span className="rounded-full border px-1.5 py-0.5 text-2xs text-muted-foreground">
              Recommended
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}
