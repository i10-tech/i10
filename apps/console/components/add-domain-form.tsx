"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronDown, Pencil, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { Reveal } from "@repo/ui/components/reveal"
import { Spinner } from "@repo/ui/components/spinner"
import { StepStage } from "@repo/ui/components/step-stage"
import { cn } from "cn"
import { ConnectProviderButton } from "@/components/connect-provider-button"
import { DetectionPanel } from "@/components/detection-panel"
import {
  createDomain,
  dnsConnections,
  lookupDns,
  publishDnsRecords,
} from "@/lib/actions"
import { domainProblem, isDomainMalformed } from "@/lib/domain-check"
import { toastFailure } from "@/lib/toast"
import type { DnsConnection, DnsInspection } from "@/lib/types"

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
 *
 * ⚠ THERE ARE TWO QUESTIONS HERE, NOT ONE, AND CONFLATING THEM IS WHAT THIS
 * FORM USED TO DO. "Delegate, or keep your own records" is about WHICH records
 * exist and who maintains them; "we add them, or you add them" is about HOW they
 * reach the zone. They are independent — a delegating customer can still paste
 * six NS records by hand, and a customer keeping their own records can still
 * have us write them — so offering "delegate" against "publish the records
 * myself" made one of the four combinations unreachable and implied the other
 * three were one decision.
 */

type Mode = "delegate" | "manual"

/** How the records reach the customer's zone. Independent of `Mode`. */
type Delivery = "automatic" | "manual"

export function AddDomainForm({ onCreated }: { onCreated?: (id: string) => void }) {
  const router = useRouter()

  const [name, setName] = React.useState("")
  const [chosenMode, setChosenMode] = React.useState<Mode>("delegate")
  const [chosenDelivery, setChosenDelivery] = React.useState<Delivery>("automatic")
  /*
   * ⚠ FETCHED ONCE AND ALLOWED TO FAIL. Whether this workspace has already
   * connected the provider changes only what the automatic option SAYS, never
   * whether it is offered — so a failed request leaves somebody able to pick it
   * and connect on the next screen, rather than blocking the form on a fact it
   * does not need.
   */
  const [connections, setConnections] = React.useState<DnsConnection[]>([])
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
  const [advanced, setAdvanced] = React.useState(false)

  /*
   * ⚠ THE SAME RULES THE SIGN-IN PAGE'S EMAIL BOX FOLLOWS, FROM THE SAME HOOK.
   * Red only once somebody has stopped typing, green only where a value was
   * shown wrong and has since been fixed. The alternative was a second set of
   * rules on the one field in the console people get wrong most often — and a
   * form that reddens `acme.` on the third keystroke of `acme.com` is a form
   * whose red means nothing by the time it is right.
   */

  const candidate = name.trim().toLowerCase()

  /*
   * ⚠ THE LOOKUP GATE AND THE BORDER COLOUR ASK THE SAME FUNCTION, AND THEY
   * USED NOT TO. This line was its own regex, and it was looser than the
   * verdict in ways that showed: `acme.c` passed it, so the form spent a
   * nameserver lookup on a name the field was about to call malformed, and then
   * reported what it found — "DNS hosted by Cloudflare" under a domain that
   * does not exist. Two definitions of "is this a domain" in one component is
   * one more than there can be.
   */
  const plausible = candidate !== "" && !isDomainMalformed(candidate)

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
  React.useEffect(() => {
    let alive = true
    void dnsConnections().then((result) => {
      if (alive && result.ok) setConnections(result.data.data)
    })
    return () => {
      alive = false
    }
  }, [])

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
   * ⚠ WHAT THE PANEL DRAWS WHILE IT IS COLLAPSING, WHICH IS NOT WHAT THE FORM
   * ACTS ON. `current` goes null the instant a character is typed, and a block
   * that is animating its height to zero still has to render every frame of
   * that — so binding the panel's CONTENT to `current` would blank it before it
   * finished leaving. The last answer we received is the right thing to show on
   * the way out, and `show` above stays bound to `current` so it is on the way
   * out at all.
   */
  const panel = current ?? answered?.inspection ?? null

  /**
   * The provider the delivery question is ABOUT, which outlives the answer for
   * the same reason the panel's does.
   *
   * ⚠ IT MUST NOT BE USED FOR ANY DECISION. `provider` is what the form acts
   * on — which options exist, what gets submitted — and it is null the moment
   * the typed name stops matching what we looked up. This one exists only so
   * the fieldset has a name to print while it collapses.
   */
  const leavingProvider = provider ?? panel?.provider ?? null

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

  /*
   * ⚠ AUTOMATIC IS ONLY REAL WHERE WE HOLD AN ADAPTER FOR THE PROVIDER.
   * Twenty-two of the forty providers in the registry have no usable
   * per-customer API, so for most domains this axis has one answer — and
   * resolving it here rather than correcting the stored choice means somebody
   * who types a Cloudflare domain, then a Namecheap one, then goes back still
   * has the preference they picked.
   */
  const canAutomate = provider?.canConnect === true
  const delivery: Delivery = canAutomate ? chosenDelivery : "manual"
  const connected =
    provider !== null && connections.some((c) => c.provider === provider.slug)

  /*
   * ⚠ ONLY ONCE THE LOOKUP HAS ANSWERED. `canAutomate` comes from the detected
   * provider, so before it lands this is false and the button says "Add
   * domain" — which is correct rather than merely safe: a domain whose DNS we
   * cannot write to never shows a connect button at all.
   */
  const needsConnection = canAutomate && !connected && delivery === "automatic"

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (submitting) return

    /*
     * ⚠ NOTHING GUARDS THE SHAPE HERE ANY MORE. The field refuses its own
     * form's submit before this is reached — reddening itself, releasing the
     * caret so the red can be seen, and leaving an empty box alone because
     * emptiness is not a mistake until somebody says they are finished. That
     * was twenty lines in this file and four more in the sign-in form, both
     * hand-written from the same rules. See
     * @repo/ui/components/validated-field.
     */
    setSubmitting(true)

    const result = await createDomain({
      name: name.trim().toLowerCase(),
      delegated: mode === "delegate",
      ...(returnPath.trim() ? { custom_return_path: returnPath.trim() } : {}),
    })

    setSubmitting(false)

    if (!result.ok) {
      /*
       * ⚠ A PLAN LIMIT GETS A BUTTON, NOT JUST A MESSAGE. It is the one refusal
       * on this surface that the person can resolve in ten seconds, and leaving
       * them to find the billing page themselves turns a sale into a support
       * ticket. This used to be a red panel under the form with the button
       * inside it; the toast carries the same action.
       */
      toastFailure(result, {
        ...(result.name === "plan_limit_exceeded"
          ? {
              action: {
                label: "See plans",
                onClick: () => router.push("/settings/billing"),
              },
            }
          : {}),
      })
      return
    }

    const created = result.data

    /*
     * ⚠ THE AUTOMATIC CHOICE HAS TO ACTUALLY DO SOMETHING HERE, OR IT IS A
     * PREFERENCE NOBODY ACTED ON. Publishing on the next screen instead would
     * make this a question whose answer changes only the wording, which is the
     * worst kind of setting.
     *
     * ⚠ AND THE CONFLICT CASE IS HANDED ON RATHER THAN DUPLICATED. A zone with
     * an existing DMARC record answers 409 with what stands in the way, and the
     * dialog that explains and confirms that already exists on the domain page.
     * Rebuilding it here would be two copies of the one flow that deletes a
     * customer's records.
     */
    if (delivery === "automatic" && connected && provider) {
      const published = await publishDnsRecords({
        domainId: created.id,
        provider: provider.slug,
      })

      if (published.ok) {
        toast.success(`${created.name} added and published`, {
          description:
            published.data.created.length === 0
              ? "Every record was already in place. Verification usually follows within minutes."
              : `${published.data.created.length} records written to ${provider.name}. Verification usually follows within minutes.`,
        })
      } else if (published.status === 409) {
        toast.warning(`${created.name} added`, {
          description: "Some existing records are in the way. Review them to finish.",
        })
      } else {
        toast.warning(`${created.name} added`, {
          description: `We could not publish the records: ${published.error}`,
        })
      }

      if (onCreated) onCreated(created.id)
      else router.push(`/domains/${created.id}`)
      return
    }

    toast.success(`${created.name} added`, {
      description:
        delivery === "automatic"
          ? `Connect ${provider?.name ?? "your DNS provider"} to finish.`
          : mode === "delegate"
            ? "Publish the NS records to finish."
            : "Publish the records to finish.",
    })

    if (onCreated) onCreated(created.id)
    else router.push(`/domains/${created.id}`)
  }

  return (
    /*
     * ⚠ `noValidate`, BECAUSE THE BROWSER'S OWN BUBBLE IS NOT OUR INTERFACE.
     * The field is still `required` — that is what it is, and screen readers
     * read it — but without this the empty submit raised a native "Please fill
     * out this field." tooltip in the operating system's styling, positioned by
     * the browser, which then swallowed the message this form writes itself.
     * The same reason every form in the auth app carries it.
     */
    <form onSubmit={submit} className="space-y-6" noValidate>
      {/*
       * ⚠ THE FIELD GOES AMBER WHILE THE NAMESERVER LOOKUP IS IN FLIGHT, which
       * is the same fact the disabled submit button below is already acting on
       * — it just was not visible anywhere. `looking` is derived from what has
       * been typed against what has been answered, so it cannot latch on.
       */}
      <ValidatedInput
        id="domain"
        label="Domain"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        // ⚠ `url` WOULD BE WRONG HERE. It offers a keyboard with a "/" key
        // and browsers autofill it with whole URLs — and `https://acme.com`
        // creates a domain that can never verify.
        inputMode="url"
        className="font-mono"
        check={domainProblem}
        required="Enter the domain you send from."
        /*
         * ⚠ THE LOOKUP OUTRANKS THE VERDICT, AND THEY CANNOT BOTH BE TRUE. A
         * name is only looked up once it is well formed, so `busy` implies the
         * verdict is `idle` — the order is what it reads like, not a tie being
         * broken.
         */
        busy={looking}
        adornment={looking ? <Spinner className="size-3.5" /> : undefined}
        /*
         * ⚠ THE COMPLAINT REPLACES THE EXPLANATION RATHER THAN JOINING IT. Both
         * at once is two sentences in two colours under one box, and the one
         * that matters is the one about what is wrong right now — the guidance
         * comes back the moment the value does. The field does that swap
         * itself now.
         */
        hint={
          <>
            The apex, or a subdomain you send from — a subdomain like{" "}
            <code className="font-mono">mail.example.com</code> keeps your sending
            reputation separate.
          </>
        }
      />

      {/*
       * ⚠ IT GROWS IN RATHER THAN APPEARING. This panel is the form answering a
       * question somebody asked by typing, and when it mounted outright it put
       * ninety pixels on screen in one frame and pushed the two fieldsets and
       * both buttons down by ninety pixels in the same frame. The content was
       * right and the delivery read as the page reloading.
       *
       * ⚠ IT IS STILL BOUND TO THE ANSWER FOR WHAT IS CURRENTLY TYPED, NOT TO
       * THE LAST ANSWER WE GOT. Holding the previous inspection open while a
       * new lookup is in flight would keep the panel from collapsing when
       * somebody edits a finished domain — smoother, and it would be showing
       * one domain's nameservers under another domain's name. The collapse is
       * the truthful thing to do, and now it is a movement rather than a cut.
       */}
      <Reveal show={current !== null}>
        {panel && <DetectionPanel inspection={panel} connected={connected} />}
      </Reveal>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          Which records should exist?
        </legend>

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
          title="Keep the records in my zone"
          description="Six ordinary records — SPF, DKIM, DMARC and the two return paths. Nothing is delegated, and they stay yours to maintain."
        />
      </fieldset>

      {/*
       * ⚠ THE SECOND QUESTION, AND ONLY WHERE IT HAS TWO ANSWERS. For the
       * twenty-two providers with no usable per-customer API there is nothing
       * to choose between, and a fieldset with one selectable option is a
       * question that reads as a decision somebody has to make.
       */}
      <Reveal show={canAutomate && provider !== null}>
        {leavingProvider && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              How should they get there?
            </legend>

            <ModeCard
              selected={delivery === "automatic"}
              onSelect={() => setChosenDelivery("automatic")}
              icon={<Wand2 className="size-4" />}
              title={`Add them for me at ${leavingProvider.name}`}
              recommended
              description={
                connected
                  ? mode === "delegate"
                    ? `We write the six NS records into ${leavingProvider.name} as soon as the domain is added. We only ever touch the three delegated names.`
                    : `We write all six records into ${leavingProvider.name} as soon as the domain is added.`
                  : `You will be asked to authorise ${leavingProvider.name} first. We only request permission to read your zones and edit DNS records.`
              }
            />

            <ModeCard
              selected={delivery === "manual"}
              onSelect={() => setChosenDelivery("manual")}
              icon={<Pencil className="size-4" />}
              title="I'll add them myself"
              description={
                leavingProvider.manualPath
                  ? `We show you the records and check them as they appear — ${leavingProvider.manualPath}.`
                  : "We show you the records and check them as they appear, telling you which are still missing."
              }
            />
          </fieldset>
        )}
      </Reveal>

      {/*
       * ⚠ A BUTTON AND A `Reveal`, NOT `Collapsible`. Radix's collapsible is
       * correct and does nothing at all on its own: it toggles `data-state` and
       * expects a stylesheet to carry the height, and ours never did — so this
       * disclosure snapped open on a screen where the panel above it springs.
       * Wiring CSS keyframes to it would have fixed the snap and left this one
       * element moving to a different curve from everything around it.
       *
       * ⚠ AND THE CHEVRON TURNS ON THE SAME SPRING TOKEN THE REST OF THE FORM
       * USES, rather than the bare `transition-transform` it had, which took
       * the browser's default 150ms ease while the block under it took 420ms.
       * Two halves of one control disagreeing about how long the gesture lasts
       * is exactly the thing that reads as unfinished.
       */}
      <div>
        <button
          type="button"
          onClick={() => setAdvanced((open) => !open)}
          aria-expanded={advanced}
          className="group flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "size-3 transition-transform duration-(--duration-spring) ease-(--ease-spring)",
              advanced && "rotate-180",
            )}
          />
          Advanced
        </button>
        <Reveal show={advanced} spacing="pt-3">
          <FloatingInput
            id="return-path"
            label="Return-Path subdomain"
            value={returnPath}
            onChange={(event) => setReturnPath(event.target.value)}
            className="font-mono"
            containerClassName="max-w-xs"
            autoComplete="off"
            spellCheck={false}
            hint={
              <>
                Where bounces go. Defaults to <code className="font-mono">send</code>.
                Changing it later means re-publishing records.
              </>
            }
          />
        </Reveal>
      </div>

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
        {/*
         * ⚠ ONE CONTROL THAT CHANGES, NOT TWO THAT COMPETE. Until the lookup
         * lands we cannot know whether connecting is even possible, so the
         * button says the thing that is always true — add the domain. Once the
         * provider is known to be one we can write to, connecting IS the next
         * step, and offering it beside "Add domain" would ask somebody to
         * choose between two halves of the same job.
         *
         * ⚠ AND IT REVERTS ONCE CONNECTED. Coming back from the provider, the
         * remaining step is the one it always was.
         *
         * ⚠ WHAT WAS TYPED IS NOT CARRIED ACROSS THE CONNECT, DELIBERATELY. It
         * could be — session storage survives the round trip — but restoring it
         * means writing React state from an effect on mount, which is a
         * cascading render the compiler is right to refuse, and the alternative
         * of a lazy initialiser reading storage produces a hydration mismatch
         * on a controlled input. The prize is not retyping one domain name ONCE
         * EVER: a connection is per workspace, so every domain after the first
         * sees "Add domain" here and never leaves the page at all.
         */}
        {/*
         * ⚠ THE SWAP IS ANIMATED FOR THE SAME REASON THE PANEL ABOVE IT IS. One
         * control changing its mind is the entire idea here, and a control that
         * changes by being replaced between two frames does not read as one
         * control — it reads as the first button vanishing and a different one
         * taking its place, which is the thing this design exists to avoid.
         */}
        <StepStage step={needsConnection ? "connect" : "add"} className="w-auto">
          {needsConnection && leavingProvider ? (
            <ConnectProviderButton
              slug={leavingProvider.slug}
              providerName={leavingProvider.name}
              size="default"
              brand
            />
          ) : (
            <Button
              type="submit"
              /*
               * ⚠ DISABLED WHILE EMPTY, THE SAME AS THE SIGN-IN PAGE'S
               * CONTINUE. It is the half of "empty is not a mistake" that the
               * verdict alone cannot express: a button somebody can press with
               * nothing typed has to say SOMETHING when they do, and the only
               * honest thing to say is a complaint about a box they had not got
               * to yet.
               */
              disabled={submitting || looking || name.trim().length === 0}
            >
              {submitting && <Spinner />}
              Add domain
            </Button>
          )}
        </StepStage>
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
