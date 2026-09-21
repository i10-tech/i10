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
  /**
   * A plan change Polar has accepted and will apply at the period boundary.
   *
   * ⚠ IT IS WHAT MAKES A DOWNGRADE VISIBLE BEFORE IT HAPPENS. `plan` above is
   * still the plan they hold and are still paying for — deliberately, because
   * they keep it until the period ends — so without this the console has
   * nothing to distinguish "downgrade accepted" from "nothing happened".
   */
  scheduledPlan: string | null
  scheduledAt: Date | null
  /**
   * Polar's id for the subscription, or `null` if there is none.
   *
   * ⚠ IT IS HERE SO A PLAN CHANGE HAS SOMETHING TO PATCH, and it is the one
   * field on this object that is not for rendering. A tenant with `null` here
   * has never bought anything — they go through checkout, not through an
   * update, and `PATCH` on a subscription that does not exist is a 404 nobody
   * can act on.
   */
  polarSubscriptionId: string | null
}

export interface SubscriptionOps {
  /**
   * Upserts the row, refusing to move it backwards in time.
   *
   * `stale` means a newer event has already been applied — the delivery that
   * produced this one overtook it in flight. It is a normal outcome, not a
   * failure, and the caller must not treat it as one.
   */
  record(
    state: SubscriptionState,
    options?: {
      /**
       * Take this subscription id from whatever tenant currently holds it.
       *
       * ⚠ SET ONLY BY THE POST-CHECKOUT PATH, AND WITHOUT IT THE RECLAIM
       * DEADLOCKS. `polar_subscription_id` is UNIQUE, deliberately — two
       * tenants pointing at one subscription is one payment entitling two
       * accounts. But when somebody re-signs up, Polar reuses their customer
       * and keeps its stale `external_id`, so the WEBHOOK binds the brand-new
       * subscription to the OLD, dead tenant moments before the checkout page
       * tries to bind it to the live one — and that insert then dies on the
       * constraint, is caught, and the plan never lands.
       *
       * ⚠ IT IS SAFE PRECISELY BECAUSE A SUBSCRIPTION ID HAS EXACTLY ONE
       * BUYER. Polar creates it from one checkout, and that checkout names one
       * tenant in metadata WE wrote. So this does not decide between two
       * claimants — it corrects a binding made from a field Polar does not
       * maintain, using the one it echoes back unchanged.
       *
       * ⚠ AND THE WEBHOOK MUST NEVER PASS IT. That path attributes by
       * `external_id` alone; letting it reassign would let a stale id take a
       * row back off the tenant that actually paid, once a month, for ever.
       */
      reassign?: boolean
    },
  ): Promise<"applied" | "stale">
  /**
   * Records that the entitlement now holds this plan.
   *
   * ⚠ SCOPED TO THE EXACT EVENT THAT WAS GRANTED FOR. If a newer event landed
   * between the write and the grant, this marks nothing — the row still
   * reads as needing a grant, and the reconciler picks it up. Marking it
   * regardless would record a plan we never actually attached.
   */
  markGranted(tenantId: string, planId: string, eventAt: Date): Promise<void>
  /** Every tenant's current subscription. The reconciler's only read. */
  snapshot(): Promise<SubscriptionRow[]>
  /**
   * Records that Polar has accepted a cancellation, now.
   *
   * ⚠ IT EXISTS BECAUSE THE WEBHOOK IS TOO LATE TO BE THE ONLY WRITER. Polar
   * takes the cancellation synchronously and confirms it an event later, and
   * `plan-change` wrote nothing in between — so the console refreshed onto a
   * row that still said "active, not cancelling". The page went on showing Pro
   * with no end date, the free card stayed enabled because it is disabled by
   * exactly this flag, and pressing it again sent a second cancel that Polar
   * refused with "check the payment method" about a card that was fine.
   *
   * ⚠ IT SETS THE FLAG AND NOTHING ELSE. The end date, the status and the plan
   * are Polar's to state and already sit on the row from the last event;
   * inventing a period end here would put a date on screen that Polar might not
   * agree with, which is worse than the flag arriving a moment early.
   *
   * ⚠ AND THE WEBHOOK STILL OVERWRITES IT, WHICH IS THE POINT RATHER THAN A
   * RACE. `record` is authoritative; this is a local note of something we just
   * asked for and were told was accepted, correct for exactly as long as it
   * takes the truth to arrive.
   */
  noteCancelling(tenantId: string): Promise<void>
  /**
   * ⚠ THE MIRROR OF `noteCancelling`, AND IT EXISTS FOR THE SAME REASON: the
   * webhook confirming it is an event away, and until it lands the console
   * would keep showing "Ending" for a subscription Polar has already
   * un-marked.
   */
  noteResuming(tenantId: string): Promise<void>
  /**
   * One tenant's plan, for the console.
   *
   * ⚠ IT REPORTS `granted_plan_id`, NOT `plan_id`. What the customer can
   * actually do is what the entitlement records, and showing the plan they bought
   * before the entitlement landed is how a dashboard says "Pro" to somebody who
   * is still being refused at the send path.
   */
  current(tenantId: string): Promise<CurrentPlan>
}

export function subscriptionOps(db: Database): SubscriptionOps {
  return {
    async record(state, options) {
      return withTenant(db, state.tenantId, async (tx) => {
        if (options?.reassign) {
          /*
           * ⚠ IN THE SAME TRANSACTION AS THE INSERT BELOW, so there is no
           * window where the id belongs to nobody and a concurrent webhook can
           * claim it back.
           *
           * ⚠ AND IT IS A DELETE RATHER THAN AN UPDATE BECAUSE THE OTHER ROW
           * HAS NOTHING LEFT TO SAY. It records that a tenant holds this
           * subscription, which is the thing being corrected; keeping it with
           * the id stripped out would leave a row claiming a plan with no
           * subscription behind it, which is the shape the reconciler reports
           * as `orphaned` and a human then has to dismiss.
           *
           * ⚠ `withTenant` SCOPES THIS TO THE NEW TENANT, WHOSE POLICY CANNOT
           * SEE THE OLD ROW — so it runs through the same SECURITY DEFINER
           * discipline as everything else that crosses a tenant boundary. See
           * migration 0047.
           */
          await tx.execute(sql`
            select core.release_subscription(
              ${state.polarSubscriptionId}, ${state.tenantId}::uuid
            )
          `)
        }

        // ⚠ ALIASED `s` SO THE GUARD CAN NAME THE EXISTING ROW. Inside `ON
        // CONFLICT DO UPDATE`, `excluded` is the incoming row and the table's
        // own name is the stored one; without the alias the predicate reads as
        // though it compares a column to itself.
        //
        // ⚠ AND THE GUARD IS ON THE UPDATE, NOT IN THE APPLICATION. Reading the
        // row, comparing timestamps and then writing is two statements with a
        // gap, and two webhook deliveries land in that gap regularly enough to
        // matter — Polar retries in parallel with its own next event.
        //
        // ⚠ THE SECOND DISJUNCT IS WHAT MAKES A DELIVERY RETRY ABLE TO REPAIR A
        // FAILED GRANT, AND IT IS NOT DEFENSIVE. A redelivery carries the SAME
        // `event_at`, so under `<` alone it answered "stale" and returned
        // before `ensureCustomer` — meaning that when the grant threw,
        // every one of Polar's retries was discarded and the only repair left
        // was the reconciler, up to half an hour later. Observed twice on real
        // events: once on the first payment, once on the first cancellation.
        //
        // ⚠ AND THE CONDITION IS THE GRANT, NOT `granted_at is null`. That was
        // the first attempt at this and it was wrong: it only catches a row
        // that has NEVER been granted. A cancellation arrives on a row already
        // granted to `pro`, so `granted_at` is set-but-stale and every retry of
        // the DOWNGRADE was still discarded — the failure mode that leaves a
        // revoked customer entitled.
        //
        // Comparing `granted_plan_id` to what this event entitles is exact: it
        // is the same question the reconciler asks, asked at the webhook. Never
        // granted is `null is distinct from 'free'` → true. Already granted to
        // this plan → false, so a genuine duplicate stays idempotent. An older
        // event is still refused by the first disjunct.
        const rows = (await tx.execute(sql`
          insert into core.subscriptions as s (
            tenant_id, polar_subscription_id, polar_customer_id, polar_product_id,
            plan_id, status, cancel_at_period_end, current_period_end, event_at,
            scheduled_plan_id, scheduled_at
          ) values (
            ${state.tenantId}::uuid,
            ${state.polarSubscriptionId},
            ${state.polarCustomerId},
            ${state.polarProductId},
            ${state.planId},
            ${state.status},
            ${state.cancelAtPeriodEnd},
            ${state.currentPeriodEnd?.toISOString() ?? null}::timestamptz,
            ${state.eventAt.toISOString()}::timestamptz,
            ${state.scheduledPlanId},
            ${state.scheduledAt?.toISOString() ?? null}::timestamptz
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
            -- ⚠ OVERWRITTEN INCLUDING WITH NULL, WHICH IS THE HALF THAT MATTERS.
            -- A scheduled change disappears from Polar's payload the moment it
            -- is applied or superseded; keeping the old value where the new one
            -- is null would leave the console announcing a downgrade that has
            -- already happened, for ever.
            scheduled_plan_id     = excluded.scheduled_plan_id,
            scheduled_at          = excluded.scheduled_at,
            updated_at            = now()
          where s.event_at < excluded.event_at
             or (s.event_at = excluded.event_at
                 and s.granted_plan_id is distinct from ${state.entitledPlanId})
          returning s.tenant_id
        `)) as unknown as { tenant_id: string }[]

        // ⚠ `granted_plan_id` IS DELIBERATELY NOT TOUCHED BY THE UPDATE. It
        // records what the entitlement was last moved to, so leaving it behind is what makes
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

    async noteResuming(tenantId) {
      await withTenant(db, tenantId, async (tx) => {
        // ⚠ ONLY WHERE IT WAS MARKED. Clearing the flag on a row that never
        // had it set is a write that says a change happened when none did.
        await tx.execute(sql`
          update core.subscriptions
             set cancel_at_period_end = false,
                 updated_at = now()
           where tenant_id = ${tenantId}::uuid
             and cancel_at_period_end = true
        `)
      })
    },

    async noteCancelling(tenantId) {
      await withTenant(db, tenantId, async (tx) => {
        /*
         * ⚠ ONLY WHILE THE ROW STILL READS AS LIVE. A subscription already
         * marked has nothing to learn from this, and re-marking one would put
         * "ending on" back on screen for somebody whose plan ended last month.
         */
        await tx.execute(sql`
          update core.subscriptions
             set cancel_at_period_end = true,
                 updated_at = now()
           where tenant_id = ${tenantId}::uuid
             and cancel_at_period_end = false
        `)
      })
    },

    async current(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = (await tx.execute(sql`
          select granted_plan_id, status, cancel_at_period_end, current_period_end,
                 scheduled_plan_id, scheduled_at, polar_subscription_id
            from core.subscriptions
           where tenant_id = ${tenantId}::uuid
           limit 1
        `)) as unknown as {
          granted_plan_id: string | null
          status: string
          cancel_at_period_end: boolean
          current_period_end: string | Date | null
          scheduled_plan_id: string | null
          scheduled_at: string | Date | null
          polar_subscription_id: string | null
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
            scheduledPlan: null,
            scheduledAt: null,
            polarSubscriptionId: null,
          }
        }

        return {
          plan: row.granted_plan_id,
          status: row.status,
          cancelAtPeriodEnd: row.cancel_at_period_end,
          currentPeriodEnd: toDate(row.current_period_end),
          scheduledPlan: row.scheduled_plan_id,
          scheduledAt: toDate(row.scheduled_at),
          polarSubscriptionId: row.polar_subscription_id,
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
