"use client"

import * as React from "react"
import { ArrowLeft, Check, Pencil, Wand2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { ConnectProviderButton } from "@/components/connect-provider-button"
import { DnsRecords } from "@/components/dns-records"
import { ProviderMark } from "@/components/provider-mark"
import {
  createDomain,
  dnsConnections,
  lookupDns,
  publishDnsRecords,
} from "@/lib/actions"
import { toastFailure } from "@/lib/toast"
import type { DnsInspection, Domain } from "@/lib/types"

/**
 * Setting up the first domain, one question at a time.
 *
 * ⚠ THE SAME DECISIONS AS `AddDomainForm`, ASKED DIFFERENTLY, AND THE
 * DIFFERENCE IS DELIBERATE RATHER THAN DUPLICATION FOR ITS OWN SAKE. That form
 * is the power path: somebody who already has three domains, knows what
 * delegation is, and wants every control on one screen. This is somebody's
 * first five minutes, where a page carrying a name field, a detection panel,
 * two fieldsets and an advanced section is four decisions presented as one wall.
 *
 * ⚠ SO THE PHASES ASK ONE THING EACH AND EVERY ANSWER NARROWS THE NEXT. Name,
 * then which records, then — and this is the part that changes the shape of the
 * flow — nothing. The third question is not asked at all, because for a provider
 * we can write to there is only one sensible answer and we should be trying it
 * rather than offering it.
 *
 * ⚠ AUTOMATIC IS ATTEMPTED, NOT OFFERED. A radio button labelled "let us do it"
 * beside one labelled "I'll do it myself" makes somebody choose between a thing
 * they understand and a thing they do not, twenty seconds after signing up —
 * and the one they understand is the one that takes an afternoon. Pressing on
 * and falling back is the same outcome with the choice removed.
 *
 * ⚠ AND THE FALLBACK IS UNCONDITIONAL. Not connectable, connection refused,
 * publish failed, records in the way, provider having a bad afternoon: all of
 * them land on the same manual screen with the records ready to copy. There is
 * no path through here that ends with somebody stuck, which is the only reason
 * it is safe to try the clever thing first.
 */

type Phase = "name" | "mode" | "working" | "connect" | "manual" | "done"

export function DomainSetup({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = React.useState<Phase>("name")
  const [name, setName] = React.useState("")
  const [answered, setAnswered] = React.useState<{
    domain: string
    inspection: DnsInspection | null
  } | null>(null)
  const [connections, setConnections] = React.useState<string[]>([])
  const [domain, setDomain] = React.useState<Domain | null>(null)
  const [fallbackReason, setFallbackReason] = React.useState<string | null>(null)

  const candidate = name.trim().toLowerCase()
  const plausible = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(candidate)
  const looking = plausible && answered?.domain !== candidate
  const current = answered?.domain === candidate ? answered.inspection : null
  const provider = current?.provider ?? null

  // ⚠ DELEGATION IS DISABLED WHERE THE PROVIDER'S EDITOR HAS NO NS ROW — Wix and
  // Shopify are the live examples — so the question is not asked there at all.
  const canDelegate = provider === null || provider.nsDelegation

  React.useEffect(() => {
    let alive = true
    void dnsConnections().then((result) => {
      if (alive && result.ok) setConnections(result.data.data.map((c) => c.provider))
    })
    return () => {
      alive = false
    }
  }, [])

  /*
   * ⚠ DEBOUNCED AND GUARDED BY A REQUEST TOKEN, for the same reasons as the full
   * form: typing "acme.com" is eight renders, and the answer for "acme.c" can
   * land after the answer for "acme.com" and overwrite it.
   */
  const request = React.useRef(0)
  React.useEffect(() => {
    if (!plausible) return
    const token = ++request.current
    const timer = setTimeout(async () => {
      const result = await lookupDns(candidate)
      if (token !== request.current) return
      // A failed lookup is an ANSWER, not an absence: detection is a
      // convenience and must never block somebody adding their domain.
      setAnswered({ domain: candidate, inspection: result.ok ? result.data : null })
    }, 500)
    return () => clearTimeout(timer)
  }, [candidate, plausible])

  async function begin(delegated: boolean) {
    setPhase("working")

    const created = await createDomain({ name: candidate, delegated })
    if (!created.ok) {
      toastFailure(created)
      setPhase("mode")
      return
    }
    setDomain(created.data)

    const slug = provider?.canConnect ? provider.slug : null
    if (!slug) {
      setFallbackReason(
        provider
          ? `We cannot write records at ${provider.name} yet, so these are yours to publish.`
          : "Publish these at your DNS provider to finish.",
      )
      setPhase("manual")
      return
    }

    if (!connections.includes(slug)) {
      setPhase("connect")
      return
    }

    await attempt(created.data, slug)
  }

  async function attempt(target: Domain, slug: string) {
    setPhase("working")

    const published = await publishDnsRecords({ domainId: target.id, provider: slug })
    if (published.ok) {
      setPhase("done")
      return
    }

    /*
     * ⚠ EVERY FAILURE LANDS HERE, INCLUDING THE 409. A zone with an existing
     * DMARC record needs somebody to agree to its removal, and the screen that
     * explains and confirms that lives on the domain page — asking for it
     * during onboarding would be the most consequential question of the flow
     * asked at the moment somebody understands the least.
     */
    setFallbackReason(
      published.status === 409
        ? "Some records already at those names would have to be removed first, so these are yours to publish for now."
        : "We could not publish them for you, so these are yours to publish.",
    )
    setPhase("manual")
  }

  if (phase === "name") {
    return (
      <Shell
        title="What domain will you send from?"
        blurb="Mail leaves from a domain you control. We will look up who hosts its DNS and take the shortest path from there."
      >
        <FloatingInput
          id="onboarding-domain"
          label="Domain"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          // ⚠ `url` WOULD BE WRONG: it offers a "/" key and browsers autofill
          // whole URLs, and `https://acme.com` can never verify.
          inputMode="url"
          className="font-mono"
          state={looking ? "pending" : "idle"}
          adornment={looking ? <Spinner className="size-3.5" /> : undefined}
          hint="The apex, like acme.com — not a URL and not an address."
        />

        {current && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {provider ? (
              <>
                <ProviderMark slug={provider.slug} name={provider.name} />
                DNS hosted by <strong className="font-medium">{provider.name}</strong>
              </>
            ) : (
              "We could not match your nameservers to a provider we know — that is fine, nothing below depends on it."
            )}
          </p>
        )}

        <Button
          size="lg"
          disabled={!plausible || looking}
          onClick={() => setPhase("mode")}
        >
          {looking && <Spinner />}
          Continue
        </Button>
      </Shell>
    )
  }

  if (phase === "mode") {
    return (
      <Shell
        title="How should this domain be set up?"
        blurb={`We will do the rest for ${candidate} once you pick.`}
        onBack={() => setPhase("name")}
      >
        {canDelegate && (
          <Choice
            icon={<Wand2 className="size-4" />}
            title="Delegate to i10"
            recommended
            description="Point three names at us once. We keep SPF, DKIM, DMARC and MX correct forever, including when they change."
            onSelect={() => void begin(true)}
          />
        )}
        <Choice
          icon={<Pencil className="size-4" />}
          title="Keep the records in my zone"
          description="Six ordinary records that stay yours to maintain. Nothing is delegated."
          onSelect={() => void begin(false)}
        />
      </Shell>
    )
  }

  if (phase === "working") {
    return (
      <Shell title="Setting it up…" blurb="This takes a few seconds.">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {domain ? `Publishing records for ${domain.name}` : `Adding ${candidate}`}
        </p>
      </Shell>
    )
  }

  if (phase === "connect" && provider && domain) {
    return (
      <Shell
        title={`Let us add the records at ${provider.name}`}
        blurb={`We only ask for permission to read your zones and edit DNS records — nothing else in your ${provider.name} account.`}
        onBack={() => setPhase("mode")}
      >
        <ConnectProviderButton
          slug={provider.slug}
          providerName={provider.name}
          size="xl"
          block
        />
        {/*
         * ⚠ A LINK, NOT A SECOND BUTTON. Somebody who does not want to authorise
         * anything must not be stuck here — but giving the escape the same
         * weight as the recommended path turns a clear step back into the
         * choice this flow exists to remove.
         */}
        <button
          type="button"
          onClick={() => {
            setFallbackReason("Publish these at your DNS provider to finish.")
            setPhase("manual")
          }}
          className="cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          I&rsquo;ll add the records myself
        </button>
      </Shell>
    )
  }

  if (phase === "manual" && domain) {
    return (
      <Shell title="Publish these records" blurb={fallbackReason ?? undefined}>
        {/*
         * ⚠ `?? []` BECAUSE A WHITE SCREEN IS THE WORST POSSIBLE ANSWER HERE.
         * `DnsRecords` already says something useful for an empty list, and a
         * response that arrives without them — a shape we did not expect, a
         * fixture, a future API change — should cost somebody one unhelpful
         * panel rather than the whole dashboard.
         */}
        <DnsRecords records={domain.records ?? []} />
        <div className="flex items-center gap-2">
          <Button onClick={onDone}>Done</Button>
          <span className="text-xs text-muted-foreground">
            We check them for you — nothing here has to be right this minute.
          </span>
        </div>
      </Shell>
    )
  }

  if (phase === "done" && domain) {
    return (
      <Shell
        title={`${domain.name} is set up`}
        blurb={`We published the records at ${provider?.name ?? "your provider"}. Verification usually follows within minutes.`}
      >
        <Button onClick={onDone}>
          <Check />
          Continue
        </Button>
      </Shell>
    )
  }

  return null
}

function Shell({
  title,
  blurb,
  onBack,
  children,
}: {
  title: string
  blurb?: string
  onBack?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-6">
      <div>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-3 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            Back
          </button>
        )}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {blurb && <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

/**
 * ⚠ SELECTING IS THE WHOLE INTERACTION — there is no Continue after it. A card
 * that only highlights, followed by a button, is two actions for one decision;
 * at this point in the flow the choice IS the commitment.
 */
function Choice({
  icon,
  title,
  description,
  recommended,
  onSelect,
}: {
  icon: React.ReactNode
  title: string
  description: string
  recommended?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border p-4 text-left",
        "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
        "hover:border-foreground/40 hover:bg-muted/40",
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {recommended && (
            <span className="rounded-pill border px-1.5 py-0.5 text-2xs text-muted-foreground">
              Recommended
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}
