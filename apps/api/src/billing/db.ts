import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import type { SubscriptionState } from "./events.js"

/**
 * The subscription row, and the two questions asked of it.
 *
 * ⚠ WRITES GO THROUGH `withTenant`, READS FOR THE RECONCILER DO NOT. Every
 * write here carries a tenant id that came out of a signature-verified Polar
 * payload — the value we ourselves put on the checkout — so the ordinary row
 * level security path applies. The reconciler is the exception: it asks a
 * question about every tenant at once, which no tenant-scoped connection can
 * answer, so it goes through one narrow SECURITY DEFINER function instead. Same
 * shape as `sweep_stuck_messages` and `message_owner`, and the same rule: the
 * function answers exactly one question and returns the minimum.
 */

export interface SubscriptionRow {
  tenantId: string
  polarSubscriptionId: string
  planId: string
  status: string
  grantedPlanId: string | null
  eventAt: Date
}

/** What the console renders while a customer waits for a checkout to land. */
export interface CurrentPlan {
  /** The entitlement in force. `null` until a paid plan has been granted. */
  plan: string | null
  status: string | null
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
}

export interface SubscriptionOps {
  /**
   * Upserts the row, refusing to move it backwards in time.
   *
   * `stale` means a newer event has already been applied — the delivery that
   * produced this one overtook it in flight. It is a normal outcome, not a
   * failure, and the caller must not treat it as one.
   */
  record(state: SubscriptionState): Promise<"applied" | "stale">
  /**
   * Records that Autumn now holds this entitlement.
   *
   * ⚠ SCOPED TO THE EXACT EVENT THAT WAS GRANTED FOR. If a newer event landed
   * between the write and the Autumn call, this marks nothing — the row still
   * reads as needing a grant, and the reconciler picks it up. Marking it
   * regardless would record a plan we never actually attached.
   */
  markGranted(tenantId: string, planId: string, eventAt: Date): Promise<void>
  /** Every tenant's current subscription. The reconciler's only read. */
  snapshot(): Promise<SubscriptionRow[]>
  /**
   * One tenant's plan, for the console.
   *
   * ⚠ IT REPORTS `granted_plan_id`, NOT `plan_id`. What the customer can
   * actually do is what Autumn was told, and showing the plan they bought
   * before the entitlement landed is how a dashboard says "Pro" to somebody who
   * is still being refused at the send path.
   */
  current(tenantId: string): Promise<CurrentPlan>
}

export function subscriptionOps(db: Database): SubscriptionOps {
  return {
    async record(state) {
      return withTenant(db, state.tenantId, async (tx) => {
        // ⚠ ALIASED `s` SO THE GUARD CAN NAME THE EXISTING ROW. Inside `ON
        // CONFLICT DO UPDATE`, `excluded` is the incoming row and the table's
        // own name is the stored one; without the alias the predicate reads as
        // though it compares a column to itself.
        //
        // ⚠ AND THE GUARD IS ON THE UPDATE, NOT IN THE APPLICATION. Reading the
        // row, comparing timestamps and then writing is two statements with a
        // gap, and two webhook deliveries land in that gap regularly enough to
        // matter — Polar retries in parallel with its own next event.
        const rows = (await tx.execute(sql`
          insert into core.subscriptions as s (
            tenant_id, polar_subscription_id, polar_customer_id, polar_product_id,
            plan_id, status, cancel_at_period_end, current_period_end, event_at
          ) values (
            ${state.tenantId}::uuid,
            ${state.polarSubscriptionId},
            ${state.polarCustomerId},
            ${state.polarProductId},
            ${state.planId},
            ${state.status},
            ${state.cancelAtPeriodEnd},
            ${state.currentPeriodEnd?.toISOString() ?? null}::timestamptz,
            ${state.eventAt.toISOString()}::timestamptz
          )
          on conflict (tenant_id) do update set
            polar_subscription_id = excluded.polar_subscription_id,
            polar_customer_id     = excluded.polar_customer_id,
            polar_product_id      = excluded.polar_product_id,
            plan_id               = excluded.plan_id,
            status                = excluded.status,
            cancel_at_period_end  = excluded.cancel_at_period_end,
            current_period_end    = excluded.current_period_end,
            event_at              = excluded.event_at,
            updated_at            = now()
          where s.event_at < excluded.event_at
          returning s.tenant_id
        `)) as unknown as { tenant_id: string }[]

        // ⚠ `granted_plan_id` IS DELIBERATELY NOT TOUCHED BY THE UPDATE. It
        // records what Autumn was last told, so leaving it behind is what makes
        // a plan change visible as a discrepancy the reconciler can find.
        return rows.length > 0 ? "applied" : "stale"
      })
    },

    async markGranted(tenantId, planId, eventAt) {
      await withTenant(db, tenantId, async (tx) => {
        await tx.execute(sql`
          update core.subscriptions
             set granted_plan_id = ${planId},
                 granted_at      = now(),
                 updated_at      = now()
           where tenant_id = ${tenantId}::uuid
             and event_at  = ${eventAt.toISOString()}::timestamptz
        `)
      })
    },

    async current(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = (await tx.execute(sql`
          select granted_plan_id, status, cancel_at_period_end, current_period_end
            from core.subscriptions
           where tenant_id = ${tenantId}::uuid
           limit 1
        `)) as unknown as {
          granted_plan_id: string | null
          status: string
          cancel_at_period_end: boolean
          current_period_end: string | Date | null
        }[]

        const row = rows[0]
        // No row is not an error: it is every tenant who has never bought
        // anything, which is most of them. The free plan is attached at signup
        // by `ensureCustomer`, not recorded here.
        if (!row) {
          return {
            plan: null,
            status: null,
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
          }
        }

        return {
          plan: row.granted_plan_id,
          status: row.status,
          cancelAtPeriodEnd: row.cancel_at_period_end,
          currentPeriodEnd: toDate(row.current_period_end),
        }
      })
    },

    async snapshot() {
      const rows = (await db.execute(sql`
        select tenant_id, polar_subscription_id, plan_id, status,
               granted_plan_id, event_at
          from core.subscriptions_snapshot()
      `)) as unknown as {
        tenant_id: string
        polar_subscription_id: string
        plan_id: string
        status: string
        granted_plan_id: string | null
        event_at: string | Date
      }[]

      return rows.map((r) => ({
        tenantId: r.tenant_id,
        polarSubscriptionId: r.polar_subscription_id,
        planId: r.plan_id,
        status: r.status,
        grantedPlanId: r.granted_plan_id,
        eventAt: toDate(r.event_at) ?? new Date(0),
      }))
    },
  }
}

/** postgres-js hands back a Date for timestamptz; a mock or a JSON path may not. */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}
