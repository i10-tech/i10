"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react"
import {
  Check,
  ChevronDown,
  CircleCheck,
  Globe,
  ListChecks,
  Network,
} from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { Reveal } from "@repo/ui/components/reveal"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { DetectionPanel } from "@/components/detection-panel"
import { EmailPreview } from "@/components/email-preview"
import { StepItem, StepRail } from "@/components/steps"
import { DnsRecordGroups } from "@/components/dns-records"
import { ProviderMark } from "@/components/provider-mark"
import {
  checkDomain,
  createDomain,
  dnsConnections,
  lookupDns,
  startDnsConnect,
  verifyDomain,
} from "@/lib/actions"
import { activateDomain } from "@/lib/domain-activation"
import { domainProblem, isDomainMalformed, refusesTheName } from "@/lib/domain-check"
import { toastDone, toastError, toastFailure, toastPending } from "@/lib/toast"
import {
  draftStillSet,
  rememberDraft,
  type AddDomainDraft,
  type DraftScope,
} from "@/lib/add-domain-draft"
import type { DnsConnection, DnsInspection, Domain } from "@/lib/types"

/**
 * Adding a domain, as steps (2026-10-03): the name, then how the records
 * should exist and get there, then - only for somebody adding them by hand -
 * the records themselves. Each answered step folds into a card above the next,
 * and the email preview beside the first shows what the name will look like in
 * an inbox while it is typed.
 *
 * ⚠ THE DOMAIN IS CREATED AT THE SECOND STEP, NOT THE FIRST. Whether it is
 * delegated is decided there and the API takes it at creation only; creating
 * on the first step would mean guessing it. Until then the first step can be
 * changed freely; after it, the row exists and the flow only moves forward.
 *
 * ⚠ THE DNS LOOKUP HAPPENS *BEFORE* THE DOMAIN IS CREATED, WHICH IS WHY IT
 * TAKES A NAME RATHER THAN AN ID. The whole value of it is telling somebody who
 * hosts their DNS while they are still deciding how to set this up - asking
 * them to create a row first, find out we cannot help, and then delete it is a
 * worse flow than not detecting anything at all.
 *
 * ⚠ AND DELEGATION IS THE DEFAULT, NOT THE FALLBACK. Twenty-two of the forty
 * providers in the registry have no usable per-customer API, and the two
 * largest registrars gate theirs behind spend thresholds - so "connect your
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
 * reach the zone. They are independent - a delegating customer can still paste
 * six NS records by hand, and a customer keeping their own records can still
 * have us write them - so offering "delegate" against "publish the records
 * myself" made one of the four combinations unreachable and implied the other
 * three were one decision.
 */

type Mode = "delegate" | "manual"

type Step = "domain" | "records" | "publish"

/**
 * Where a reload left off - see lib/add-domain-draft.ts. The page reads the
 * cookie, re-reads the created domain and re-runs the lookup on the server, so
 * the first paint is already the step they were on.
 */
export interface RestoredDraft extends AddDomainDraft {
  created: Domain | null
  inspection: DnsInspection | null
}

/**
 * Where the domain steps send somebody once they are finished with them.
 *
 * ⚠ THE ONLY THINGS THAT DIFFER BETWEEN /domains/new AND SET-UP. Everything
 * else - the lookup, the refusals, creating the row, connecting and publishing,
 * the records - is this one component, so the two cannot do it differently.
 */
export interface AddDomainExits {
  /** Where the provider's sign-in comes back to, for the domain just made. */
  returnTo: (domainId: string) => string
  /** The domain is made and its records are published or in their hands. */
  onFinish: (domain: Domain) => void
  /** Leaving from the first step; absent, there is no Cancel. */
  onCancel?: () => void
}

/**
 * The domain steps as rail items, for whichever rail they sit in.
 *
 * ⚠ IT RENDERS `StepItem`s AND NOTHING AROUND THEM. /domains/new puts them in
 * a rail of their own beside the inbox preview; set-up puts them between its
 * workspace step and its verify step, in its rail. `onPreview` tells the
 * owner what the preview should show, since the owner draws it.
 */
export function AddDomainSteps({
  tenantId,
  restored: handed = null,
  draft = "page",
  phase = "active",
  trailing = false,
  icons = false,
  exits,
  onPreview,
  onOpen,
}: {
  tenantId: string
  restored?: RestoredDraft | null
  /** Which cookie remembers the answers across a reload - see lib/add-domain-draft. */
  draft?: DraftScope
  /**
   * Where these steps sit in the owner's flow (set-up): before the step the
   * person is on (all upcoming), on it, or past it (all answered).
   *
   * ⚠ THE STEPS STAY MOUNTED IN EVERY PHASE, AND THAT IS THE POINT
   * (2026-10-04). Set-up used to render them only while its domain step was
   * current, so going back to name the workspace threw away everything here -
   * the typed name, the choice, the records step - while the domain itself had
   * already been made, and re-adding it was refused as a duplicate. Mounted
   * throughout, only how they are drawn changes.
   */
  phase?: "before" | "active" | "after"
  /** More steps follow on the rail, so none of these is the last. */
  trailing?: boolean
  /** Give each step a glyph, as set-up's rail does. */
  icons?: boolean
  exits: AddDomainExits
  onPreview?: (preview: { name: string; naming: boolean }) => void
  /** One of these steps asked to be open - set-up makes its domain step current. */
  onOpen?: () => void
}) {
  /*
   * ⚠ A DRAFT IS ONLY USED IF ITS COOKIE STILL EXISTS. On a reload the server
   * has just read it, so this is always true while hydrating and the two
   * renders agree. On a back/forward replay of a cached render it can be gone
   * - leaving forgot it - and that render must start fresh, not resume.
   */
  const [restored] = React.useState(() =>
    handed && typeof document !== "undefined" && !draftStillSet(draft) ? null : handed,
  )
  const router = useRouter()
  const reduce = useReducedMotion() ?? false

  const [step, setStep] = React.useState<Step>(restored?.step ?? "domain")
  /** The row, once the second step has made it. The flow cannot go back after. */
  const [created, setCreated] = React.useState<Domain | null>(restored?.created ?? null)
  const [checking, setChecking] = React.useState(false)

  const [name, setName] = React.useState(restored?.name ?? "")
  const [chosenMode, setChosenMode] = React.useState<Mode>(restored?.mode ?? "delegate")
  /*
   * ⚠ FETCHED ONCE AND ALLOWED TO FAIL. Whether this workspace has already
   * connected the provider changes only what the automatic option SAYS, never
   * whether it is offered - so a failed request leaves somebody able to pick it
   * and connect on the next screen, rather than blocking the form on a fact it
   * does not need.
   */
  const [connections, setConnections] = React.useState<DnsConnection[]>([])
  const [returnPath, setReturnPath] = React.useState(restored?.returnPath ?? "")
  /*
   * ⚠ THE ANSWER IS STORED WITH THE QUESTION IT ANSWERS, AND THAT IS THE WHOLE
   * REASON THIS IS A PAIR RATHER THAN A `DnsInspection | null`. "Which domain
   * have we finished looking up" and "what did we find" are different facts, and
   * a failed lookup has the first without the second. Collapsing them meant a
   * failure was indistinguishable from "still waiting", so the spinner spun for
   * ever on any domain whose lookup errored - and the submit guard below, which
   * waits for the lookup, would have made that a form that can never be
   * submitted.
   */
  const [answered, setAnswered] = React.useState<{
    domain: string
    inspection: DnsInspection | null
    /**
     * Why the API would refuse this name - ours, or already in this
     * workspace - asked in the same debounce as the lookup, so the
     * box goes red once they stop typing rather than once they press Add.
     */
    refusal: string | null
  } | null>(
    // ⚠ THE SERVER'S LOOKUP FOR A RESTORED NAME, so the second step does not
    // render without its provider and then grow one when the client's lands.
    restored && restored.name
      ? {
          domain: restored.name.trim().toLowerCase(),
          inspection: restored.inspection,
          refusal: null,
        }
      : null,
  )
  const [submitting, setSubmitting] = React.useState(false)
  /**
   * A name the server refused, and what it said.
   *
   * ⚠ A REFUSAL ABOUT THE VALUE BELONGS NEXT TO THE VALUE, NOT IN A CORNER. The
   * server owns rules this form cannot check - `i10.tech` is ours, and only the
   * API knows what `MAIL_DOMAINS` holds - so those verdicts arrive after a round
   * trip. Sending them to a toast put the sentence describing what is wrong with
   * the box a long way from the box, on a timer, while the offending value sat
   * there looking accepted.
   *
   * ⚠ MOST OF THESE ARE CAUGHT AS THEY ARE TYPED NOW - see `answered.refusal`.
   * This is the backstop for the race that check cannot close: a name taken
   * between the check and the press.
   *
   * ⚠ IT IS KEYED BY THE NAME IT WAS ABOUT, WHICH IS WHAT MAKES IT CLEAR ITSELF.
   * `refusedHere` below only answers while the box still holds that name, so the
   * field forgets it the moment the value changes and remembers it if they type
   * the same thing again. The onboarding step uses the same `refused` prop on
   * the same field, so the two surfaces cannot drift apart on this.
   */
  const [refused, setRefused] = React.useState<{ name: string; reason: string } | null>(
    null,
  )
  const [advanced, setAdvanced] = React.useState(restored?.advanced ?? false)

  /*
   * ⚠ THE SAME RULES THE SIGN-IN PAGE'S EMAIL BOX FOLLOWS, FROM THE SAME HOOK.
   * Red only once somebody has stopped typing, green only where a value was
   * shown wrong and has since been fixed. The alternative was a second set of
   * rules on the one field in the console people get wrong most often - and a
   * form that reddens `acme.` on the third keystroke of `acme.com` is a form
   * whose red means nothing by the time it is right.
   */

  const candidate = name.trim().toLowerCase()

  // ⚠ COMPARED ON THE NORMALISED NAME, so `I10.tech ` is still the refused
  // `i10.tech` - the field would otherwise go quiet over a capital letter.
  const refusedLate =
    refused && candidate === refused.name.toLowerCase() ? refused.reason : undefined

  /*
   * ⚠ THE LOOKUP GATE AND THE BORDER COLOUR ASK THE SAME FUNCTION, AND THEY
   * USED NOT TO. This line was its own regex, and it was looser than the
   * verdict in ways that showed: `acme.c` passed it, so the form spent a
   * nameserver lookup on a name the field was about to call malformed, and then
   * reported what it found - "DNS hosted by Cloudflare" under a domain that
   * does not exist. Two definitions of "is this a domain" in one component is
   * one more than there can be.
   */
  const plausible = candidate !== "" && !isDomainMalformed(candidate)

  /*
   * ⚠ DERIVED, NOT STATE. "Are we looking one up" is entirely a function of what
   * has been typed and what has been answered - a `looking` flag set inside the
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
   * answer for "acme.com" and overwrite it - so the screen shows the provider
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
    // Not yet a plausible apex. Nothing to look up, and nothing to clear -
    // `looking` is derived and `inspection` is compared against the current
    // candidate wherever it is read.
    if (!plausible) return

    const token = ++request.current

    const timer = setTimeout(async () => {
      const [result, check] = await Promise.all([
        lookupDns(candidate),
        checkDomain(candidate),
      ])
      // ⚠ A STALE ANSWER IS DROPPED. The response for "acme.c" can land after
      // the response for "acme.com" and would otherwise overwrite it - showing
      // the provider for a domain that was never submitted.
      if (token !== request.current) return
      // ⚠ A FAILURE IS RECORDED AS AN ANSWER, NOT AS AN ABSENCE. Detection is a
      // convenience; a resolver that times out must leave somebody able to add
      // their domain, which means the form has to know the attempt is over.
      // A failed check is "no objection" for the same reason: create decides.
      setAnswered({
        domain: candidate,
        inspection: result.ok ? result.data : null,
        refusal: check.ok ? check.data.refusal : null,
      })
    }, 500)

    return () => clearTimeout(timer)
  }, [candidate, plausible])

  // ⚠ ONLY TRUSTED WHEN IT IS THE ANSWER FOR WHAT IS CURRENTLY TYPED. Holding
  // the last successful inspection while somebody edits the field would leave
  // the previous domain's provider on screen next to the new name.
  const answeredHere = answered?.domain === candidate ? answered : null
  const refusedHere = answeredHere?.refusal ?? refusedLate
  /*
   * ⚠ A REFUSED NAME SHOWS NO DETECTION PANEL. "DNS hosted by Cloudflare"
   * under `i10.tech is ours` is an answer to a question nobody can go on to
   * ask, and it would offer to connect a provider for a domain we refuse.
   */
  const current = answeredHere && !refusedHere ? answeredHere.inspection : null
  const provider = current?.provider ?? null

  // ⚠ DELEGATION IS DISABLED, NOT HIDDEN, WHERE THE PROVIDER'S EDITOR HAS NO NS
  // ROW. Hiding it would leave somebody wondering why the recommended option
  // vanished; disabling it with the reason attached answers the question before
  // it is asked. Shopify and Wix are the live examples.
  const delegationBlocked = provider !== null && !provider.nsDelegation

  /*
   * ⚠ DERIVED RATHER THAN CORRECTED. Forcing the stored choice back to `manual`
   * in an effect would overwrite what the person picked - so if they then typed
   * a different domain whose provider DOES support NS records, their original
   * preference would be gone. Keeping the choice and resolving it at the point
   * of use means the form remembers what they asked for.
   */
  const mode: Mode = delegationBlocked ? "manual" : chosenMode

  /*
   * ⚠ AUTOMATIC IS ONLY REAL WHERE WE HOLD AN ADAPTER FOR THE PROVIDER.
   * Twenty-two of the forty providers in the registry have no usable
   * per-customer API, so for most domains this axis has one answer - and
   * resolving it here rather than correcting the stored choice means somebody
   * who types a Cloudflare domain, then a Namecheap one, then goes back still
   * has the preference they picked.
   */
  const canAutomate = provider?.canConnect === true
  const connected =
    provider !== null && connections.some((c) => c.provider === provider.slug)

  /*
   * ⚠ EVERY ANSWER IS WRITTEN AS IT CHANGES, SO A RELOAD AT ANY MOMENT COMES
   * BACK TO IT. An effect that writes a cookie and sets no state - the reverse
   * direction, reading it, happens on the server. See lib/add-domain-draft.ts.
   *
   * ⚠ AND `left` STOPS IT REWRITING WHAT AN EXIT HAS JUST CLEARED. Leaving
   * forgets the draft and then navigates; without this the next render on the
   * way out would put it straight back, and the next visit to /domains/new
   * would open on a domain that already exists.
   */
  const left = React.useRef(false)
  React.useEffect(() => {
    if (left.current) return
    rememberDraft(
      tenantId,
      {
        name,
        returnPath,
        mode: chosenMode,
        advanced,
        step,
        ...(created ? { id: created.id } : {}),
      },
      draft,
    )
  }, [tenantId, name, returnPath, chosenMode, advanced, step, created, draft])

  function forget() {
    left.current = true
    rememberDraft(tenantId, null, draft)
  }

  function finish(domain: Domain) {
    forget()
    exits.onFinish(domain)
  }

  /** Step one's Continue: nothing is created, the answer is just held. */
  function confirmName(event: React.FormEvent) {
    event.preventDefault()
    if (looking || refusedHere !== undefined || candidate === "") return
    setStep("records")
  }

  /**
   * Makes the row. Every way out of the second step starts here.
   *
   * ⚠ A REFUSAL OF THE NAME SENDS THEM BACK TO THE NAME, with the reason under
   * the box - ours (422), or already held here or elsewhere (409). The rest -
   * the plan is full, the API is down - are not answered by looking at the box
   * again, which is why they keep the toast and the plan limit keeps its button.
   */
  async function create(): Promise<Domain | null> {
    const result = await createDomain({
      name: candidate,
      delegated: mode === "delegate",
      ...(returnPath.trim() ? { custom_return_path: returnPath.trim() } : {}),
    })
    if (result.ok) return result.data

    if (refusesTheName(result.name)) {
      setRefused({ name: candidate, reason: result.error })
      setStep("domain")
      return null
    }
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
    return null
  }

  /**
   * "Connect {provider}". Connected: publish and check now, then the domain page.
   * Not yet: create the row, then connect - the callback publishes every
   * unverified domain and comes back to `returnTo`, so it lands on this one's
   * page with the records already written. See dns/callback.
   *
   * ⚠ STILL SUBMITTING ON EVERY PATH THAT LEAVES. A button that un-spins while
   * the publish it started is still running invites the second press that
   * creates a second domain; only failures come back to a live form.
   */
  async function autoConfigure() {
    if (submitting || !provider) return
    setSubmitting(true)
    const domain = await create()
    if (!domain) return setSubmitting(false)

    if (!connected) {
      const start = await startDnsConnect(provider.slug, exits.returnTo(domain.id))
      if (!start.ok) {
        // The row exists; where it is finished offers the same button.
        toastError(`Could not connect ${provider.name}`, start.error)
        finish(domain)
        return
      }
      forget()
      window.location.assign(start.data.url)
      return
    }

    /*
     * ⚠ THE SHARED SEQUENCE, NOT THIS FORM'S OWN. Publishing and then checking
     * is the same job the onboarding flow and the OAuth callback do. See
     * lib/domain-activation.ts.
     */
    const outcome = await activateDomain({
      domainId: domain.id,
      provider: provider.slug,
    })
    switch (outcome.kind) {
      case "verified":
        toastDone(
          `${domain.name} is verified`,
          "The records are published and this domain can send now.",
        )
        break
      case "published":
        if (outcome.checked)
          toastDone(
            `${domain.name} added and published`,
            outcome.written === 0
              ? `Every record was already in place at ${provider.name}. We are checking now - nothing else is needed from you.`
              : `${outcome.written} records written to ${provider.name}. We are checking now - nothing else is needed from you.`,
          )
        else
          toastPending(
            `${domain.name} added and published`,
            `The records are in place at ${provider.name}, but the check that follows them did not answer. Open the domain and press Verify.`,
          )
        break
      case "conflicts":
        toastPending(
          `${domain.name} added`,
          "Some existing records are in the way. Review them to finish.",
        )
        break
      default:
        toastPending(
          `${domain.name} added`,
          `We could not publish the records: ${outcome.reason}`,
        )
    }
    finish(domain)
  }

  /** "Manual setup": make the row and show its records here, as a third step. */
  /**
   * "Manual setup": straight to the records step, then make the row behind it.
   *
   * ⚠ THE STEP MOVES FIRST AND THE ROW CATCHES UP (2026-10-03). Creating a
   * domain is almost never refused here - the name was checked as it was typed
   * - so the person is not made to watch a spinner for it. The records step
   * opens with placeholder rows that fill in when the row exists; a refusal
   * puts them back on the choice, or on the name if it was the name.
   */
  async function manualSetup() {
    if (submitting) return
    setSubmitting(true)
    setStep("publish")
    const domain = await create()
    setSubmitting(false)
    if (!domain) {
      setStep((now) => (now === "publish" ? "records" : now))
      return
    }
    setCreated(domain)
  }

  /**
   * "I've added the records": one check now, then the domain page, which
   * keeps looking by itself - see DomainLiveProvider. The check's verdict is
   * the page's to show, so it is not toasted here.
   */
  async function addedThem() {
    if (!created || checking) return
    setChecking(true)
    await verifyDomain(created.id)
    finish(created)
  }

  const order: Step[] =
    created || step === "publish"
      ? ["domain", "records", "publish"]
      : ["domain", "records"]
  const at = order.indexOf(step)
  /*
   * ⚠ PAST, BUT NOT FINISHED, IS "SKIPPED". When the owner's flow has moved on
   * from these steps, the ones never reached in here are drawn answered - in
   * amber, saying so - rather than green.
   */
  const unreached = (s: Step) => phase === "after" && order.indexOf(s) >= at
  const stateOf = (s: Step) => {
    if (phase === "before") return "next"
    if (phase === "after") return "done"
    const i = order.indexOf(s)
    return i < at ? "done" : i === at ? "current" : "next"
  }
  const busy = submitting || checking

  // The owner draws the preview; tell it what to show.
  React.useEffect(() => {
    onPreview?.({ name: candidate, naming: step === "domain" })
  }, [onPreview, candidate, step])

  return (
    <>
      {/* ── 1. Domain ── */}
      <StepItem
        state={stateOf("domain")}
        last={false}
        title="Domain"
        tone={unreached("domain") ? "warning" : "success"}
        badge={unreached("domain") ? "Skipped" : undefined}
        icon={icons ? <Globe /> : undefined}
        description="The domain you send from, and the subdomain bounces return to."
        reduce={reduce}
        summary={
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-emerald-500/20 bg-background/40 px-3 py-2 font-mono text-sm">
              <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{candidate}</span>
              {returnPath.trim() && (
                <span className="truncate text-xs text-muted-foreground">
                  return path {returnPath.trim()}
                </span>
              )}
            </span>
            {/* Before the row exists the name can still change. */}
            {!created && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setStep("domain")
                  // Opening a step here opens these steps in the owner's flow.
                  onOpen?.()
                }}
              >
                Change
              </Button>
            )}
          </div>
        }
      >
        {/*
         * ⚠ `noValidate`, BECAUSE THE BROWSER'S OWN BUBBLE IS NOT OUR
         * INTERFACE. The field refuses its own form's submit itself - see
         * @repo/ui/components/validated-field.
         */}
        <form onSubmit={confirmName} className="space-y-5" noValidate>
          {/*
           * ⚠ THE FIELD GOES AMBER WHILE THE NAMESERVER LOOKUP IS IN FLIGHT,
           * which is the same fact the disabled Continue is acting on.
           */}
          <ValidatedInput
            id="domain"
            autoFocus
            label="Domain"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            // ⚠ `url` WOULD BE WRONG HERE: browsers autofill whole URLs, and
            // `https://acme.com` creates a domain that can never verify.
            inputMode="url"
            className="font-mono"
            check={domainProblem}
            refused={refusedHere}
            required="Enter the domain you send from."
            busy={looking}
            adornment={looking ? <Spinner className="size-3.5" /> : undefined}
            hint={
              <>
                The apex, or a subdomain you send from - a subdomain like{" "}
                <code className="font-mono">mail.example.com</code> keeps your sending
                reputation separate.
              </>
            }
          />

          {/*
           * ⚠ A BUTTON AND A `Reveal`, NOT `Collapsible`. Radix's collapsible
           * toggles `data-state` and expects a stylesheet to carry the
           * height, so it snapped; this springs with everything around it.
           */}
          <div>
            <button
              type="button"
              onClick={() => setAdvanced((open) => !open)}
              aria-expanded={advanced}
              className="flex cursor-pointer items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-(--duration-spring) ease-(--ease-spring)",
                  !advanced && "-rotate-90",
                )}
              />
              Advanced options
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
                    The envelope address every message uses, whichever way it leaves.
                    Defaults to <code className="font-mono">send</code>. Changing it
                    later means re-publishing records.
                  </>
                }
              />
            </Reveal>
          </div>

          <div className="flex items-center gap-2">
            {/*
             * ⚠ DISABLED WHILE THE LOOKUP IS IN FLIGHT, BECAUSE THE NEXT STEP
             * IS BUILT FROM IT: whether delegation is possible and whether we
             * can write the records both come from the detected provider.
             * The wait is bounded - a failed lookup still answers.
             */}
            <Button
              type="submit"
              className="rounded-full"
              disabled={looking || refusedHere !== undefined || candidate === ""}
            >
              Continue
            </Button>
            {exits.onCancel && (
              <Button
                type="button"
                variant="ghost"
                className="rounded-full"
                onClick={() => {
                  forget()
                  exits.onCancel?.()
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </StepItem>

      {/* ── 2. Records ── */}
      <StepItem
        state={stateOf("records")}
        last={order.length === 2 && !trailing}
        title="DNS Records"
        tone={unreached("records") ? "warning" : "success"}
        badge={unreached("records") ? "Skipped" : undefined}
        icon={icons ? <Network /> : undefined}
        description={
          canAutomate && connected
            ? `Choose which records should exist. ${provider?.name} is already connected, so we can publish them for you - or add them yourself.`
            : canAutomate
              ? `Choose which records should exist. Sign in to ${provider?.name} and we write them for you, or add them yourself.`
              : "Choose which records should exist, then add them at your DNS provider."
        }
        reduce={reduce}
        summary={
          <p className="text-sm text-muted-foreground">
            {/* ⚠ A STEP NEVER ANSWERED SAYS SO, rather than reporting the default
                choice as if somebody had made it. */}
            {unreached("records")
              ? "Not chosen yet."
              : `${mode === "delegate" ? "Delegated to i10" : "Records kept in your zone"} - added by hand.`}
          </p>
        }
      >
        <div className="space-y-5">
          {/* What we found about where its DNS lives. */}
          {current && <DetectionPanel inspection={current} connected={connected} />}

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              Which records should exist?
            </legend>
            <ModeCard
              selected={mode === "delegate"}
              disabled={delegationBlocked}
              onSelect={() => setChosenMode("delegate")}
              icon={<Network className="size-4" />}
              title="Delegate to i10"
              recommended
              description={
                delegationBlocked
                  ? `${provider?.name ?? "This provider"}'s DNS editor does not offer NS records, so delegation is not possible there.`
                  : "Delegate three names to us once. We serve the mail subdomains ourselves, so SPF, DKIM, DMARC and MX stay correct forever - including when they change."
              }
            />
            <ModeCard
              selected={mode === "manual"}
              onSelect={() => setChosenMode("manual")}
              icon={<Check className="size-4" />}
              title="Keep the records in my zone"
              description="Four ordinary records - the return path's MX and SPF, DKIM and DMARC. Nothing is delegated, and they stay yours to maintain."
            />
          </fieldset>

          <div className="flex flex-wrap items-center gap-2">
            {/*
             * ⚠ ONLY WHERE WE CAN WRITE THE RECORDS. Twenty-two of the forty
             * providers have no usable per-customer API; for those, adding
             * them by hand is the only path and it is the primary button.
             */}
            {canAutomate && provider && (
              <Button
                type="button"
                className="rounded-full border-neutral-200 bg-white text-neutral-950 hover:bg-neutral-100 dark:border-neutral-200 dark:bg-white dark:hover:bg-neutral-100"
                disabled={busy}
                onClick={() => void autoConfigure()}
              >
                {submitting ? (
                  <Spinner />
                ) : (
                  <ProviderMark slug={provider.slug} name={provider.name} />
                )}
                {/*
                 * ⚠ "CONNECT" UNTIL IT IS CONNECTED, THEN "PUBLISH RECORDS"
                 * (2026-10-03). The step offers two things - our way or by
                 * hand - and once the workspace holds a connection, this
                 * press writes the records now, so the word says so. The
                 * panel above says the provider is already connected.
                 */}
                {connected ? "Publish records" : `Connect ${provider.name}`}
              </Button>
            )}
            <Button
              type="button"
              variant={canAutomate ? "outline" : "default"}
              className="rounded-full"
              disabled={busy}
              onClick={() => void manualSetup()}
            >
              {submitting && !canAutomate && <Spinner />}
              Manual setup
            </Button>
          </div>
        </div>
      </StepItem>

      {/* ── 3. Publish, only for somebody adding them by hand ── */}
      {order.length === 3 && (
        <StepItem
          state={stateOf("publish")}
          last={!trailing}
          title="Fill in your DNS records"
          tone={unreached("publish") ? "warning" : "success"}
          badge={unreached("publish") ? "Skipped" : undefined}
          icon={icons ? <ListChecks /> : undefined}
          description={`Add these at ${provider?.name ?? "your DNS provider"}. When they are in, tell us and we start looking for them.`}
          reduce={reduce}
        >
          <div className="space-y-6">
            {/* Exactly as the domain page lays them out, status column and all. */}
            {created ? (
              <DnsRecordGroups records={created.records} />
            ) : (
              <RecordsPlaceholder />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {/*
               * ⚠ ONLY THIS BUTTON (2026-10-03). This step exists because
               * they chose Manual setup over connecting; offering the
               * provider again here, beside it, asks a question they have
               * just answered.
               */}
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                disabled={checking || !created}
                onClick={() => void addedThem()}
              >
                {checking ? <Spinner /> : <CircleCheck />}
                I&rsquo;ve added the records
              </Button>
            </div>
          </div>
        </StepItem>
      )}
    </>
  )
}

/**
 * /domains/new: the domain steps in a rail of their own, with the inbox
 * preview beside the first.
 */
export function AddDomainForm({
  tenantId,
  restored = null,
}: {
  tenantId: string
  restored?: RestoredDraft | null
}) {
  const router = useRouter()
  const reduce = useReducedMotion() ?? false
  const [preview, setPreview] = React.useState({
    name: restored?.name ?? "",
    naming: (restored?.step ?? "domain") === "domain",
  })
  const exits = React.useMemo<AddDomainExits>(
    () => ({
      returnTo: (id) => `/domains/${id}`,
      onFinish: (domain) => router.push(`/domains/${domain.id}`),
      onCancel: () => router.back(),
    }),
    [router],
  )

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <LayoutGroup>
        <StepRail follow className={cn(!preview.naming && "lg:col-span-2")}>
          <AddDomainSteps
            tenantId={tenantId}
            restored={restored}
            exits={exits}
            onPreview={setPreview}
          />
        </StepRail>
      </LayoutGroup>

      {/*
       * ⚠ ONLY BESIDE THE FIRST STEP, AS RESEND DOES. It answers "what will this
       * look like" while the name is being chosen; after that the records want
       * the whole width, and a preview of a name already decided is decoration.
       */}
      <AnimatePresence initial={false}>
        {preview.naming && (
          <motion.aside
            key="preview"
            aria-hidden
            className="hidden lg:block"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          >
            <EmailPreview domain={preview.name.trim().toLowerCase()} />
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * The records step's rows before the row exists - same shape as the real
 * groups, so filling in is a fade and not a jump.
 */
function RecordsPlaceholder() {
  return (
    <div aria-hidden className="space-y-6 py-2">
      {[2, 1].map((rows, group) => (
        <div key={group} className="space-y-3">
          <div className="h-4 w-36 animate-pulse rounded-full bg-muted" />
          <div className="h-9 rounded-xl bg-muted/50" />
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/30" />
          ))}
        </div>
      ))}
    </div>
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
       * moment the card contains its own interactive element - which this one
       * will, as soon as "Connect" moves inside it. A toggle button announces
       * its state correctly and has no such constraint.
       */
      aria-pressed={selected}
      className={cn(
        "group relative flex w-full cursor-pointer items-start gap-3 overflow-hidden rounded-2xl border p-4 text-left transition-[background-color,border-color,box-shadow] duration-300",
        /*
         * ⚠ THE RECOMMENDED CARD IS THE SHINY ONE, ON PURPOSE (2026-10-03).
         * Delegating is the setup we want people on - records that cannot drift
         * - so it carries a quiet green-to-blue wash and a light across its top
         * edge whether or not it is picked; picked, the wash deepens.
         */
        recommended && !disabled
          ? selected
            ? "border-emerald-500/50 bg-linear-to-br from-emerald-500/16 via-sky-500/8 to-violet-500/10 shadow-[0_0_0_1px_rgb(16_185_129/0.15),0_12px_32px_-16px_rgb(16_185_129/0.45)]"
            : "border-emerald-500/25 bg-linear-to-br from-emerald-500/8 via-sky-500/4 to-violet-500/6 hover:border-emerald-500/40"
          : selected
            ? "border-foreground/40 bg-muted/40"
            : "hover:bg-muted/30",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {recommended && !disabled && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-emerald-300/70 to-transparent"
        />
      )}
      <span
        className={cn(
          "mt-0.5 shrink-0",
          recommended && !disabled
            ? "text-emerald-500"
            : selected
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {recommended && !disabled && (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-2xs font-medium text-emerald-700 dark:text-emerald-300">
              Recommended
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  )
}
