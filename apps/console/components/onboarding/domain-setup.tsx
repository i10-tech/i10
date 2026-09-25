"use client"

import * as React from "react"
import { ArrowLeft, Check, Pencil, Wand2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { domainProblem, isDomainMalformed, refusesTheName } from "@/lib/domain-check"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { ConnectProviderButton } from "@/components/connect-provider-button"
import { DnsRecords } from "@/components/dns-records"
import { ProviderMark } from "@/components/provider-mark"
import { checkDomain, createDomain, dnsConnections, lookupDns } from "@/lib/actions"
import { activateDomain, watchUntilVerified } from "@/lib/domain-activation"
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
    /** Why the API would refuse this name, asked alongside the lookup. */
    refusal: string | null
  } | null>(null)
  const [connections, setConnections] = React.useState<string[]>([])
  const [domain, setDomain] = React.useState<Domain | null>(null)
  const [fallbackReason, setFallbackReason] = React.useState<string | null>(null)
  /**
   * Whether the provider has agreed yet, while the success screen is on show.
   *
   * ⚠ SEPARATE FROM `domain.status` BECAUSE IT KEEPS MOVING AFTER THE SCREEN
   * RENDERS. The records are published within a second or two and Amazon's
   * verification lands whenever it lands, so the honest screen is one that
   * says "checking" and changes its own mind — not one that picks a sentence
   * at render time and leaves somebody to reload the page to find out.
   */
  const [verified, setVerified] = React.useState(false)

  /**
   * A name the server refused, and what it said.
   *
   * ⚠ THE SAME TREATMENT `/domains/new` GIVES IT, AND IT USED TO BE A TOAST
   * HERE ON THE ONE SCREEN A NEW CUSTOMER IS GUARANTEED TO SEE. The API owns
   * rules the console cannot check — `i10.tech` is ours, `acme.com` is
   * already in this workspace — and `answered.refusal` below catches those as
   * they are typed. This is the backstop for the race that check cannot
   * close: a name that became taken between the check and the press goes back
   * to the name with the reason under it, not to a toast on the mode screen.
   */
  const [refused, setRefused] = React.useState<{ name: string; reason: string } | null>(
    null,
  )

  const candidate = name.trim().toLowerCase()
  /*
   * ⚠ THE SAME DEFINITION OF "IS THIS A DOMAIN" AS THE FIELD'S OWN VERDICT AND
   * AS /domains/new. This was a loose regex of its own, so `acme.c` spent a
   * nameserver lookup and lit Continue under a box about to call it malformed.
   */
  const plausible = candidate !== "" && !isDomainMalformed(candidate)
  const looking = plausible && answered?.domain !== candidate
  const current = answered?.domain === candidate ? answered.inspection : null
  /*
   * ⚠ ONLY WHILE THE BOX STILL HOLDS THE NAME IT WAS ABOUT — typed-time check
   * first, the create's own refusal as the backstop. Editing clears the red.
   */
  const refusedHere =
    (answered?.domain === candidate ? answered.refusal : null) ??
    (refused && candidate === refused.name ? refused.reason : undefined)
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
      const [result, check] = await Promise.all([
        lookupDns(candidate),
        checkDomain(candidate),
      ])
      if (token !== request.current) return
      // A failed lookup is an ANSWER, not an absence: detection is a
      // convenience and must never block somebody adding their domain. A
      // failed check is "no objection" for the same reason — create decides.
      setAnswered({
        domain: candidate,
        inspection: result.ok ? result.data : null,
        refusal: check.ok ? check.data.refusal : null,
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [candidate, plausible])

  /*
   * ⚠ THERE IS NO "SETTING IT UP" SCREEN ON THIS PATH ANY MORE, AND THE
   * REASON IS THAT IT WAS NOT TRUE. Pressing Delegate for a provider we are
   * not connected to does exactly one thing — create the row — and then asks
   * the next question; nothing is published, so a screen reading "Publishing
   * records for acme.com" described work that had not started and would not
   * start here.
   *
   * ⚠ IT WAS ALSO THE JUMP. Blank, then a spinner, then the next card
   * arriving from nothing is three layouts for one press. Holding the
   * question on screen with the pressed choice busy is one layout, and the
   * next screen replaces it once there is something to show.
   *
   * ⚠ THE SCREEN SURVIVES FOR `attempt`, WHERE IT IS HONEST. That path really
   * does write records at a provider and wait on Amazon, which takes seconds
   * and needs saying.
   */
  const [busy, setBusy] = React.useState<"delegate" | "manual" | null>(null)

  async function begin(delegated: boolean) {
    setBusy(delegated ? "delegate" : "manual")

    const created = await createDomain({ name: candidate, delegated })
    if (!created.ok) {
      setBusy(null)
      /*
       * ⚠ A REFUSAL OF THE NAME GOES BACK TO THE NAME. Leaving the
       * person on the mode screen with a toast about the domain asked them to
       * fix something that was no longer on screen. Every other refusal — the
       * plan is full, the API is down — is not answered by editing the name,
       * and keeps the toast and the mode screen.
       */
      if (refusesTheName(created.name)) {
        setRefused({ name: candidate, reason: created.error })
        setPhase("name")
        return
      }
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
      setBusy(null)
      setPhase("manual")
      return
    }

    if (!connections.includes(slug)) {
      setBusy(null)
      setPhase("connect")
      return
    }

    await attempt(created.data, slug)
  }

  /*
   * ⚠ THE SAME SEQUENCE THE ADD FORM AND THE OAUTH CALLBACK RUN, FROM THE SAME
   * FILE. These three screens are the only ways a domain gets set up, and each
   * used to publish and check in its own words — so "added and published" here
   * and "connected and published" there could describe different amounts of
   * work having actually happened. See lib/domain-activation.ts.
   */
  async function attempt(target: Domain, slug: string) {
    setBusy(null)
    setPhase("working")

    const outcome = await activateDomain({ domainId: target.id, provider: slug })

    if (outcome.kind === "verified") {
      setDomain(outcome.domain)
      setPhase("done")
      return
    }

    /*
     * ⚠ THE RECORDS ARE IN PLACE HERE, SO THE FLOW MOVES ON AND KEEPS WATCHING
     * IN THE BACKGROUND. Amazon's check is the only thing outstanding and it
     * answers on its own schedule; holding somebody on a spinner until it does
     * would make the fastest possible setup feel like the slowest step of
     * onboarding. The success screen says which of the two states it is in and
     * corrects itself if the answer arrives while they are still reading it.
     */
    if (outcome.kind === "published") {
      if (outcome.domain) setDomain(outcome.domain)
      /*
       * ⚠ A CHECK THAT DID NOT ANSWER IS NOT THE HAPPY PATH, AND SHOWING THE
       * HAPPY SCREEN FOR IT IS HOW A 500 ON EVERY VERIFY WENT UNNOTICED. The
       * records are published either way, so the fallback screen is the right
       * one — it shows them, says they are in place, and asks nothing further.
       */
      if (!outcome.checked) {
        setFallbackReason(
          "The records are published, but the check that follows them did not " +
            "answer. Nothing here needs doing — these are what we added.",
        )
        setPhase("manual")
        return
      }
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
      outcome.kind === "conflicts"
        ? "Some records already at those names would have to be removed first, so these are yours to publish for now."
        : "We could not publish them for you, so these are yours to publish.",
    )
    setPhase("manual")
  }

  /*
   * ⚠ THE WATCH LIVES HERE RATHER THAN IN `attempt`, SO THAT LEAVING THE STEP
   * STOPS IT. `attempt` is an event handler and anything it started would
   * outlive this component — still polling, still trying to set state — after
   * somebody pressed Continue. Tied to the phase, the abort is the cleanup.
   */
  const watching = phase === "done" && domain !== null && !verified
  const watchedId = watching ? domain.id : null

  React.useEffect(() => {
    if (!watchedId) return

    const controller = new AbortController()
    void watchUntilVerified({ domainId: watchedId, signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted && result.verified) setVerified(true)
      },
    )

    return () => controller.abort()
  }, [watchedId])

  if (phase === "name") {
    return (
      <Shell
        title="What domain will you send from?"
        blurb="Mail leaves from a domain you control. We will look up who hosts its DNS and take the shortest path from there."
      >
        {/*
         * ⚠ THE SAME RULE AS /domains/new, WHICH IT DID NOT HAVE. This is the
         * first domain anybody types into the product and it accepted
         * `https://acme.com` — creating a domain that can never verify — while
         * the other box in the product refused it by name.
         */}
        <ValidatedInput
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
          check={domainProblem}
          refused={refusedHere}
          required="Enter the domain you send from."
          busy={looking}
          adornment={looking ? <Spinner className="size-3.5" /> : undefined}
          hint="The apex, like acme.com — not a URL and not an address."
          /*
           * ⚠ ENTER CONTINUES, BECAUSE THE FIELD IS NOT IN A FORM. This step
           * is a `div` with a button, so there is no implicit submit and
           * Enter did nothing at all — in a one-field screen that reads as
           * the key being broken rather than as the screen being picky.
           *
           * ⚠ AND IT OBEYS THE SAME CONDITIONS AS THE BUTTON. A name that is
           * not yet plausible, a lookup still in flight, or a name the server
           * has already refused means Enter does nothing — the same answer the
           * disabled button gives.
           */
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            if (!plausible || looking || refusedHere) return
            setPhase("mode")
          }}
        />

        {current && !refusedHere && (
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
          disabled={!plausible || looking || refusedHere !== undefined}
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
            busy={busy === "delegate"}
            disabled={busy !== null}
          />
        )}
        <Choice
          icon={<Pencil className="size-4" />}
          title="Keep the records in my zone"
          description="Six ordinary records that stay yours to maintain. Nothing is delegated."
          onSelect={() => void begin(false)}
          busy={busy === "manual"}
          disabled={busy !== null}
        />
      </Shell>
    )
  }

  if (phase === "working") {
    return (
      /*
       * ⚠ IT NO LONGER GUESSES BETWEEN TWO SENTENCES. This phase is entered
       * from exactly one place — `attempt`, which is publishing at a
       * connected provider — so "Publishing" is always the true one. The
       * `Adding …` branch it used to fall back to was the copy that showed
       * during the flash this screen no longer has.
       */
      <Shell title="Setting it up…" blurb="This takes a few seconds.">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Publishing records for {domain?.name ?? candidate}
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
        {/*
         * ⚠ IT NAMES WHERE TO COME BACK TO, AND WITHOUT THAT THIS STEP WAS A
         * DEAD END. Connecting is a full navigation to the provider and back
         * through `/dns/callback/…`, which lives in the console shell — so
         * somebody who pressed this landed on a page that knew nothing about
         * the flow they were half-way through. The connection was made and the
         * onboarding was simply gone, which read as the button not working.
         */}
        <ConnectProviderButton
          slug={provider.slug}
          providerName={provider.name}
          returnTo="/onboarding"
          size="xl"
          block
          brand
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
        title={
          verified ? `${domain.name} is ready to send` : `${domain.name} is set up`
        }
        blurb={
          verified
            ? `The records are live at ${provider?.name ?? "your provider"} and the domain is verified. Nothing else to do.`
            : `We published the records at ${provider?.name ?? "your provider"} and proved the domain is yours. We are waiting on Amazon's own check now — it usually lands within a few minutes, and nothing here needs you.`
        }
      >
        {/*
         * ⚠ CONTINUE IS AVAILABLE EITHER WAY, AND THAT IS THE POINT OF DOING
         * THE WAIT IN THE BACKGROUND. Nothing about the rest of onboarding
         * depends on Amazon having answered, so a button disabled until it has
         * would be holding somebody at the one step that is already finished.
         */}
        <Button onClick={onDone}>
          {verified ? <Check /> : <Spinner className="size-4" />}
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
/**
 * ⚠ THE CARD CARRIES ITS OWN PRESS, WHICH IS WHAT REMOVED THE JUMP. The flow
 * used to answer a press by replacing the whole question with a spinner
 * screen, so the feedback for pressing a card appeared several hundred
 * pixels away from the card. Swapping this card's own icon for a spinner
 * says the same thing without moving anything.
 *
 * ⚠ AND BOTH CARDS GO INERT WHILE EITHER IS WORKING. Only one domain is
 * being created; a second press on the other card would create a second.
 */
function Choice({
  icon,
  title,
  description,
  recommended,
  onSelect,
  busy = false,
  disabled = false,
}: {
  icon: React.ReactNode
  title: string
  description: string
  recommended?: boolean
  onSelect: () => void
  busy?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled || busy}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border p-4 text-left",
        "transition-colors duration-(--duration-instant) ease-(--ease-linear)",
        "hover:border-foreground/40 hover:bg-muted/40",
        "disabled:cursor-default disabled:hover:border-border disabled:hover:bg-transparent",
        disabled && !busy && "opacity-50",
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">
        {busy ? <Spinner className="size-4" /> : icon}
      </span>
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
