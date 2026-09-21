"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, ArrowRight, Check } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { cn } from "cn"
import { StepDomain } from "@/components/onboarding/step-domain"
import { StepPlan } from "@/components/onboarding/step-plan"
import { StepSend } from "@/components/onboarding/step-send"
import { StepVerify } from "@/components/onboarding/step-verify"
import { StepWorkspace } from "@/components/onboarding/step-workspace"
import { updateOnboarding } from "@/lib/actions"
import type {
  BillingState,
  DomainSummary,
  OnboardingState,
  PlanSummary,
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
 * past the domain step without adding one — they may be evaluating, or waiting
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
  domains,
  plans,
  billing,
  checkoutId,
  stepFromUrl,
}: {
  state: OnboardingState
  workspaceName: string
  domains: DomainSummary[]
  plans: PlanSummary[]
  billing: BillingState
  /** From `?checkout_id=`, for the plan step's outcome banner. */
  checkoutId: string | null
  /**
   * From `?step=`, and it outranks everything below.
   *
   * ⚠ IT EXISTS BECAUSE PAYING THREW PEOPLE BACKWARDS. The step is local state;
   * returning from Polar's checkout remounts this component, the initialiser
   * below runs again, and the facts it reads say "has a domain, not verified" —
   * so somebody who paid on step five was put back on step three. The facts
   * were right and the conclusion was wrong: they had not gone back, they had
   * come back.
   */
  stepFromUrl: string | null
}) {
  const router = useRouter()

  /*
   * ⚠ THE STARTING STEP IS DERIVED FROM THE FACTS FIRST AND THE STORED STEP
   * SECOND. Somebody who set everything up through the API and opened this page
   * out of curiosity should not be asked to name a workspace that exists and
   * add a domain that is already verified. The row is a hint; the world is the
   * truth.
   */
  const [step, setStep] = React.useState<StepId>(() => {
    /*
     * ⚠ THE URL FIRST, BECAUSE IT IS THE ONLY SOURCE THAT SURVIVES A REMOUNT
     * AND SAYS WHERE SOMEBODY *WAS* RATHER THAN WHERE THEY OUGHT TO BE. The
     * derivation below is about a fresh arrival; this is about coming back.
     */
    if (stepFromUrl && STEPS.some((s) => s.id === stepFromUrl)) {
      return stepFromUrl as StepId
    }
    if (state.completed_at) return "plan"
    if (state.facts.has_verified_domain && state.facts.has_api_key) return "plan"
    if (state.facts.has_verified_domain) return "send"
    if (state.facts.has_domain) return "verify"
    return (state.step as StepId) ?? "workspace"
  })

  const index = STEPS.findIndex((s) => s.id === step)

  const go = React.useCallback((next: StepId) => {
    setStep(next)

    /*
     * ⚠ `history.replaceState`, NOT `router.replace`. Both put the step in the
     * URL; only this one does it without a navigation, so the server components
     * are not re-fetched and this tree is not re-rendered on every "Next".
     * Next.js supports it explicitly and keeps `useSearchParams` in sync with
     * it — see "Native History API" in the linking-and-navigating guide.
     *
     * ⚠ AND `replace` RATHER THAN `push`, so the browser's Back button still
     * means "leave set-up" rather than walking back through five steps one
     * entry at a time. The stepper above is how you go back.
     */
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search)
      params.set("step", next)
      window.history.replaceState(null, "", `?${params.toString()}`)
    }

    // ⚠ NOT AWAITED. The person is already looking at the next step; making
    // them wait for a write whose only purpose is resuming later would add
    // latency to every click for no visible benefit.
    void updateOnboarding({ step: next })
  }, [])

  async function finish() {
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
                    "grid size-4 shrink-0 place-items-center rounded-full border text-[9px]",
                    done && "border-foreground bg-foreground text-background",
                    current && "border-foreground",
                  )}
                >
                  {done ? <Check className="size-2.5" /> : i + 1}
                </span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              )}
            </React.Fragment>
          )
        })}
      </nav>

      <div className="min-h-[24rem]">
        {step === "workspace" && (
          <StepWorkspace
            name={workspaceName}
            useCase={state.use_case}
            onDone={() => go("domain")}
          />
        )}

        {step === "domain" && (
          <StepDomain domains={domains} onDone={() => go("verify")} />
        )}

        {step === "verify" && (
          <StepVerify domains={domains} onDone={() => go("send")} />
        )}

        {step === "send" && (
          <StepSend
            domains={domains}
            hasApiKey={state.facts.has_api_key}
            onDone={() => go("plan")}
          />
        )}

        {step === "plan" && (
          <StepPlan
            plans={plans}
            billing={billing}
            checkoutId={checkoutId}
            onDone={finish}
          />
        )}
      </div>

      {/*
       * ⚠ THERE IS EXACTLY ONE WAY FORWARD FROM EACH STEP, AND IT IS THE STEP'S
       * OWN BUTTON. This bar used to carry a primary "Next" as well, so every
       * screen showed two buttons that did the same thing — "Continue" inside
       * the step and "Next" underneath it — and a person had to work out
       * whether they differed. They did not, except on the workspace step,
       * where "Continue" saved the name and "Next" silently discarded it. Two
       * controls for one action is not a convenience; it is a question.
       *
       * ⚠ "Skip this step" SURVIVES, BECAUSE IT IS WHAT "Next" WAS ACTUALLY
       * FOR. The original note is still right: a wizard that refuses to advance
       * until DNS propagates is a wizard people close. What it needed was an
       * escape, not a second primary action — so the escape stays and says what
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

      <p className="mt-6 text-center text-xs text-muted-foreground">
        You can come back to this at any time from{" "}
        <Link href="/onboarding" className="underline underline-offset-4">
          Set-up
        </Link>{" "}
        on the overview.
      </p>
    </div>
  )
}
