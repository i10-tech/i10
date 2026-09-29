import { desc, eq, isNull, or } from "drizzle-orm"
import type { Meter } from "@repo/metering"
import { withTenant, type Database } from "../db/client.js"
import { describeErrorChain } from "../errors.js"
import { planAssignments, plans, subscriptions, tenantStorage } from "../db/core.js"
import {
  MAILBOX_DOMAINS,
  MAILBOXES,
  SENDING_DOMAINS,
  STORAGE,
} from "../metering/levels.js"
import type { SendingTierStore } from "../metering/tiers.js"

/**
 * What the console shows on the usage and billing pages.
 *
 * ⚠ THE NUMBERS COME FROM THE METER, NOT FROM A QUERY WRITTEN HERE. The whole
 * point of packages/metering is that one object answers "how much of this has
 * this tenant used" for every feature, consumable or continuous, and a second
 * implementation on the read side would drift from the one that ENFORCES the
 * limit. The failure mode is specific and awful: a dashboard that says 40,000
 * of 50,000 while the send path refuses the next message.
 *
 * ⚠ AND IT ASKS `balanceOf`, NOT `check({ requested: 0 })`. It used to ask the
 * second, and the second CANNOT ANSWER THIS QUESTION. A zero-unit request is
 * always allowed - it consumes nothing, so refusing it would report a quota
 * error for a non-event - and the `remaining` it publishes is clamped at zero so
 * that no customer ever reads "-1,204 remaining". Both rules are right for
 * enforcement, and together they make a tenant at 60,000 of 50,000 indis-
 * tinguishable from one at exactly 50,000. This page exists to show the first
 * case. `balanceOf` reports usage unclamped alongside the allowance, resolving
 * the same entitlement through the same ports, so there is still exactly one
 * implementation of "how much has this tenant used".
 */

/** The features the console reports on, in the order it renders them. */
export const REPORTED_FEATURES = [
  { id: "emails", label: "Emails", unit: "" },
  { id: SENDING_DOMAINS, label: "Sending domains", unit: "" },
  { id: MAILBOX_DOMAINS, label: "Mailbox domains", unit: "" },
  { id: MAILBOXES, label: "Mailboxes", unit: "" },
  { id: STORAGE, label: "Mailbox storage", unit: "bytes" },
] as const

export interface FeatureUsage {
  feature_id: string
  label: string
  unit: string
  /**
   * ⚠ NOT CLAMPED TO `allowance`. Being past the line is the fact somebody
   * opens this page to check, whether because they bought overage or because a
   * downgrade left them holding more domains than the new plan grants.
   */
  used: number
  /**
   * Units included.
   *
   * ⚠ NULL MEANS TWO DIFFERENT THINGS AND `status` IS WHAT SEPARATES THEM: with
   * `ok` it means UNLIMITED, and the console draws no bar, because a bar with no
   * end claims there is one. With `unentitled` or `unreadable` it means we have
   * no allowance to show.
   */
  allowance: number | null
  /** What is left, clamped at zero - the same number enforcement publishes. */
  remaining: number | null
  resets_at: string | null
  /**
   * Whether this workspace's plan BILLS past the allowance rather than refusing.
   *
   * ⚠ A PROPERTY OF THE PLAN, NOT OF THIS READING. It decides whether the
   * console renders an overdraft as an invoice line or as a wall, and those are
   * opposite things to tell somebody.
   */
  overage: boolean
  /**
   * `ok` - metered normally.
   * `unentitled` - the plan grants nothing for this feature. OUR bug, usually.
   * `unreadable` - the meter threw. Shown as a dash, never as a zero.
   */
  status: "ok" | "unentitled" | "unreadable"
}

/**
 * One sending limit: a window of time and how much of it has been used, like
 * Claude's "current session" and "weekly" rows.
 *
 * ⚠ A SEND IS REFUSED WHEN ANY ONE OF THEM IS FULL, SO THEY ARE SHOWN
 * TOGETHER. A free workspace has two - 100 a day from its plan, and a monthly
 * line from its sending tier (#165) - and the one that binds is whichever is
 * closer to full. A paid plan has one, and its other rows say so rather than
 * disappearing, so the page reads the same for everybody.
 *
 * ⚠ ORDERED BY WINDOW LENGTH, AND NOT FIXED AT TWO. A plan with a weekly line
 * (or anything else `ResetInterval` can express) adds a row with no console
 * change.
 */
export interface SendingLimit {
  /** `day`, `week`, `month`, `year` or `lifetime`. */
  window: string
  /** `intervalCount` of the window: 3 with `month` is quarterly. */
  count: number
  /**
   * `plan` - the workspace's plan sets it.
   * `tier` - the free sending tier sets it (#165); `tier` names which.
   * `none` - nothing limits this window. Shown as "No daily limit".
   */
  source: "plan" | "tier" | "none"
  tier?: string
  used: number
  /** Null for `none`, and for an unlimited allowance. */
  allowance: number | null
  remaining: number | null
  resets_at: string | null
  /** The plan bills past the line instead of refusing. Never true for a tier. */
  overage: boolean
  /**
   * A free limit whose window has not opened: nothing sent since the last one
   * ended, so it starts with the next send and there is no reset to show.
   */
  starts_on_send: boolean
  /** `unreadable`: the meter threw. Shown as a dash, never as a zero. */
  status: "ok" | "unreadable"
}

export interface PlanSummary {
  id: string
  name: string
  rank: number
  source: string
  entitlements: {
    featureId: string
    kind: string
    allowance: number
    interval?: string
    overage?: string
  }[]
}

export interface BillingState {
  plan: PlanSummary | null
  /** Null for a tenant that has never bought anything. */
  subscription: {
    status: string
    plan_id: string
    cancel_at_period_end: boolean
    current_period_end: string | null
    /**
     * A plan change Polar has accepted and applies at the period boundary.
     *
     * ⚠ THE CONSOLE HAD NO WAY TO SHOW THAT A DOWNGRADE HAD BEEN ACCEPTED.
     * Downgrades are requested with `next_period` so the customer keeps what
     * they paid for, which means `plan_id` above still names the plan they are
     * leaving for the rest of the period - so the page said "Pro, renews on the
     * 4th" to somebody who had just pressed Downgrade, and the only
     * acknowledgement was a toast that disappeared.
     */
    scheduled_plan_id: string | null
    scheduled_at: string | null
    polar_customer_id: string
  } | null
  anchor: string | null
  overage_enabled: boolean
  storage_bytes: number | null
}

export interface UsageStore {
  usage(tenantId: string): Promise<FeatureUsage[]>
  /** The email sending limits, one per window (see `SendingLimit`). */
  limits(tenantId: string): Promise<SendingLimit[]>
  billing(tenantId: string): Promise<BillingState>
  catalog(tenantId: string): Promise<PlanSummary[]>
}

export interface UsageDeps {
  db: Database
  meter: Meter
  /**
   * The free workspaces' tier ceiling (#165). With it, a free workspace's usage
   * gains an "Emails this month" row naming its tier; paid ones never do.
   */
  tiers?: { meter: Meter; store: Pick<SendingTierStore, "current"> }
  now?: () => Date
  log?: { warn: (o: object, m: string) => void }
}

export function usageStore({
  db,
  meter,
  tiers,
  now = () => new Date(),
  log,
}: UsageDeps): UsageStore {
  return {
    async usage(tenantId) {
      const at = now()

      /*
       * ⚠ ONE `Promise.all` AND ONE `allSettled` SEMANTIC, NOT A LOOP THAT
       * AWAITS. Five features is five independent reads; awaiting them in
       * sequence makes the usage page five round trips deep for no reason.
       *
       * ⚠ AND ONE FEATURE THROWING MUST NOT TAKE THE PAGE DOWN. `storage.bytes`
       * in particular is a continuous feature whose level store is documented
       * as not readable yet (see metering/levels.ts), so it throws by design.
       * A plain `Promise.all` would turn that into a 500 on the whole usage
       * page; catching per feature renders four real numbers and one dash.
       */
      const reported = Promise.all(
        REPORTED_FEATURES.map(async (feature): Promise<FeatureUsage> => {
          const base = {
            feature_id: feature.id,
            label: feature.label,
            unit: feature.unit,
          }

          try {
            const balance = await meter.balanceOf({
              tenantId,
              featureId: feature.id,
              at,
            })

            if (balance.status === "unentitled") {
              /*
               * ⚠ `unentitled` IS REPORTED AS ITSELF AND NEVER AS "0 of 0". It
               * means the tenant holds no plan, or the plan grants nothing for
               * this feature - both of which are OUR misconfiguration. Rendering
               * it as a full meter would tell a customer who has sent nothing
               * that they are out of allowance, and they would go and upgrade,
               * which makes our bug invisible to us.
               */
              return {
                ...base,
                used: 0,
                allowance: null,
                remaining: null,
                resets_at: null,
                overage: false,
                status: "unentitled",
              }
            }

            // ⚠ UNLIMITED IS CARRIED AS A NULL ALLOWANCE, NOT AS `Infinity`.
            // `Infinity` does not survive JSON - it serialises as `null` anyway,
            // but only after every arithmetic on the way there has produced
            // `NaN` - and a very large number would draw a bar that is always
            // empty, which is a claim that an end exists somewhere off-screen.
            const allowance =
              balance.allowance === "unlimited" ? null : balance.allowance

            return {
              ...base,
              used: balance.used,
              allowance,
              remaining: allowance === null ? null : balance.remaining,
              resets_at: balance.window?.end?.toISOString() ?? null,
              overage: balance.overage,
              status: "ok",
            }
          } catch (error) {
            // ⚠ `describeErrorChain`, NOT `String(error)`. This exact line printed
            // "Failed query: select coalesce(sum(value)…" sixty-nine times in
            // production without once saying WHY the query failed - the driver's
            // reason was on `cause` and never made it to the log. See errors.ts.
            log?.warn(
              { err: describeErrorChain(error), tenantId, featureId: feature.id },
              "could not read usage for a feature",
            )
            return {
              ...base,
              used: 0,
              allowance: null,
              remaining: null,
              resets_at: null,
              overage: false,
              status: "unreadable",
            }
          }
        }),
      )
      return reported
    },

    async limits(tenantId) {
      return sendingLimits({ meter, tiers, log }, tenantId, now())
    },

    async billing(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const [assignment, subscription, storage] = await Promise.all([
          tx
            .select({
              planId: planAssignments.planId,
              anchor: planAssignments.anchor,
              overageEnabled: planAssignments.overageEnabled,
              plan: plans,
            })
            .from(planAssignments)
            .innerJoin(plans, eq(plans.id, planAssignments.planId))
            .where(eq(planAssignments.tenantId, tenantId))
            .limit(1),

          tx
            .select()
            .from(subscriptions)
            // ⚠ NEWEST BY EVENT TIME, NOT BY ROW ORDER. A tenant who has
            // upgraded twice has three rows, and Polar's events arrive out of
            // order often enough that "the last one inserted" is wrong.
            .orderBy(desc(subscriptions.eventAt))
            .limit(1),

          tx
            .select({ bytes: tenantStorage.bytes })
            .from(tenantStorage)
            .where(eq(tenantStorage.tenantId, tenantId))
            .limit(1),
        ])

        const assigned = assignment[0]
        const sub = subscription[0]

        return {
          plan: assigned ? toPlanSummary(assigned.plan) : null,
          subscription: sub
            ? {
                status: sub.status,
                plan_id: sub.planId,
                cancel_at_period_end: sub.cancelAtPeriodEnd,
                current_period_end: sub.currentPeriodEnd?.toISOString() ?? null,
                scheduled_plan_id: sub.scheduledPlanId,
                scheduled_at: sub.scheduledAt?.toISOString() ?? null,
                polar_customer_id: sub.polarCustomerId,
              }
            : null,
          anchor: assigned?.anchor.toISOString() ?? null,
          overage_enabled: assigned?.overageEnabled ?? false,
          storage_bytes: storage[0]?.bytes ?? null,
        }
      })
    },

    async catalog(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ THE POLICY ON `core.plans` ALREADY DOES THE FILTERING, AND THE
         * PREDICATE HERE IS BELT AND BRACES RATHER THAN THE CONTROL. 0012's
         * policy reads `tenant_id IS NULL OR tenant_id = current_setting(...)`,
         * so a custom plan built for somebody else is invisible at the database
         * regardless of what this query asks for. Writing the same condition
         * again makes the intent readable to somebody who has not read the
         * migration, and costs nothing.
         */
        const rows = await tx
          .select()
          .from(plans)
          .where(or(isNull(plans.tenantId), eq(plans.tenantId, tenantId)))
          .orderBy(plans.rank, plans.id)

        return rows.map(toPlanSummary)
      })
    },
  }
}

function toPlanSummary(plan: typeof plans.$inferSelect): PlanSummary {
  return {
    id: plan.id,
    name: plan.name,
    rank: plan.rank,
    source: plan.source,
    entitlements: (plan.entitlements ?? []).map((e) => {
      const raw = e as Record<string, unknown>
      return {
        featureId: String(raw.featureId ?? ""),
        // ⚠ `kind` DEFAULTS TO `consumable`, BECAUSE THE FIRST TWO PLANS WERE
        // SEEDED BEFORE THE DISCRIMINATOR EXISTED. 0012 wrote
        // `{"featureId":"emails","allowance":100,"interval":"day"}` with no
        // `kind`; 0014 introduced it. Anything with an interval is consumable,
        // and that is the shape those rows have.
        kind: typeof raw.kind === "string" ? raw.kind : "consumable",
        allowance: Number(raw.allowance ?? 0),
        ...(typeof raw.interval === "string" ? { interval: raw.interval } : {}),
        ...(typeof raw.overage === "string" ? { overage: raw.overage } : {}),
      }
    }),
  }
}

/** The windows every workspace is shown, whether or not anything limits them. */
const ALWAYS_SHOWN = ["day", "month"] as const

const WINDOW_ORDER = ["day", "week", "month", "year", "lifetime"]

/**
 * The email limits, from the same meters the send path enforces with: the
 * plan's, and for a free workspace the tier's (metering/tiers.ts).
 *
 * ⚠ A FAILED READ IS A ROW MARKED `unreadable`, NOT A MISSING ROW. A missing
 * daily row on a free workspace reads as "no daily limit", which is false and
 * is the worst thing this page could say by accident.
 */
async function sendingLimits(
  { meter, tiers, log }: Pick<UsageDeps, "meter" | "tiers" | "log">,
  tenantId: string,
  at: Date,
): Promise<SendingLimit[]> {
  const found: SendingLimit[] = []
  let planUnreadable = false

  const [plan, tier] = await Promise.all([
    meter.balanceOf({ tenantId, featureId: "emails", at }).catch((error: unknown) => {
      log?.warn(
        { err: describeErrorChain(error), tenantId },
        "could not read the plan's sending limit",
      )
      planUnreadable = true
      return null
    }),
    tiers
      ? Promise.all([
          tiers.meter.balanceOf({ tenantId, featureId: "emails", at }),
          tiers.store.current(tenantId),
        ]).catch((error: unknown) => {
          log?.warn(
            { err: describeErrorChain(error), tenantId },
            "could not read the sending tier's limit",
          )
          return null
        })
      : null,
  ])

  if (plan?.status === "ok" && plan.interval) {
    const allowance = plan.allowance === "unlimited" ? null : plan.allowance
    found.push({
      window: plan.interval,
      count: plan.intervalCount ?? 1,
      source: allowance === null ? "none" : "plan",
      used: plan.used,
      allowance,
      remaining: allowance === null ? null : plan.remaining,
      resets_at: plan.window?.end?.toISOString() ?? null,
      overage: plan.overage,
      starts_on_send: allowance !== null && plan.window === null,
      status: "ok",
    })
  }

  // ⚠ `unentitled` FROM THE TIER METER MEANS "NOT A FREE WORKSPACE", which is
  // exactly true of a paid one - no row, and the month says "no limit".
  if (tier) {
    const [balance, current] = tier
    if (
      balance.status === "ok" &&
      balance.interval &&
      balance.allowance !== "unlimited"
    ) {
      found.push({
        window: balance.interval,
        count: balance.intervalCount ?? 1,
        source: "tier",
        tier: current.tier,
        used: balance.used,
        allowance: balance.allowance,
        remaining: balance.remaining,
        resets_at: balance.window?.end?.toISOString() ?? null,
        overage: false,
        starts_on_send: balance.window === null,
        status: "ok",
      })
    }
  }

  // Every window always shown, filled with "no limit" when nothing sets it -
  // or with a dash when the plan could not be read, since it may set it.
  for (const window of ALWAYS_SHOWN) {
    if (found.some((l) => l.window === window && l.count === 1)) continue
    found.push({
      window,
      count: 1,
      source: "none",
      used: planUsedIn(window, plan),
      allowance: null,
      remaining: null,
      resets_at: null,
      overage: false,
      starts_on_send: false,
      status: planUnreadable ? "unreadable" : "ok",
    })
  }

  return found.sort(
    (a, b) =>
      WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window) ||
      a.count - b.count,
  )
}

/**
 * Usage to show on a window nothing limits: the plan's own count when the plan
 * measures that same window, else nothing we can honestly state.
 *
 * ⚠ ZERO RATHER THAN A SECOND QUERY. A "no daily limit" row on a paid plan
 * does not need a daily count, and computing one here would be the second
 * implementation of usage this file exists to avoid.
 */
function planUsedIn(
  window: string,
  plan: Awaited<ReturnType<Meter["balanceOf"]>> | null,
): number {
  return plan?.status === "ok" && plan.interval === window ? plan.used : 0
}
