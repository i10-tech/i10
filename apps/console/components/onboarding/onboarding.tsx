"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, ArrowRight, Check } from "lucide-react"
import { AutoHeight } from "@repo/ui/components/auto-height"
import { Button } from "@repo/ui/components/button"
import { StepStage } from "@repo/ui/components/step-stage"
import { cn } from "cn"
import { StepDomain } from "@/components/onboarding/step-domain"
import { StepPlan } from "@/components/onboarding/step-plan"
import { StepSend } from "@/components/onboarding/step-send"
import { StepVerify } from "@/components/onboarding/step-verify"
import { StepWorkspace } from "@/components/onboarding/step-workspace"
import { updateOnboarding } from "@/lib/actions"
import { onPaidPlan } from "@/lib/billing"
import { ARRIVAL, clearArrival } from "@/lib/arrival"
import { rememberStep } from "@/lib/onboarding-step"
import type {
  BillingState,
  DomainSummary,
  OnboardingState,
  PlanSummary,
  TransferOffer,
} from "@/lib/types"

/**
 * The five steps.
 *
 * ⚠ THE STEP LIVES IN LOCAL STATE AND IS *MIRRORED* TO THE SERVER, NOT DRIVEN
 * BY IT. Driving it from the server would make every "Next" a round trip with
 * nothing on screen, on the one flow where hesitation costs a signup. The write
 * is fire-and-forget so that coming back tomorrow resumes where they were; if
 * it fails, the worst outcome is starting a step earlier.
 *
 * ⚠ AND THE FLOW NEVER BLOCKS ON A STEP BEING "COMPLETE". Somebody can walk
 * past the domain step without adding one - they may be evaluating, or waiting
 * on whoever controls DNS. A wizard that refuses to advance is a wizard people
 * abandon, and every one of these steps is reachable from its own page
 * afterwards.
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
  offers = [],
  userEmail = null,
  plans,
  billing,
  checkoutId,
  resumeStep,
  justPublished,
}: {
  state: OnboardingState
  workspaceName: string
  /** Keys the remembered step, so it never crosses workspaces. */
  tenantId: string
  domains: DomainSummary[]
  /** Domains offered to this person by email, shown on the domain step. */
  offers?: TransferOffer[]
  /** The signed-in person's verified address - the test email goes to them. */
  userEmail?: string | null
  plans: PlanSummary[]
  billing: BillingState
  /** From the checkout cookie (see lib/arrival.ts), for the plan step's outcome banner. */
  checkoutId: string | null
  /**
   * The step this browser was last on, from its cookie - it outranks
   * everything below. See lib/onboarding-step.ts.
   *
   * ⚠ IT EXISTS BECAUSE PAYING THREW PEOPLE BACKWARDS. The step is local state;
   * returning from Polar's checkout remounts this component, the initialiser
   * below runs again, and the facts it reads say "has a domain, not verified" -
   * so somebody who paid on step five was put back on step three. The facts
   * were right and the conclusion was wrong: they had not gone back, they had
   * come back.
   */
  resumeStep: string | null
  /** Records written by the DNS callback that sent the browser back here. */
  justPublished: number
}) {
  const router = useRouter()

  /*
   * ⚠ THE STARTING STEP IS DERIVED FROM THE FACTS FIRST AND THE STORED STEP
   * SECOND. Somebody who set everything up through the API and opened this page
   * out of curiosity should not be asked to name a workspace that exists and
   * add a domain that is already verified. The row is a hint; the world is the
   * truth.
   */
  /*
   * ⚠ ONE FACT THE SHELL KEEPS FOR THE PLAN STEP, BECAUSE THE FOOTER IS THE
   * SHELL'S. Once a payment has landed, "You can come back to this at any
   * time from Set-up" is advice about a flow that has just finished - and the
   * step below it is offering a way to the dashboard.
   */
  const [paidNow, setPaidNow] = React.useState(false)

  /*
   * ⚠ THE SAME TEST THE PLAN STEP MAKES, because the footer and the step
   * have to agree about whether set-up is finished. A subscription that was
   * already there counts: the line is for somebody leaving a flow half done,
   * and there is nothing half done about a workspace that is paying.
   */
  const paid = paidNow || onPaidPlan(billing)

  // ⚠ THE "RECORDS ADDED" NEWS IS SHOWN ONCE. It arrived in a cookie from the
  // DNS callback (see lib/arrival.ts); deleting it on sight means a later
  // reload says "Publish your records" rather than announcing old news.
  React.useEffect(() => {
    if (justPublished > 0) clearArrival(ARRIVAL.published, "/onboarding")
  }, [justPublished])

  /*
   * ⚠ BUT "ONCE" MEANS ONCE PER VISIT, NOT ONCE PER RENDER, AND DELETING THE
   * COOKIE MADE IT THE SECOND. The very next server render - the verify step's
   * own poll, or Next refreshing when the tab regains focus - reads no cookie
   * and passes 0, so the green "Your records were added" vanished a few seconds
   * after arriving, or the moment somebody glanced at another tab and came
   * back. Held here, it stays for as long as this page does; a reload is still
   * the fresh start the note above wants.
   */
  const [published, setPublished] = React.useState(justPublished)
  if (justPublished > published) setPublished(justPublished)

  const [step, setStep] = React.useState<StepId>(() => {
    /*
     * ⚠ THE REMEMBERED STEP FIRST, BECAUSE IT IS THE ONLY SOURCE THAT SURVIVES A REMOUNT
     * AND SAYS WHERE SOMEBODY *WAS* RATHER THAN WHERE THEY OUGHT TO BE. The
     * derivation below is about a fresh arrival; this is about coming back.
     */
    if (resumeStep && STEPS.some((s) => s.id === resumeStep)) {
      return resumeStep as StepId
    }
    if (state.completed_at) return "plan"
    if (state.facts.has_verified_domain && state.facts.has_api_key) return "plan"
    if (state.facts.has_verified_domain) return "send"
    if (state.facts.has_domain) return "verify"

    /*
     * ⚠ NO DOMAIN MEANS NO STEP PAST THE DOMAIN STEP, WHATEVER THE ROW SAYS.
     * The stored step used to be returned as-is here, so somebody who reached
     * "verify" and then deleted their only domain - or never finished adding
     * one - reopened set-up on a Verify screen with nothing on it to verify,
     * and no indication that the thing to do was one step back. The facts had
     * already said `has_domain: false`; the row simply outranked them on this
     * one line, which is the opposite of the rule the rest of this block
     * follows.
     *
     * ⚠ AND "workspace" IS THE ONE STORED STEP THAT STILL WINS, because it is
     * BEHIND the ceiling rather than past it. Somebody who has not yet named
     * their workspace must not be skipped forward to a domain field; the
     * clamp is against resuming too far along, not against resuming at all.
     */
    const stored = STEPS.some((s) => s.id === state.step)
      ? (state.step as StepId)
      : "workspace"
    return stored === "workspace" ? "workspace" : "domain"
  })

  const index = STEPS.findIndex((s) => s.id === step)

  /*
   * ⚠ WHICH WAY THE STEPS SLIDE, DECIDED AT THE MOMENT OF THE MOVE. Back, a
   * click on an earlier dot, or Skip - the rail lets somebody go anywhere, so
   * the direction is "is the new step before or after this one", not "was it
   * the Back button". Set in the same batch as the step, so the pane that
   * leaves and the one that arrives agree on it.
   */
  const [direction, setDirection] = React.useState<"forward" | "back">("forward")

  const go = React.useCallback(
    (next: StepId) => {
      const from = STEPS.findIndex((s) => s.id === step)
      const to = STEPS.findIndex((s) => s.id === next)
      setDirection(to < from ? "back" : "forward")
      setStep(next)

      /*
       * ⚠ INTO A COOKIE, NOT THE URL. It used to be `?step=` via
       * `history.replaceState`; the address bar now stays `/onboarding` from the
       * first step to the last. The server reads the cookie on the way back in -
       * see lib/onboarding-step.ts.
       */
      rememberStep(tenantId, next)

      // ⚠ NOT AWAITED. The person is already looking at the next step; making
      // them wait for a write whose only purpose is resuming later would add
      // latency to every click for no visible benefit.
      void updateOnboarding({ step: next })
    },
    [tenantId, step],
  )

  async function finish() {
    // Finished: the next visit to set-up starts from the facts, not from here.
    rememberStep(tenantId, null)
    await updateOnboarding({ completed: true })
    router.push("/")
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10">
      {/*
       * ⚠ A STEP INDICATOR, NOT A PROGRESS BAR. A bar implies a percentage
       * complete, which is meaningless when a step can be skipped and revisited.
       * Named steps also let somebody jump back to the one they want.
       */}
      <nav aria-label="Set-up progress" className="mb-8 flex items-center gap-1">
        {STEPS.map((s, i) => {
          const done = i < index
          const current = i === index
          return (
            <React.Fragment key={s.id}>
              <button
                type="button"
                onClick={() => go(s.id)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                  "duration-(--duration-instant) ease-(--ease-linear)",
                  current
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border text-[9px]/none tabular-nums",
                    "transition-colors duration-(--duration-dismiss) ease-(--ease-linear)",
                    done && "border-foreground bg-foreground text-background",
                    current && "border-foreground",
                  )}
                >
                  {/* ⚠ THE TICK ARRIVES THE WAY EVERY OTHER TICK IN THE CONSOLE
                      DOES - a small scale-in - so finishing a step reads as the
                      same event as a form that worked. Keyed, so it only plays
                      when a step becomes done, not on every render. */}
                  {done ? (
                    <Check
                      key="done"
                      className="motion-surface size-2.5 animate-[surface-enter_var(--duration-dismiss)_var(--ease-quint-out)]"
                    />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                /*
                 * ⚠ THE CONNECTOR FILLS, LEFT TO RIGHT, AS THE STEP BEFORE IT
                 * COMPLETES - and empties the other way on Back. It is the
                 * rail's continuity: the line you just travelled is the one
                 * that changes, in the direction you travelled it. A transform
                 * on an inner bar, so it runs on the compositor.
                 */
                <span aria-hidden="true" className="relative h-px flex-1 bg-border">
                  <span
                    className={cn(
                      "absolute inset-0 origin-left bg-foreground",
                      "transition-transform duration-(--duration-move) ease-(--ease-quint-out)",
                      done ? "scale-x-100" : "scale-x-0",
                    )}
                  />
                </span>
              )}
            </React.Fragment>
          )
        })}
      </nav>

      {/*
       * ⚠ THE STEPS SLIDE, AND THE FOOTER RIDES THE HEIGHT CHANGE. Each step
       * was conditional JSX, so moving on was a hard cut to a screen of a
       * different height and the Back/Skip row jumped with it. `StepStage`
       * slides the panes 12px in the direction of travel - the same motion as
       * the sign-in flow - and `AutoHeight` animates the real height so the
       * row below glides to its new place rather than landing there first.
       */}
      <AutoHeight>
        <StepStage morph={false} step={step} direction={direction}>
          <div className="min-h-[24rem]">
            {step === "workspace" && (
              <StepWorkspace
                name={workspaceName}
                useCase={state.use_case}
                onDone={() => go("domain")}
              />
            )}

            {step === "domain" && (
              <StepDomain
                domains={domains}
                offers={offers}
                onDone={() => go("verify")}
              />
            )}

            {step === "verify" && (
              <StepVerify
                domains={domains}
                justPublished={published}
                onDone={() => go("send")}
              />
            )}

            {step === "send" && (
              <StepSend
                domains={domains}
                hasApiKey={state.facts.has_api_key}
                recipient={userEmail}
                onDone={() => go("plan")}
              />
            )}

            {step === "plan" && (
              <StepPlan
                plans={plans}
                billing={billing}
                checkoutId={checkoutId}
                onDone={finish}
                onSubscribed={() => setPaidNow(true)}
              />
            )}
          </div>
        </StepStage>
      </AutoHeight>

      {/*
       * ⚠ THERE IS EXACTLY ONE WAY FORWARD FROM EACH STEP, AND IT IS THE STEP'S
       * OWN BUTTON. This bar used to carry a primary "Next" as well, so every
       * screen showed two buttons that did the same thing - "Continue" inside
       * the step and "Next" underneath it - and a person had to work out
       * whether they differed. They did not, except on the workspace step,
       * where "Continue" saved the name and "Next" silently discarded it. Two
       * controls for one action is not a convenience; it is a question.
       *
       * ⚠ "Skip this step" SURVIVES, BECAUSE IT IS WHAT "Next" WAS ACTUALLY
       * FOR. The original note is still right: a wizard that refuses to advance
       * until DNS propagates is a wizard people close. What it needed was an
       * escape, not a second primary action - so the escape stays and says what
       * it does.
       */}
      <div className="mt-8 flex items-center justify-between border-t pt-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => index > 0 && go(STEPS[index - 1]!.id)}
          disabled={index === 0}
        >
          <ArrowLeft />
          Back
        </Button>

        {index < STEPS.length - 1 && (
          <Button variant="ghost" size="sm" onClick={() => go(STEPS[index + 1]!.id)}>
            Skip this step
            <ArrowRight />
          </Button>
        )}
      </div>

      {/*
       * ⚠ NOT AFTER A PAYMENT. The line exists to reassure somebody they can
       * leave a half-finished set-up; offering it under a step that has just
       * completed, beside a button to the dashboard, reads as a third way out
       * of a screen that now has one.
       */}
      {!paid && (
        <p className="mt-6 text-center text-xs text-muted-foreground">
          You can come back to this at any time from{" "}
          <Link href="/onboarding" className="underline underline-offset-4">
            Set-up
          </Link>{" "}
          on the overview.
        </p>
      )}
    </div>
  )
}
