import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@repo/ui/components/button"
import { Onboarding } from "@/components/onboarding/onboarding"
import { Wordmark } from "@/components/wordmark"
import { tryApi } from "@/lib/api"
import type { BillingState, DomainSummary, Me, PlanSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Set up" }

/**
 * Getting from a fresh account to a sent email.
 *
 * ⚠ IT SITS OUTSIDE THE `(app)` GROUP ON PURPOSE. The console layout redirects
 * here when `should_onboard` is true; if this page lived inside that layout the
 * redirect would be a loop. It also means the flow gets the whole viewport
 * rather than a sidebar and a usage meter competing with it.
 *
 * ⚠ AND IT IS REACHABLE AT ANY TIME, BY ANYONE, FOREVER. That is a requirement
 * rather than a side effect: the flow re-runs after an upgrade from the free
 * plan, and somebody adding their second domain a year later wants exactly this
 * screen. Nothing here checks whether onboarding is "allowed" — the flag
 * decides where we SEND people, never where they may go. See
 * docs/decisions/console.md §4.
 *
 * ⚠ THE "Skip" ROUTE IS ALWAYS PRESENT. A wizard somebody cannot leave is a
 * wizard they resent; the console is fully usable without finishing this, and
 * every step of it is available from the page it belongs to.
 */
// ⚠ SAME REASON AS THE CONSOLE LAYOUT: this reads a session and renders one
// tenant's domains and plan. It is outside the `(app)` group, so it does not
// inherit that layout's setting and needs its own.
export const dynamic = "force-dynamic"

export default async function OnboardingPage() {
  const [me, domains, plans] = await Promise.all([
    tryApi<Me>("/console/me"),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<{ data: PlanSummary[] }>("/console/plans"),
  ])

  if (!me.ok) {
    /*
     * ⚠ `tenant_not_ready` REACHES HERE TOO, AND IT IS STILL NOT AN ERROR. The
     * console layout handles it with a retry; this page is outside that layout,
     * so it needs its own answer. A person who signs up and lands straight here
     * before the provisioning webhook has fired sees a sentence, not a stack
     * trace.
     */
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <Wordmark />
        <p className="text-sm text-muted-foreground">
          {me.error.name === "tenant_not_ready"
            ? "Your workspace is still being created. Give it a moment and reload."
            : me.error.message}
        </p>
        <Button variant="outline" asChild>
          <Link href="/onboarding">Try again</Link>
        </Button>
      </main>
    )
  }

  const billing: BillingState = me.data.billing

  return (
    <main className="min-h-dvh">
      <header className="flex h-14 items-center justify-between border-b px-6">
        <Link href="/" className="flex items-center">
          <Wordmark />
        </Link>
        {/*
         * ⚠ "Skip to the console" RATHER THAN A CLOSE ICON. An × in the corner
         * of a set-up flow reads as "cancel", and people hesitate over whether
         * cancelling loses the domain they just added. Words say what happens.
         *
         * ⚠ AND IT POINTS AT `/onboarding/skip`, NOT AT `/`. The console layout
         * redirects here while `should_onboard` is true, so a link straight to
         * `/` was bounced back to this page — the button appeared to do nothing
         * at all. The route records the choice for this browser and then sends
         * them on. See lib/onboarding-skip.ts.
         */}
        <Button variant="ghost" size="sm" asChild>
          <Link href="/onboarding/skip">Skip to the console</Link>
        </Button>
      </header>

      <Onboarding
        state={me.data.onboarding}
        workspaceName={me.data.tenant?.name ?? ""}
        domains={domains.ok ? domains.data.data : []}
        plans={plans.ok ? plans.data.data : []}
        billing={billing}
      />
    </main>
  )
}
