import { draw, remainingOf } from "./balance.js"
import { windowFor } from "./interval.js"
import { meterKeyOf } from "./key.js"
import { entitlementFor } from "./plan.js"
import type { Allowance } from "./balance.js"
import type { ResetWindow } from "./interval.js"
import type { Entitlement } from "./plan.js"
import type {
  AssignmentStore,
  LevelStore,
  RecordResult,
  UsageEvent,
  UsageStore,
} from "./ports.js"

/**
 * The meter: the two questions, answered against the ports.
 *
 * ⚠ IT ORCHESTRATES, IT DOES NOT PERFORM. No `fetch`, no driver, no `Date.now()`
 * — the storage arrives as an adapter and the current time arrives as an
 * argument. That is what lets the same object answer a quota check inside
 * `POST /emails` on the box today and inside a Durable Object at the edge later,
 * with the adapters swapped and nothing here rewritten.
 *
 * ⚠ AND IT ROUTES ON THE ENTITLEMENT'S KIND, WHICH IS THE ONLY PLACE THAT
 * DIFFERENCE LIVES. A consumable feature has a window and its usage is summed
 * from the ledger; a continuous one has no window at all and its usage is read
 * as a level from wherever the things exist. Everything after that — the
 * arithmetic, the outcomes, the overage rule — is identical, which is why
 * `draw()` is shared rather than duplicated per kind.
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
  /**
   * Accepted, and part of it is billable. ⚠ Accepted WHOLE — see `draw`.
   */
  | {
      status: "overage"
      included: number
      billable: number
      resetsAt: Date | null
    }
  | {
      status: "exceeded"
      remaining: number
      shortfall: number
      resetsAt: Date | null
    }
  /**
   * ⚠ THE OUTCOME THAT IS NOT A POLITE WAY OF SAYING `exceeded`. The tenant has
   * no plan, or their plan grants nothing for this feature. Both are
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

/**
 * The whole picture for one feature, for something that is REPORTING rather
 * than deciding.
 *
 * ⚠ THIS EXISTS BECAUSE `check` CANNOT ANSWER IT, AND THAT IS NOT A FLAW IN
 * `check`. Enforcement needs one number — is there room for this request — and
 * every number it publishes is shaped for that: `remaining` is clamped at zero
 * because a negative one ends up in an `X-RateLimit-Remaining` header, and a
 * zero-unit request is always allowed because refusing it would report a quota
 * error for an operation that consumes nothing. Both are right. Both make
 * `check({ requested: 0 })` a LOSSY way to ask "how much have they used": a
 * tenant at 60,000 against a 50,000 allowance is indistinguishable from one at
 * exactly 50,000, so a usage page built on it can never draw the overdraft it
 * exists to show.
 *
 * ⚠ IT IS NOT A SECOND IMPLEMENTATION. It resolves the same entitlement through
 * the same `resolve`, reads usage through the same ports and the same window,
 * and reports the same `remaining` arithmetic. What it adds is the two facts
 * enforcement discards: the allowance itself, and usage UNCLAMPED.
 */
export type BalanceOutcome =
  | {
      status: "ok"
      /** The plan's grant. `"unlimited"` is a value, not a very large number. */
      allowance: Allowance
      /**
       * ⚠ TRUE USAGE, AND DELIBERATELY NOT CLAMPED. It can exceed `allowance` —
       * by design when the plan bills overage, and after a downgrade when a
       * continuous level is above the new plan's line. A dashboard that hides
       * that is hiding the number somebody opened it to see.
       */
      used: number
      /** What enforcement would say is left. Clamped at zero, like `check`. */
      remaining: number
      /** Whether this tenant's plan bills past the line rather than refusing. */
      overage: boolean
      /** `null` for a continuous feature: no reset, so no window. */
      window: ResetWindow | null
    }
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
  /**
   * Usage, allowance and window in one read, for reporting. See
   * `BalanceOutcome` — it decides nothing and must never be used to.
   */
  balanceOf(input: {
    tenantId: string
    featureId: string
    at: Date
    shard?: number
  }): Promise<BalanceOutcome>
  /**
   * The window a tenant's feature is currently in, or `null`.
   *
   * ⚠ `null` FOR A CONTINUOUS FEATURE AS WELL AS FOR AN UNENTITLED ONE, and the
   * caller must not read the first as the second. A domain limit has no window
   * because it has no reset, which is not the same as having no plan.
   */
  windowOf(input: {
    tenantId: string
    featureId: string
    at: Date
  }): Promise<ResetWindow | null>
}

export interface MeterDeps {
  assignments: AssignmentStore
  usage: UsageStore
  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE THROWS RATHER THAN DEGRADING. A deployment that
   * meters only consumable features needs no level source at all, so requiring
   * one would force every call site to invent a fake. But resolving a
   * continuous entitlement without one is a wiring mistake, and the two ways to
   * be quiet about it are both worse than an exception: answering `unentitled`
   * blames the customer's plan for our misconfiguration, and answering `0`
   * grants an unlimited number of mailboxes to everybody.
   */
  levels?: LevelStore
}

export function createMeter({ assignments, usage, levels }: MeterDeps): Meter {
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
      // ⚠ BOTH HALVES, AND THE PLAN'S IS THE ONE THAT CAN SAY NO. A tenant who
      // switched overage on does not thereby get a fourth domain.
      overage: entitlement.overage === "billable" && assignment.overageEnabled,
      window: windowOfEntitlement(entitlement, assignment.anchor, at),
    }
  }

  /**
   * How much of a feature a tenant has used, by the entitlement's own rule.
   *
   * ⚠ ONE READER FOR BOTH CALLERS, WHICH IS THE WHOLE REASON `balanceOf` IS
   * SAFE TO ADD. Enforcement and reporting asking the same ports the same
   * question in two places is how a dashboard comes to say 40,000 of 50,000
   * while the send path refuses the next message.
   */
  async function usedFor(
    entitlement: Entitlement,
    tenantId: string,
    featureId: string,
    window: ResetWindow | null,
    shard: number,
  ): Promise<number> {
    const key = meterKeyOf(tenantId, featureId, shard)

    if (entitlement.kind === "continuous") {
      if (levels === undefined) {
        throw new Error(
          `no level store configured, but ${featureId} is a continuous feature`,
        )
      }
      return levels.levelOf(key)
    }

    // ⚠ THE READ IS SCOPED TO THE WINDOW, NOT TO "SINCE THE LAST RESET". There
    // is no last reset: nothing resets anything, the window simply moves. An
    // event whose `sent_at` lands before `window.start` — a late flush from the
    // far side of a boundary — belongs to the window it happened in and is
    // correctly excluded from this one.
    return usage.usedIn(key, window!)
  }

  /** `null` for a continuous feature: it has no reset, so it has no window. */
  function windowOfEntitlement(
    entitlement: Entitlement,
    anchor: Date,
    at: Date,
  ): ResetWindow | null {
    if (entitlement.kind === "continuous") return null
    return windowFor({
      anchor,
      interval: entitlement.interval,
      intervalCount: entitlement.intervalCount,
      at,
    })
  }

  return {
    async check({ tenantId, featureId, requested, at, shard = 0 }) {
      const resolved = await resolve(tenantId, featureId, at)
      if (!resolved.ok) return { status: "unentitled", reason: resolved.reason }

      const { entitlement, window, overage } = resolved
      const used = await usedFor(entitlement, tenantId, featureId, window, shard)

      const outcome = draw({
        allowance: entitlement.allowance,
        used,
        requested,
        overage,
      })
      const resetsAt = window?.end ?? null

      return outcome.status === "overage"
        ? {
            status: "overage",
            included: outcome.included,
            billable: outcome.billable,
            resetsAt,
          }
        : { ...outcome, resetsAt }
    },

    async record({ tenantId, featureId, events, shard = 0 }) {
      // ⚠ NO ENTITLEMENT LOOKUP HERE, ON PURPOSE. The mail has already gone; a
      // plan that cannot be resolved must not be able to lose the record of it.
      // Usage is a fact about what happened, and it is written whether or not we
      // can currently say what it was allowed to be — which is also what lets
      // the reconciler find a tenant whose plan was never assigned.
      //
      // ⚠ AND A CONTINUOUS FEATURE IS NEVER RECORDED HERE. Its level lives
      // where the things live; writing events for it would create the second
      // copy this package exists to avoid.
      return usage.record(meterKeyOf(tenantId, featureId, shard), events)
    },

    async windowOf({ tenantId, featureId, at }) {
      const resolved = await resolve(tenantId, featureId, at)
      return resolved.ok ? resolved.window : null
    },

    async balanceOf({ tenantId, featureId, at, shard = 0 }) {
      const resolved = await resolve(tenantId, featureId, at)
      if (!resolved.ok) return { status: "unentitled", reason: resolved.reason }

      const { entitlement, window, overage } = resolved
      const used = await usedFor(entitlement, tenantId, featureId, window, shard)

      return {
        status: "ok",
        allowance: entitlement.allowance,
        // ⚠ `used` GOES OUT RAW AND `remaining` GOES OUT CLAMPED, which is the
        // one asymmetry in this object and the point of it. `remaining` is the
        // number enforcement publishes and must match it exactly; `used` is the
        // number a human reads, and the truth about it is sometimes "more than
        // you are allowed".
        used,
        remaining: remainingOf({ allowance: entitlement.allowance, used }),
        overage,
        window,
      }
    },
  }
}
