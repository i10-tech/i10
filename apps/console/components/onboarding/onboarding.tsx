"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { LayoutGroup, motion, useReducedMotion } from "motion/react"
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  CreditCard,
  Globe,
  Plus,
  Send,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import {
  AddDomainSteps,
  type AddDomainExits,
  type RestoredDraft,
} from "@/components/add-domain-form"
import {
  DomainLiveProvider,
  LiveDomainJourney,
  useLiveDomain,
} from "@/components/domain-live"
import { SendFirstEmail } from "@/components/onboarding/send-first-email"
import { Stage, type StageScene } from "@/components/onboarding/stage"
import { StepPlan } from "@/components/onboarding/step-plan"
import { Status } from "@/components/status"
import { EASE, StepItem, StepRail } from "@/components/steps"
import { acceptTransfer, renameWorkspace, updateOnboarding } from "@/lib/actions"
import { onPaidPlan } from "@/lib/billing"
import { ARRIVAL, clearArrival } from "@/lib/arrival"
import { rememberDraft } from "@/lib/add-domain-draft"
import { rememberStep } from "@/lib/onboarding-step"
import { toastDone, toastError } from "@/lib/toast"
import type {
  BillingState,
  Domain,
  DomainSummary,
  OnboardingState,
  PlanSummary,
  TransferOffer,
} from "@/lib/types"

/**
 * Set-up, as one screen (2026-10-03): the steps down the left on the same rail
 * /domains/new walks, and on the right a picture of what each step changes,
 * drawn live from what is being typed and checked.
 *
 * ⚠ THE DOMAIN STEP IS /domains/new's OWN STEPS, NOT A COPY. `AddDomainSteps`
 * contributes its items to this rail; the verify step is the domain page's own
 * live events strip. Adding or verifying a domain here and there cannot behave
 * differently, because it is the same code.
 *
 * ⚠ THE STEP LIVES IN LOCAL STATE AND IS *MIRRORED* TO THE SERVER, NOT DRIVEN
 * BY IT. Driving it from the server would make every "Continue" a round trip
 * with nothing on screen, on the one flow where hesitation costs a signup. The
 * write is fire-and-forget so that coming back tomorrow resumes where they
 * were; if it fails, the worst outcome is starting a step earlier.
 *
 * ⚠ AND THE FLOW NEVER BLOCKS ON A STEP BEING "COMPLETE". Somebody can walk
 * past the domain step without adding one - they may be evaluating, or waiting
 * on whoever controls DNS. "Skip this step" is always there.
 */
const STEPS = [
  { id: "workspace", label: "Workspace" },
  { id: "domain", label: "Domain" },
  { id: "verify", label: "Verify" },
  { id: "send", label: "Send" },
  { id: "plan", label: "Plan" },
] as const

type StepId = (typeof STEPS)[number]["id"]

export function Onboarding({
  state,
  workspaceName,
  tenantId,
  domains,
  focus = null,
  offers = [],
  userEmail = null,
  plans,
  billing,
  checkoutId,
  resumeStep,
  justPublished,
  domainDraft = null,
}: {
  state: OnboardingState
  workspaceName: string
  /** Keys the remembered step, so it never crosses workspaces. */
  tenantId: string
  domains: DomainSummary[]
  /**
   * The domain the verify and send steps are about, read in full - the most
   * recent one still being verified, or else a verified one.
   */
  focus?: Domain | null
  /** Domains offered to this person by email, shown on the domain step. */
  offers?: TransferOffer[]
  /** The signed-in person's address - the test email goes to them. */
  userEmail?: string | null
  plans: PlanSummary[]
  billing: BillingState
  /** From the checkout cookie (see lib/arrival.ts), for the plan step's outcome banner. */
  checkoutId: string | null
  /**
   * The step this browser was last on, from its cookie - it outranks the
   * facts. See lib/onboarding-step.ts.
   *
   * ⚠ IT EXISTS BECAUSE PAYING THREW PEOPLE BACKWARDS. Returning from Polar's
   * checkout remounts this component, and the facts say "has a domain, not
   * verified" - so somebody who paid on step five was put back on step three.
   * They had not gone back, they had come back.
   */
  resumeStep: string | null
  /** Records written by the DNS callback that sent the browser back here. */
  justPublished: number
  /** The domain steps as a reload left them, from set-up's own draft cookie. */
  domainDraft?: RestoredDraft | null
}) {
  const router = useRouter()
  const reduce = useReducedMotion() ?? false

  // ⚠ ONE FACT THE SHELL KEEPS FOR THE PLAN STEP: once a payment has landed,
  // "You can come back to this" is advice about a flow that has just finished.
  const [paidNow, setPaidNow] = React.useState(false)
  const paid = paidNow || onPaidPlan(billing)

  // ⚠ THE "RECORDS ADDED" NEWS IS SHOWN ONCE PER VISIT. It arrived in a cookie
  // from the DNS callback (see lib/arrival.ts); deleting it on sight means a
  // later reload does not announce old news, and holding it in state means the
  // next server render - which reads no cookie - does not take it away.
  React.useEffect(() => {
    if (justPublished > 0) clearArrival(ARRIVAL.published, "/onboarding")
  }, [justPublished])
  const [published, setPublished] = React.useState(justPublished)
  if (justPublished > published) setPublished(justPublished)

  const [step, setStep] = React.useState<StepId>(() => {
    // The remembered step first: it says where somebody WAS, the facts below
    // say where they ought to be.
    if (resumeStep && STEPS.some((s) => s.id === resumeStep))
      return resumeStep as StepId
    if (state.completed_at) return "plan"
    if (state.facts.has_verified_domain && state.facts.has_api_key) return "plan"
    if (state.facts.has_verified_domain) return "send"
    if (state.facts.has_domain) return "verify"
    /*
     * ⚠ NO DOMAIN MEANS NO STEP PAST THE DOMAIN STEP, WHATEVER THE ROW SAYS -
     * a Verify screen with nothing on it to verify helps nobody. "workspace" is
     * the one stored step that still wins, because it is behind the ceiling.
     */
    const stored = STEPS.some((s) => s.id === state.step)
      ? (state.step as StepId)
      : "workspace"
    return stored === "workspace" ? "workspace" : "domain"
  })
  const index = STEPS.findIndex((s) => s.id === step)

  /*
   * ⚠ WHERE "CHANGE" WAS PRESSED FROM, SO "CONTINUE" GOES BACK THERE
   * (2026-10-04). Going back to fix the workspace name used to make Continue
   * walk forward one step at a time through steps already done; it now returns
   * to the step the person left to make the change - with everything in it as
   * they left it (see StepItem: a step's contents stay mounted).
   */
  const [resume, setResume] = React.useState<StepId | null>(null)
  const go = React.useCallback(
    (next: StepId) => {
      const at = (id: StepId) => STEPS.findIndex((s) => s.id === id)
      // Going back: remember the step just left - the most recent one wins.
      if (at(next) < at(step)) setResume(step)
      setStep(next)
      // ⚠ INTO A COOKIE, NOT THE URL - see lib/onboarding-step.ts.
      rememberStep(tenantId, next)
      // ⚠ NOT AWAITED. Resuming later is its only purpose.
      void updateOnboarding({ step: next })
    },
    [tenantId, step],
  )

  /** A step's own Continue: back to where "Change" was pressed, or onwards. */
  const advance = (from: StepId) => {
    const at = STEPS.findIndex((s) => s.id === from)
    const back = resume ? STEPS.findIndex((s) => s.id === resume) : -1
    if (resume && back > at) {
      setResume(null)
      go(resume)
      return
    }
    go(STEPS[at + 1]!.id)
  }

  async function finish() {
    rememberStep(tenantId, null)
    rememberDraft(tenantId, null, "onboarding")
    await updateOnboarding({ completed: true })
    router.push("/")
  }

  const stateOf = (id: StepId) => {
    const i = STEPS.findIndex((s) => s.id === id)
    return i < index ? "done" : i === index ? "current" : "next"
  }

  // ── What the stage shows ──────────────────────────────────────────────────
  const [name, setName] = React.useState(workspaceName)
  const [domainPreview, setDomainPreview] = React.useState({ name: "", naming: true })
  const [sentTo, setSentTo] = React.useState<string | null>(null)

  const firstVerified = domains.find((d) => d.status === "verified") ?? null
  const plan = step === "plan"
  const column = React.useRef<HTMLDivElement>(null)

  const body =
    (
      /*
       * ⚠ THE SHELL IS ONE SCREEN TALL AND ONLY THE LEFT SCROLLS (2026-10-03).
       * The stage was `sticky` on a scrolling document, so it still travelled
       * with an overscroll at either end; in its own non-scrolling column it
       * cannot move at all. Same arrangement as the console shell.
       */
      <div className="flex min-h-0 flex-1">
        <div ref={column} className="min-w-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="px-6 py-12 sm:px-10 lg:px-12 xl:px-16">
            {/* ⚠ WIDER ON THE PLAN STEP, where three cards sit side by side. */}
            <div
              className={cn(
                "mx-auto transition-[max-width] duration-700 ease-out",
                plan ? "max-w-5xl" : "max-w-3xl",
              )}
            >
              <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                Step {index + 1} of {STEPS.length}
              </p>
              <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
                Set up i10
              </h1>
              <p className="mt-2 max-w-lg text-sm text-muted-foreground">
                Name your workspace, add the domain you send from, verify it, and send
                your first email. Nothing here is permanent.
              </p>

              <LayoutGroup>
                <StepRail className="mt-10" follow>
                  {/* ── Workspace ── */}
                  <StepItem
                    state={stateOf("workspace")}
                    last={false}
                    title="Workspace"
                    icon={<Building2 />}
                    description="The name on your invoices and in the workspace switcher."
                    reduce={reduce}
                    summary={
                      <Answer onChange={() => go("workspace")}>
                        <Building2 className="size-4 text-muted-foreground" />
                        <span className="truncate">{name || workspaceName}</span>
                      </Answer>
                    }
                  >
                    <WorkspaceForm
                      initial={workspaceName}
                      value={name}
                      onChange={setName}
                      onDone={() => advance("workspace")}
                      onFailed={() => go("workspace")}
                    />
                  </StepItem>

                  {/* ── Domain ── */}
                  <DomainSection
                    state={stateOf("domain")}
                    restored={domainDraft}
                    tenantId={tenantId}
                    domains={domains}
                    offers={offers}
                    reduce={reduce}
                    onPreview={setDomainPreview}
                    onChange={() => go("domain")}
                    onDone={() => advance("domain")}
                    onLeaveForProvider={() => {
                      // The provider's sign-in comes back to set-up; land on Verify.
                      rememberStep(tenantId, "verify")
                      void updateOnboarding({ step: "verify" })
                    }}
                  />

                  {/* ── Verify ── */}
                  <VerifyItem
                    state={stateOf("verify")}
                    fallback={firstVerified}
                    hasFocus={focus !== null}
                    published={published}
                    reduce={reduce}
                    onChange={() => go("verify")}
                    onAddDomain={() => go("domain")}
                    onDone={() => advance("verify")}
                  />

                  {/* ── Send ── */}
                  <StepItem
                    state={stateOf("send")}
                    last={false}
                    title="Send your first email"
                    icon={<Send />}
                    description="Add an API key, then send the code below - or press Send email and we send it for you."
                    tone={sentTo ? "success" : "warning"}
                    badge={sentTo ? undefined : "Skipped"}
                    reduce={reduce}
                    summary={
                      <Answer onChange={() => go("send")}>
                        <Send className="size-4 text-muted-foreground" />
                        <span className="truncate">
                          {sentTo ? `Delivered to ${sentTo}` : "Not sent yet"}
                        </span>
                      </Answer>
                    }
                  >
                    <SendStep
                      firstVerified={firstVerified}
                      hasApiKey={state.facts.has_api_key}
                      recipient={userEmail}
                      onSent={(to) => setSentTo(to)}
                      onDone={() => advance("send")}
                    />
                  </StepItem>

                  {/* ── Plan ── */}
                  <StepItem
                    state={stateOf("plan")}
                    last
                    title="Plan"
                    icon={<CreditCard />}
                    description={
                      paid
                        ? "Your plan is active. Carry on, or change it here - you can do either at any time."
                        : "Start free and change it whenever. Allowances move the moment a payment clears."
                    }
                    reduce={reduce}
                  >
                    <StepPlan
                      plans={plans}
                      billing={billing}
                      checkoutId={checkoutId}
                      onDone={finish}
                      onSubscribed={() => setPaidNow(true)}
                    />
                  </StepItem>
                </StepRail>
              </LayoutGroup>

              {/*
               * ⚠ ONE WAY FORWARD PER STEP, AND IT IS THE STEP'S OWN BUTTON. "Skip"
               * is the escape a wizard needs - nobody should have to wait out DNS
               * propagation to see the rest. A skipped step's card says so, in
               * amber, rather than claiming it was done.
               */}
              <div className="mt-12 flex items-center justify-between border-t pt-5">
                {!paid ? (
                  <p className="text-xs text-muted-foreground">
                    You can come back to this any time from{" "}
                    <Link href="/onboarding" className="underline underline-offset-4">
                      Set-up
                    </Link>{" "}
                    on the overview.
                  </p>
                ) : (
                  <span />
                )}
                {index < STEPS.length - 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full"
                    onClick={() => go(STEPS[index + 1]!.id)}
                  >
                    Skip this step
                    <ArrowRight />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/*
         * ⚠ THE STAGE STEPS ASIDE FOR THE PLAN STEP, SLOWLY, rather than
         * vanishing: its column narrows to nothing while the cards' column widens
         * into the room, so the screen visibly makes space for them.
         */}
        <motion.aside
          /*
           * ⚠ THE STAGE NEVER SCROLLS, BUT A WHEEL OVER IT SCROLLS THE STEPS
           * (2026-10-04). It is half the screen; a wheel there doing nothing
           * read as the page being stuck. The stage stays where it is and the
           * column beside it moves, as if the pointer were over it.
           */
          onWheel={(event) => column.current?.scrollBy({ top: event.deltaY, left: 0 })}
          initial={false}
          animate={plan ? { width: "0%", opacity: 0 } : { width: "40%", opacity: 1 }}
          transition={{ duration: reduce ? 0 : 0.9, ease: EASE }}
          className="hidden shrink-0 overflow-hidden border-l bg-muted/10 lg:block"
          aria-hidden={plan}
        >
          <div className="h-full w-[40vw]">
            <StageFor
              step={plan ? "send" : step}
              name={name}
              domain={domainPreview.name || domains[0]?.name || ""}
              firstVerified={firstVerified}
              sentTo={sentTo}
              recipient={userEmail}
            />
          </div>
        </motion.aside>
      </div>
    )

  /*
   * ⚠ THE DOMAIN BEING VERIFIED IS LIVE FOR THE WHOLE FLOW, the domain page's
   * own state (components/domain-live.tsx): the verify step's events, the
   * stage's checks and the send step's "is it verified yet" all read it, and
   * the watch behind it registers and checks the domain while somebody is on
   * any step. Rendered even with no domain, so the tree never changes shape.
   */
  return <DomainLiveProvider initial={focus}>{body}</DomainLiveProvider>
}

/** An answered step's card body: what was chosen, and a way back to it. */
function Answer({
  onChange,
  children,
}: {
  onChange: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-current/10 bg-background/40 px-3 py-2 text-sm">
        {children}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="rounded-full"
        onClick={onChange}
      >
        Change
      </Button>
    </div>
  )
}

// ── Workspace ────────────────────────────────────────────────────────────────

/**
 * ⚠ NO "WHAT WILL YOU BE SENDING?" (2026-10-03). It was optional, changed
 * nothing, and was the one question in set-up that was ours rather than theirs.
 *
 * ⚠ IT MOVES ON FIRST AND SAVES SECOND (2026-10-03). A rename is almost never
 * refused, so waiting on it put a spinner between every person and their
 * second step for a case that nearly never happens. Continue goes to the domain
 * step at once; the save runs behind it, and if it fails the flow comes back
 * here with the name still typed and says why.
 */
function WorkspaceForm({
  initial,
  value,
  onChange,
  onDone,
  onFailed,
}: {
  initial: string
  value: string
  onChange: (value: string) => void
  onDone: () => void
  onFailed: () => void
}) {
  const saved = React.useRef(initial)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const next = value.trim()
    onDone()
    if (next === "" || next === saved.current) return
    const before = saved.current
    saved.current = next
    void renameWorkspace(next).then((renamed) => {
      if (renamed.ok) return
      saved.current = before
      toastError("Could not save the name", renamed.error)
      onFailed()
    })
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <FloatingInput
        label="Workspace name"
        id="workspace-name"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={120}
        autoFocus
      />
      <Button type="submit" className="rounded-full">
        Continue
      </Button>
    </form>
  )
}

// ── Domain ───────────────────────────────────────────────────────────────────

/**
 * The domain step: the domains already here and any offered by email, and the
 * same steps /domains/new walks to add one.
 */
function DomainSection({
  state,
  tenantId,
  domains,
  offers,
  restored,
  reduce,
  onPreview,
  onChange,
  onDone,
  onLeaveForProvider,
}: {
  state: "done" | "current" | "next"
  tenantId: string
  domains: DomainSummary[]
  offers: TransferOffer[]
  /** The domain steps as a reload left them - see lib/add-domain-draft. */
  restored: RestoredDraft | null
  reduce: boolean
  onPreview: (preview: { name: string; naming: boolean }) => void
  onChange: () => void
  onDone: () => void
  /** Called just before connecting a provider leaves the page. */
  onLeaveForProvider: () => void
}) {
  const router = useRouter()
  const [adding, setAdding] = React.useState(
    restored !== null || (domains.length === 0 && offers.length === 0),
  )
  /** Whether the domain steps hold anything worth keeping mounted for. */
  const [progressed, setProgressed] = React.useState(
    restored !== null && (restored.name.trim() !== "" || restored.step !== "domain"),
  )
  // ⚠ STABLE, because the steps report from an effect that depends on it - a
  // fresh function per render would report, re-render and report forever.
  const report = React.useCallback(
    (preview: { name: string; naming: boolean }) => {
      setProgressed(preview.name.trim() !== "" || !preview.naming)
      onPreview(preview)
    },
    [onPreview],
  )

  const exits = React.useMemo<AddDomainExits>(
    () => ({
      returnTo: () => {
        onLeaveForProvider()
        return "/onboarding"
      },
      onFinish: () => {
        setAdding(false)
        // ⚠ THE NEW DOMAIN HAS TO REACH THE VERIFY STEP, and it lives in the
        // server's render - this is the one refresh set-up asks for.
        router.refresh()
        onDone()
      },
      ...(domains.length > 0 || offers.length > 0
        ? { onCancel: () => setAdding(false) }
        : {}),
    }),
    [domains.length, offers.length, onDone, onLeaveForProvider, router],
  )

  /*
   * ⚠ MOUNTED FOR AS LONG AS SOMEBODY IS ADDING, WHICHEVER STEP IS OPEN
   * (2026-10-04). Before the domain step its items read as upcoming, after it
   * as answered - but the steps themselves, and everything typed and chosen
   * in them, stay. They used to exist only while this step was current, so
   * going back to the workspace threw away a domain half set up.
   */
  /*
   * ⚠ BUT ONLY WHILE THEY HOLD SOMETHING, OR ARE THE STEP BEING ANSWERED
   * (2026-10-04). Fresh steps off to one side - nothing typed, nothing made -
   * have nothing to keep, and drawn as "answered" they claimed a skipped
   * domain and a records choice nobody made: exactly what showed after a
   * domain added here was deleted from its own page and set-up came back with
   * none. Then this step is the one card, saying there is no domain yet.
   */
  if (adding && (state === "current" || progressed)) {
    return (
      <AddDomainSteps
        tenantId={tenantId}
        restored={restored}
        draft="onboarding"
        phase={state === "next" ? "before" : state === "current" ? "active" : "after"}
        trailing
        icons
        exits={exits}
        onPreview={report}
        onOpen={onChange}
      />
    )
  }

  return (
    <StepItem
      state={state}
      last={false}
      title="Domain"
      icon={<Globe />}
      description="The domain you send from. Add one, or carry on with one you have."
      tone={domains.length === 0 ? "warning" : "success"}
      badge={domains.length === 0 ? "Skipped" : undefined}
      reduce={reduce}
      summary={
        <Answer onChange={onChange}>
          <Globe className="size-4 text-muted-foreground" />
          <span className="truncate font-mono">
            {domains.length === 0
              ? "No domain yet"
              : domains.map((d) => d.name).join(", ")}
          </span>
        </Answer>
      }
    >
      <div className="space-y-4">
        <OfferedDomains offers={offers} onAccepted={() => router.refresh()} />
        {domains.length > 0 && (
          <ul className="divide-y overflow-hidden rounded-2xl border">
            {domains.map((domain) => (
              <li
                key={domain.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border/60 ring-inset">
                    <Globe className="size-4" />
                  </span>
                  <span className="truncate font-mono text-sm">{domain.name}</span>
                </span>
                <Status status={domain.status} variant="pill" />
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {domains.length > 0 && (
            <Button className="rounded-full" onClick={onDone}>
              Continue
            </Button>
          )}
          <Button
            variant={domains.length > 0 ? "outline" : "default"}
            className="rounded-full"
            onClick={() => setAdding(true)}
          >
            <Plus />
            {domains.length > 0 ? "Add another domain" : "Add a domain"}
          </Button>
        </div>
      </div>
    </StepItem>
  )
}

/** Domains somebody offered this person by email, to accept in place. */
function OfferedDomains({
  offers,
  onAccepted,
}: {
  offers: TransferOffer[]
  onAccepted: () => void
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  if (offers.length === 0) return null

  async function accept(offer: TransferOffer) {
    setBusy(offer.id)
    const result = await acceptTransfer(offer.id)
    setBusy(null)
    if (!result.ok) {
      toastError("Could not accept the domain", result.error)
      return
    }
    toastDone(
      `${offer.domain_name} is yours`,
      "It arrived with its records and verification.",
    )
    onAccepted()
  }

  return (
    <ul className="divide-y overflow-hidden rounded-2xl border border-sky-500/25 bg-sky-500/5">
      {offers.map((offer) => (
        <li
          key={offer.id}
          className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0 space-y-0.5">
            <p className="truncate font-mono text-sm">{offer.domain_name}</p>
            <p className="text-xs text-muted-foreground">
              Offered by {offer.offered_by} from the {offer.from_workspace} workspace
            </p>
          </div>
          <Button
            size="sm"
            className="shrink-0 self-start rounded-full sm:self-auto"
            onClick={() => accept(offer)}
            disabled={busy !== null}
          >
            {busy === offer.id && <Spinner />}
            Accept
          </Button>
        </li>
      ))}
    </ul>
  )
}

// ── Verify ───────────────────────────────────────────────────────────────────

/**
 * The verify step, coloured by the live domain: amber "Not verified yet" while
 * it is waiting - skipped past, or simply not there yet - and green the moment
 * the watch sees it verified, without anybody coming back to it.
 */
function VerifyItem({
  state,
  fallback,
  hasFocus,
  published,
  reduce,
  onChange,
  onAddDomain,
  onDone,
}: {
  state: "done" | "current" | "next"
  fallback: DomainSummary | null
  hasFocus: boolean
  published: number
  reduce: boolean
  onChange: () => void
  onAddDomain: () => void
  onDone: () => void
}) {
  const live = useLiveDomain()
  const name = live?.domain.name ?? fallback?.name ?? null
  const status = live?.domain.status ?? fallback?.status ?? null
  const verified = status === "verified"

  return (
    <StepItem
      state={state}
      last={false}
      title="Verify"
      icon={<ShieldCheck />}
      description="We look for your records and register the domain for sending the moment they resolve. This updates by itself."
      tone={verified ? "success" : "warning"}
      badge={verified ? undefined : name ? "Not verified yet" : "Skipped"}
      reduce={reduce}
      summary={
        <Answer onChange={onChange}>
          {name && status ? (
            <>
              <span className="truncate font-mono">{name}</span>
              <Status status={status} variant="pill" />
            </>
          ) : (
            <span>Nothing to verify yet</span>
          )}
        </Answer>
      }
    >
      <VerifyStep
        hasFocus={hasFocus}
        published={published}
        onAddDomain={onAddDomain}
        onDone={onDone}
      />
    </StepItem>
  )
}

/**
 * The domain page's own events strip for the domain being verified, live.
 *
 * ⚠ CONTINUE WAITS FOR VERIFIED, BUT NOTHING ELSE DOES. Sending before
 * verification is refused, so moving on early only meets that refusal; "Skip
 * this step" is still there for somebody whose DNS is somebody else's job.
 */
function VerifyStep({
  hasFocus,
  published,
  onAddDomain,
  onDone,
}: {
  hasFocus: boolean
  published: number
  onAddDomain: () => void
  onDone: () => void
}) {
  const live = useLiveDomain()
  if (!hasFocus || !live) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Add a domain first - then this checks it.
        </p>
        <Button variant="outline" className="rounded-full" onClick={onAddDomain}>
          <Plus />
          Add a domain
        </Button>
      </div>
    )
  }

  const verified = live.domain.status === "verified"
  return (
    <div className="space-y-6">
      {published > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <CheckCircle2
            aria-hidden
            className="mt-0.5 size-5 shrink-0 text-emerald-500"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {published === 1
                ? "Your records were added"
                : `Your records were added for ${published} domains`}
            </p>
            <p className="text-sm text-muted-foreground">
              We wrote them at your DNS provider and started checking.
            </p>
          </div>
        </div>
      )}

      <LiveDomainJourney quiet={false} />

      <div className="flex flex-wrap items-center gap-2">
        <Button className="rounded-full" disabled={!verified} onClick={onDone}>
          {verified ? `Continue with ${live.domain.name}` : "Waiting for verification"}
        </Button>
        {/* ⚠ A PLAIN ANCHOR THROUGH THE SKIP ROUTE - the console bounces back to
            set-up otherwise. See app/onboarding/page.tsx. */}
        <Button variant="ghost" className="rounded-full" asChild>
          <a
            href={`/onboarding/skip?to=${encodeURIComponent(`/domains/${live.domain.id}`)}`}
          >
            See its records
            <ArrowUpRight />
          </a>
        </Button>
      </div>
    </div>
  )
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Which domain the send comes from, and whether it can yet: the live domain
 * once it is verified, or any domain already verified.
 */
function useSendFrom(firstVerified: DomainSummary | null) {
  const live = useLiveDomain()
  if (live?.domain.status === "verified")
    return { from: live.domain.name, verified: true }
  if (firstVerified) return { from: firstVerified.name, verified: true }
  return { from: live?.domain.name ?? null, verified: false }
}

function SendStep({
  firstVerified,
  hasApiKey,
  recipient,
  onSent,
  onDone,
}: {
  firstVerified: DomainSummary | null
  hasApiKey: boolean
  recipient: string | null
  onSent: (to: string) => void
  onDone: () => void
}) {
  const { from, verified } = useSendFrom(firstVerified)
  return (
    <SendFirstEmail
      from={from}
      verified={verified}
      hasApiKey={hasApiKey}
      recipient={recipient}
      onSent={({ to }) => onSent(to)}
      onDone={onDone}
    />
  )
}

// ── Stage ────────────────────────────────────────────────────────────────────

function StageFor({
  step,
  name,
  domain,
  firstVerified,
  sentTo,
  recipient,
}: {
  step: StepId
  name: string
  domain: string
  firstVerified: DomainSummary | null
  sentTo: string | null
  recipient: string | null
}) {
  const { from } = useSendFrom(firstVerified)
  const scene: StageScene =
    step === "workspace"
      ? { kind: "workspace", name: name.trim() }
      : step === "domain"
        ? { kind: "domain", domain: domain.trim().toLowerCase() }
        : step === "verify"
          ? { kind: "verify" }
          : {
              kind: "send",
              sent: sentTo !== null,
              from: from ? `hello@${from}` : "hello@yourdomain.com",
              to: sentTo ?? recipient ?? "you@example.com",
            }
  return <Stage scene={scene} />
}
