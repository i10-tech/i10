import { draw } from "./balance.js"
import { windowFor } from "./interval.js"
import { meterKeyOf } from "./key.js"
import { entitlementFor } from "./plan.js"
import type { ResetWindow } from "./interval.js"
import type { AssignmentStore, RecordResult, UsageEvent, UsageStore } from "./ports.js"

/**
 * The meter: the two questions, answered against the ports.
 *
 * ⚠ IT ORCHESTRATES, IT DOES NOT PERFORM. No `fetch`, no driver, no `Date.now()`
 * — the storage arrives as an adapter and the current time arrives as an
 * argument. That is what lets the same object answer a quota check inside
 * `POST /emails` on the box today and inside a Durable Object at the edge later,
 * with the adapters swapped and nothing here rewritten.
 */

export interface CheckInput {
  tenantId: string
  featureId: string
  /** How many units this request wants. A batch of five hundred asks for 500. */
  requested: number
  /** The moment being asked about. Injected; never read from a clock here. */
  at: Date
  /** Always 0 today — see key.ts for why it is a parameter anyway. */
  shard?: number
}

export type CheckOutcome =
  | { status: "allowed"; remaining: number; resetsAt: Date | null }
  | {
      status: "exceeded"
      remaining: number
      shortfall: number
      resetsAt: Date | null
    }
  /**
   * ⚠ THE THIRD OUTCOME, AND IT IS NOT A POLITE WAY OF SAYING `exceeded`. The
   * tenant has no plan, or their plan grants nothing for this feature. Both are
   * misconfigurations on our side — a tenant that was never assigned a free
   * plan at signup, a feature id renamed out from under a running catalogue —
   * and both would otherwise surface to a customer as "you have used your
   * sending allowance" when they have sent nothing.
   *
   * Kept separate for the same reason `QuotaOutcome` in
   * apps/api/src/send/metering.ts keeps `unavailable` separate from `exceeded`:
   * the customer's correct response to one is to upgrade, and to the other is
   * to open a ticket. Deciding which of those to tell them is policy, and it is
   * made at the call site rather than smuggled in here.
   */
  | { status: "unentitled"; reason: string }

export interface RecordInput {
  tenantId: string
  featureId: string
  events: readonly UsageEvent[]
  shard?: number
}

export interface Meter {
  check(input: CheckInput): Promise<CheckOutcome>
  record(input: RecordInput): Promise<RecordResult>
  /** The window a tenant's feature is currently in. For dashboards and tests. */
  windowOf(input: {
    tenantId: string
    featureId: string
    at: Date
  }): Promise<ResetWindow | null>
}

export interface MeterDeps {
  assignments: AssignmentStore
  usage: UsageStore
}

export function createMeter({ assignments, usage }: MeterDeps): Meter {
  /** Resolves plan → entitlement → window, or explains why it could not. */
  async function resolve(tenantId: string, featureId: string, at: Date) {
    const assignment = await assignments.find(tenantId)
    if (assignment === null) {
      return { ok: false as const, reason: `tenant ${tenantId} holds no plan` }
    }

    const entitlement = entitlementFor(assignment.plan, featureId)
    if (entitlement === undefined) {
      return {
        ok: false as const,
        reason: `plan ${assignment.plan.id} grants no ${featureId}`,
      }
    }

    return {
      ok: true as const,
      entitlement,
      window: windowFor({
        anchor: assignment.anchor,
        interval: entitlement.interval,
        intervalCount: entitlement.intervalCount,
        at,
      }),
    }
  }

  return {
    async check({ tenantId, featureId, requested, at, shard = 0 }) {
      const resolved = await resolve(tenantId, featureId, at)
      if (!resolved.ok) return { status: "unentitled", reason: resolved.reason }

      const { entitlement, window } = resolved

      // ⚠ THE READ IS SCOPED TO THE WINDOW, NOT TO "SINCE THE LAST RESET". There
      // is no last reset: nothing resets anything, the window simply moves. An
      // event whose `sent_at` lands before `window.start` — a late flush from
      // the far side of a boundary — belongs to the window it happened in and is
      // correctly excluded from this one.
      const used = await usage.usedIn(meterKeyOf(tenantId, featureId, shard), window)
      const outcome = draw({ allowance: entitlement.allowance, used, requested })

      return { ...outcome, resetsAt: window.end }
    },

    async record({ tenantId, featureId, events, shard = 0 }) {
      // ⚠ NO ENTITLEMENT LOOKUP HERE, ON PURPOSE. The mail has already gone; a
      // plan that cannot be resolved must not be able to lose the record of it.
      // Usage is a fact about what happened, and it is written whether or not we
      // can currently say what it was allowed to be — which is also what lets
      // the reconciler find a tenant whose plan was never assigned.
      return usage.record(meterKeyOf(tenantId, featureId, shard), events)
    },

    async windowOf({ tenantId, featureId, at }) {
      const resolved = await resolve(tenantId, featureId, at)
      return resolved.ok ? resolved.window : null
    },
  }
}
