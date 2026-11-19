import { defineView } from "./harness"
import { email, iso, retext, rows } from "./fixtures"

// ⚠ LOADED AFTER harness.tsx HAS MOCKED `server-only` (see cases-lists.tsx).
const { previewFor } = await import("@/lib/preview")
const { OverviewView } = await import("@/components/overview-view")
const { overviewShape } = await import("@/lib/shapes/overview")
const { MailboxesView } = await import("@/components/mailboxes-view")
const { mailboxesShape } = await import("@/lib/shapes/mailboxes")
const { AccountView } = await import("@/components/account-view")
const { accountShape } = await import("@/lib/shapes/account")
const { SettingsGeneralView } = await import("@/components/settings-general-view")
const { settingsShape } = await import("@/lib/shapes/settings")
const { TeamView } = await import("@/components/team-view")
const { teamShape } = await import("@/lib/shapes/team")
const { UnsubscribePageView } = await import("@/components/unsubscribe-page-view")
const { unsubscribePageShape } = await import("@/lib/shapes/unsubscribe-page")
const { UsageView } = await import("@/components/usage-view")
const { usageShape } = await import("@/lib/shapes/usage")
const { BillingView } = await import("@/components/billing-view")
const { billingShape } = await import("@/lib/shapes/billing")

import type { OverviewData } from "@/lib/shapes/overview"
import type {
  BillingState,
  Me,
  Overview,
  PlanSummary,
  SendingHealth,
  SendingStatus,
} from "@/lib/types"
import type { UsageData } from "@/lib/shapes/usage"
import type { BillingData } from "@/lib/shapes/billing"
import type { SettingsData } from "@/lib/shapes/settings"

/** What the preview API answers for `path`, typed by the caller. */
const api = <T,>(path: string, query?: Record<string, string | number>) =>
  previewFor(path, query) as T

const healthy: SendingStatus = {
  status: "enabled",
  cause: null,
  changed_at: null,
  health: "healthy",
  findings: [],
}

const capacity = (level: 0 | 80 | 100) => ({
  members: level === 100 ? 5 : 4,
  invitations: 0,
  limit: 5,
  free: level === 100 ? 0 : 1,
  full: level === 100,
  reasons: [],
  can_upgrade: true,
  personal: false,
  patterns: [],
  alert: { level, alerted_at: null },
})

const overviewData =
  (over: Partial<OverviewData> = {}, recent = 5) =>
  (tag: string): OverviewData => ({
    overview: api<Overview>("/console/overview", { days: 30 }),
    recent: rows(recent, (i) => email(tag, i)) as OverviewData["recent"],
    sendingStatus: healthy,
    capacity: null,
    sendingHealth: { ...healthy, ...api<SendingHealth>("/console/sending-health") },
    suggestions: false,
    days: 30,
    ...over,
  })

const me = () => api<Me>("/console/me")
const usage = () =>
  api<Pick<UsageData, "usage" | "limits" | "billing" | "members">>("/console/usage")
const plans = () => api<{ data: PlanSummary[] }>("/console/plans").data

export const PAGE_VIEWS = [
  defineView({
    route: "/",
    pathname: "/",
    View: OverviewView,
    shape: overviewShape,
    cases: [
      { name: "no recent sends", fixture: overviewData({}, 0) },
      { name: "one recent send", fixture: overviewData({}, 1) },
      { name: "many recent sends", fixture: overviewData({}, 8) },
      {
        name: "sending paused (status banner)",
        fixture: overviewData({
          sendingStatus: {
            ...healthy,
            status: "disabled",
            cause: "complaints",
            health: "paused",
            changed_at: iso(1),
          },
        }),
      },
      {
        name: "member limit reached (capacity banner)",
        fixture: overviewData({ capacity: capacity(100) }),
      },
      {
        name: "both banners, 7 days",
        fixture: overviewData({
          days: 7,
          capacity: capacity(80),
          sendingStatus: { ...healthy, health: "at_risk" },
        }),
      },
    ],
  }),

  defineView({
    route: "/mailboxes",
    pathname: "/mailboxes",
    View: MailboxesView,
    shape: mailboxesShape,
    cases: [{ name: "the page", fixture: () => ({}) }],
  }),

  defineView({
    route: "/account",
    pathname: "/account",
    View: AccountView,
    shape: accountShape,
    cases: [
      {
        name: "no sign-in provider configured (the only state outside Clerk)",
        fixture: () => ({
          settings: { providers: [], passkeys: false, minLength: 8 },
          billing: null,
          clerkEnabled: false,
        }),
      },
    ],
  }),

  defineView({
    route: "/settings",
    pathname: "/settings",
    View: SettingsGeneralView,
    shape: settingsShape,
    cases: [
      {
        name: "general (no Clerk)",
        fixture: (tag): SettingsData => ({
          tenant: { ...me().tenant!, name: `${tag} workspace` },
          billing: me().billing,
          access: me().access,
          clerkEnabled: false,
        }),
      },
    ],
  }),

  defineView({
    route: "/settings/team",
    pathname: "/settings/team",
    View: TeamView,
    shape: teamShape,
    cases: [{ name: "no Clerk", fixture: () => ({ clerkEnabled: false }) }],
  }),

  defineView({
    route: "/settings/unsubscribe-page",
    pathname: "/settings/unsubscribe-page",
    View: UnsubscribePageView,
    shape: unsubscribePageShape,
    cases: [{ name: "the page", fixture: () => ({}) }],
  }),

  defineView({
    route: "/settings/usage",
    pathname: "/settings/usage",
    View: UsageView,
    shape: usageShape,
    cases: [
      { name: "the workspace's usage", fixture: () => usage() },
      { name: "no seat meter", fixture: () => ({ ...usage(), members: null }) },
      {
        name: "no limits, no features",
        fixture: () => ({ ...usage(), limits: [], usage: [] }),
      },
    ],
  }),

  defineView({
    route: "/settings/billing",
    pathname: "/settings/billing",
    View: BillingView,
    shape: billingShape,
    cases: [
      {
        name: "free plan, no subscription",
        fixture: (): BillingData => ({
          billing: { ...usage().billing, subscription: null },
          plans: plans(),
          checkoutId: null,
          scheduledName: null,
        }),
      },
      {
        name: "active subscription",
        fixture: (): BillingData => ({
          billing: activeBilling(),
          plans: plans(),
          checkoutId: null,
          scheduledName: null,
        }),
      },
      {
        name: "downgrade scheduled",
        fixture: (): BillingData => ({
          billing: scheduledBilling(),
          plans: plans(),
          checkoutId: null,
          scheduledName: "Free",
        }),
      },
      {
        name: "just checked out",
        fixture: (): BillingData => ({
          billing: activeBilling(),
          plans: plans(),
          checkoutId: "chk_1",
          scheduledName: null,
        }),
      },
    ],
  }),
]

function activeBilling(): BillingState {
  const billing = usage().billing
  const paid = plans().find((p) => p.rank > 0)!
  return {
    ...billing,
    plan: paid,
    subscription: {
      status: "active",
      plan_id: paid.id,
      cancel_at_period_end: false,
      current_period_end: iso(-20),
      scheduled_plan_id: null,
      scheduled_at: null,
      polar_customer_id: "cus_1",
    },
  }
}

function scheduledBilling(): BillingState {
  const billing = activeBilling()
  return {
    ...billing,
    subscription: {
      ...billing.subscription!,
      scheduled_plan_id: "free",
      scheduled_at: iso(-20),
    },
  }
}

export { retext }
