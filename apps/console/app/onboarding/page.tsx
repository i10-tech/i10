import type { Metadata } from "next"
import { cookies } from "next/headers"
import { currentUser } from "@clerk/nextjs/server"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { OnboardingView } from "@/components/onboarding-view"
import { Wordmark } from "@/components/wordmark"
import { tryApi } from "@/lib/api"
import { DRAFT_COOKIES, draftFor } from "@/lib/add-domain-draft"
import { restoreDraft } from "@/lib/add-domain-restore"
import { ONBOARDING_STEP_COOKIE, stepFor } from "@/lib/onboarding-step"
import { onboardingShape, type OnboardingData } from "@/lib/shapes/onboarding"
import type {
  BillingState,
  Domain,
  DomainSummary,
  Me,
  PlanSummary,
  TransferOffer,
} from "@/lib/types"
import { ARRIVAL } from "@/lib/arrival"
import { readArrival } from "@/lib/arrival-server"

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
 * screen. Nothing here checks whether onboarding is "allowed" - the flag
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

export default async function OnboardingPage({
  searchParams,
}: {
  // ⚠ ONLY POLAR'S FULL-PAGE REDIRECT STILL ARRIVES WITH `checkout_id` IN THE
  // QUERY; our own embedded flow and the DNS callback write cookies instead -
  // see lib/arrival.ts. Somebody who buys a plan on the last step of set-up
  // lands back here and the plan step reports the outcome in place.
  //
  // ⚠ AND `published` IS THE CONFIRMATION THE DNS CALLBACK NO LONGER STOPS TO
  // SHOW. It used to paint its own green tick and then navigate here a moment
  // later, which read as a glitch; the news now arrives with the step that
  // follows it. See the callback handler and `VerifyStep` in components/onboarding/onboarding.tsx.
  searchParams: Promise<{ checkout_id?: string; published?: string; new?: string }>
}) {
  const query = await searchParams
  /*
   * ⚠ `?new=1` IS SET-UP FOR A WORKSPACE THAT DOES NOT EXIST YET (2026-10-13),
   * from "Create workspace". The same page, on its workspace step with an
   * empty name and none of the current workspace's domains or progress;
   * Continue creates the workspace and carries on here. It needs Clerk to
   * create anything, so without it this is ordinary set-up.
   */
  const clerkOn = Boolean(process.env.CLERK_PUBLISHABLE_KEY)
  // ⚠ FROM COOKIES, NOT THE URL - the query is only read for a page reached by
  // Polar's own redirect, and `ArrivalQuery` then clears it. See lib/arrival.ts.
  const checkoutId = await readArrival(ARRIVAL.checkout, query.checkout_id)
  const published = await readArrival(ARRIVAL.published, query.published)

  const [me, domains, plans, offers, person] = await Promise.all([
    tryApi<Me>("/console/me"),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<{ data: PlanSummary[] }>("/console/plans"),
    // ⚠ DOMAINS OFFERED TO THIS PERSON. Somebody who signed up from a transfer
    // email arrives here, and the domain they came for belongs on the domain
    // step. A failure hides the offers rather than the page.
    tryApi<{ data: TransferOffer[] }>("/console/transfers"),
    // The snippet's `name` is the person's own first name. Without Clerk
    // (the local preview) there is none, and the snippet says Ada.
    process.env.CLERK_PUBLISHABLE_KEY ? currentUser().catch(() => null) : null,
  ])

  /*
   * ⚠ NO WORKSPACE IS THE START OF SET-UP, NOT A FAILURE (#325). Nobody is
   * given one at sign-up any more, so somebody fresh from sign-up lands here
   * with none: the workspace step, empty, and naming it (or picking Personal)
   * is what creates it. Nothing else on this page has anything to show yet.
   */
  const noWorkspace = clerkOn && !me.ok && me.error.name === "no_workspace"
  const creating = noWorkspace || (query.new === "1" && clerkOn)

  if (!me.ok && !noWorkspace) {
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
        <ButtonLink href="/onboarding" variant="secondary" size="sm">
          Try again
        </ButtonLink>
      </main>
    )
  }

  const billing: BillingState = me.ok ? me.data.billing : NO_BILLING
  const tenantOf = me.ok ? me.data.tenant : null

  /*
   * ⚠ THE DOMAIN THE VERIFY AND SEND STEPS ARE ABOUT, READ IN FULL so they can
   * show its records and events live (2026-10-03): the newest one still being
   * verified, or else the first verified one. A failed read leaves those steps
   * without it rather than taking the page down.
   */
  const list = domains.ok ? domains.data.data : []
  const pending = list
    .filter((d) => d.status !== "verified")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const focusSummary = pending[0] ?? list.find((d) => d.status === "verified") ?? null
  const focus = focusSummary
    ? await tryApi<Domain>(`/console/domains/${encodeURIComponent(focusSummary.id)}`)
    : null

  /*
   * ⚠ THE DOMAIN STEPS AS A RELOAD LEFT THEM (2026-10-04), from set-up's own
   * draft cookie and rebuilt the way /domains/new rebuilds its own - the
   * created domain read again, the lookup run here. See lib/add-domain-draft.
   */
  const jar = await cookies()
  const domainDraft = await restoreDraft(
    draftFor(jar.get(DRAFT_COOKIES.onboarding.name)?.value, tenantOf?.id ?? ""),
  )

  const resumeStep = creating
    ? "workspace"
    : stepFor(jar.get(ONBOARDING_STEP_COOKIE)?.value, tenantOf?.id ?? "")

  const justPublished = creating
    ? 0
    : ownPublished(published, domains.ok ? domains.data.data : [])

  const data: OnboardingData = {
    me: me.ok ? me.data : null,
    tenantOf,
    billing,
    domains: creating ? [] : list,
    focus: !creating && focus?.ok ? focus.data : null,
    domainDraft: creating ? null : domainDraft,
    offers: offers.ok ? offers.data.data : [],
    userEmail: me.ok
      ? me.data.user.email
      : (person?.primaryEmailAddress?.emailAddress ?? null),
    firstName: person?.firstName ?? null,
    plans: plans.ok ? plans.data.data : [],
    checkoutId,
    resumeStep: resumeStep ?? "workspace",
    justPublished,
    creating,
    noWorkspace,
    clerkOn,
  }

  return <OnboardingView shape={onboardingShape.of(data)} data={data} />
}

/** Billing for a workspace that does not exist yet: nothing. */
const NO_BILLING: BillingState = {
  plan: null,
  subscription: null,
  anchor: null,
  overage_enabled: false,
  storage_bytes: null,
}

/**
 * How many of the domains the DNS callback just published belong to this
 * workspace.
 *
 * ⚠ A BARE NUMBER - THE OLD COOKIE FORMAT - COUNTS AS NOTHING. It cannot say
 * whose publish it was, and a missing green banner is a far smaller wrong
 * than announcing another account's records.
 */
function ownPublished(raw: string | null, domains: DomainSummary[]): number {
  if (!raw) return 0
  const ours = new Set(domains.map((d) => d.id))
  return raw.split(",").filter((id) => ours.has(id)).length
}
