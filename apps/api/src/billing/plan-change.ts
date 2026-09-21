import { eq, and, isNull, or } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { plans } from "../db/core.js"
import type { PolarClient, ProrationBehavior } from "./polar.js"
import type { SubscriptionOps } from "./db.js"
import type { Logger } from "./grants.js"

/**
 * Changing a plan, from our console rather than Polar's portal.
 *
 * ⚠ THE POINT IS NOT BRANDING — IT IS THAT PRORATION ONLY WORKS THIS WAY.
 * `polar/subscription/update.py` matches on `proration_behavior` and has no
 * upgrade/downgrade branch anywhere in it, so the behaviour everyone expects —
 * upgrades charged now, downgrades deferred to the period end — exists only if
 * the caller picks per direction. The customer portal always uses the
 * organisation default, and one default cannot be right for both.
 *
 * ⚠ AND NOTHING HERE GRANTS ANYTHING. This asks Polar to move the
 * subscription; the entitlement moves when Polar's webhook says it did, through
 * the one path in this repository that can grant a plan. A response from here
 * means "asked", not "done" — the console polls `GET /billing/plan`, the same
 * way it already does after a checkout.
 */

export type ChangeDirection = "upgrade" | "downgrade" | "same"

/**
 * ⚠ TIES ARE A SIDEWAYS MOVE, NOT AN UPGRADE. Two plans at the same rank
 * charge nothing and defer nothing — treating a tie as an upgrade would invoice
 * a customer for a change that cost them nothing.
 */
export function directionOf(fromRank: number, toRank: number): ChangeDirection {
  if (toRank > fromRank) return "upgrade"
  if (toRank < fromRank) return "downgrade"
  return "same"
}

/**
 * ⚠ THE WHOLE DECISION, IN ONE FUNCTION.
 *
 * - **Upgrade → `invoice`.** Applied now, difference charged now. The customer
 *   asked for more and gets it immediately; Polar's credits benefit swap makes
 *   the new allowance exact at the same moment.
 * - **Downgrade → `next_period`.** Scheduled to the period end, no credit
 *   issued. They keep what they paid for, and we do not refund time they
 *   already used.
 *
 * ⚠ AND IT IS ALSO WHAT STOPS THE OBVIOUS ABUSE. With immediate downgrades a
 * customer can upgrade on day 28, take the larger allowance, downgrade on day
 * 30 and be credited for the difference. Deferring the downgrade removes the
 * exit, which is why the allowance is deliberately not prorated either.
 *
 * ⚠ NEVER `reset`. It restarts Polar's billing anchor, and ours is fixed at
 * tenant creation and never moves — using it splits the invoice date from the
 * allowance refill date permanently.
 */
export function prorationFor(
  direction: Exclude<ChangeDirection, "same">,
): ProrationBehavior {
  return direction === "upgrade" ? "invoice" : "next_period"
}

export type ChangeOutcome =
  | { status: "requested"; direction: Exclude<ChangeDirection, "same">; plan: string }
  /** Already on it. Not an error, and not a Polar call. */
  | { status: "unchanged" }
  | { status: "rejected"; reason: string }
  /** Polar refused — most often a card that did not authorise. */
  | { status: "failed"; reason: string }

export interface PlanChangeDeps {
  db: Database
  polar: PolarClient
  subscriptions: SubscriptionOps
  /** Our plan id → Polar product id. The only plans that can be bought. */
  products: Record<string, string>
  /**
   * ⚠ THE ONE PLAN WITH NO POLAR PRODUCT, AND THE REASON THIS IS CONFIGURED
   * RATHER THAN INFERRED. "Moving to a plan we cannot sell" is the shape of
   * both *leaving* (correct, and the only way back to free) and a missing entry
   * in `POLAR_PRODUCTS` (a misconfiguration that must stay an error). Naming the
   * free plan explicitly is what tells those two apart; treating any absent
   * product as a cancellation would silently end somebody's subscription
   * because of a typo in an environment variable.
   */
  freePlanId: string
  log: Logger
}

export interface PlanChange {
  to(tenantId: string, planId: string): Promise<ChangeOutcome>
}

/** Catalogue plans, and this tenant's own custom ones. Nobody else's. */
async function rankOf(
  db: Database,
  tenantId: string,
  planId: string,
): Promise<number | null> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ rank: plans.rank })
      .from(plans)
      .where(
        and(
          eq(plans.id, planId),
          or(isNull(plans.tenantId), eq(plans.tenantId, tenantId)),
        ),
      )
      .limit(1)
    return row ? row.rank : null
  })
}

export function planChange(deps: PlanChangeDeps): PlanChange {
  return {
    async to(tenantId, planId) {
      /*
       * ⚠ LEAVING IS NOT BUYING, SO IT DOES NOT NEED A PRODUCT. The free plan
       * has none — there is nothing to charge for — and requiring one here is
       * what made "Downgrade to free" answer `No such plan: free` and leave a
       * paying customer with no way off a plan they no longer wanted. Cancelling
       * at the period end IS the move to free: the subscription lapses and the
       * tenant falls back to the included allowance.
       */
      const leaving = planId === deps.freePlanId

      // ⚠ THE PRODUCT COMES FROM OUR MAP, NEVER FROM THE REQUEST — the same
      // rule the checkout route already follows. A caller who could name a
      // Polar product id could name a one-cent one and move themselves to Pro,
      // and the webhook would grant it perfectly correctly.
      const productId = deps.products[planId]
      if (!productId && !leaving) {
        return { status: "rejected", reason: `No such plan: ${planId}.` }
      }

      const current = await deps.subscriptions.current(tenantId)
      if (!current.polarSubscriptionId) {
        // ⚠ NOTHING TO MOVE. A tenant with no subscription buys one through
        // checkout; `PATCH` on a subscription that does not exist is a 404 from
        // Polar and a confusing one to surface.
        return {
          status: "rejected",
          reason: "Start a checkout to subscribe before changing plan.",
        }
      }

      if (current.plan === planId) return { status: "unchanged" }

      const [fromRank, toRank] = await Promise.all([
        current.plan ? rankOf(deps.db, tenantId, current.plan) : 0,
        rankOf(deps.db, tenantId, planId),
      ])

      if (toRank === null) {
        return { status: "rejected", reason: `No such plan: ${planId}.` }
      }

      const direction = directionOf(fromRank ?? 0, toRank)
      if (direction === "same") {
        // Same rank, different id — a sideways move charges nothing, so there
        // is nothing for proration to decide and nothing to invoice.
        return { status: "unchanged" }
      }

      try {
        if (leaving) {
          await deps.polar.cancelSubscription(current.polarSubscriptionId)

          /*
           * ⚠ WRITTEN HERE, NOT LEFT TO THE WEBHOOK, AND THE GAP WAS VISIBLE TO
           * CUSTOMERS. Polar accepts the cancellation synchronously and
           * confirms it an event later; until this line existed the console
           * refreshed onto a row that still said "active, not cancelling". So
           * the page kept showing Pro with no end date, the free card stayed
           * enabled — it is disabled by precisely this flag — and pressing it
           * again produced "Polar could not apply the change. Check the
           * payment method." about a card that was perfectly fine.
           *
           * ⚠ AND IT IS AFTER THE CALL, SO A REFUSAL RECORDS NOTHING. Marking
           * first would leave a workspace believing it had cancelled because we
           * asked, which is the one direction this must never be wrong in.
           */
          await deps.subscriptions.noteCancelling(tenantId)
        } else {
          await deps.polar.updateSubscription({
            subscriptionId: current.polarSubscriptionId,
            productId: productId!,
            prorationBehavior: prorationFor(direction),
          })
        }
      } catch (error) {
        // ⚠ FOR `invoice`, POLAR APPLIES THE CHANGE ONLY IF THE PAYMENT
        // SUCCEEDS — so this is usually a declined card, and the subscription is
        // untouched. Reporting it as an outage would send the customer to
        // support instead of to their bank.
        deps.log.error(
          { err: error, tenantId, planId, direction },
          "plan change failed",
        )
        return {
          status: "failed",
          reason: "Polar could not apply the change. Check the payment method.",
        }
      }

      deps.log.info(
        { tenantId, from: current.plan, to: planId, direction },
        "plan change requested",
      )
      return { status: "requested", direction, plan: planId }
    },
  }
}
