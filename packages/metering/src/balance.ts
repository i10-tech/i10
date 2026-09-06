/**
 * Drawing down an allowance.
 *
 * ⚠ THIS IS THE GATE, AND THE GATE IS ALLOWED TO BE APPROXIMATE. The ledger in
 * Postgres is the exact one; this decides whether to let a request through in
 * the time a request can afford. Concretely that means two things the callers
 * must not assume away:
 *
 *   - `used` may exceed the allowance. A burst that raced a stale read, or a
 *     shard that drained unevenly, both land here as an overdraft. It is a
 *     number to report, not a state to reject as impossible.
 *   - Two callers may both be told "allowed" for the last unit. Whoever owns
 *     the counter decides how much that can happen; in a Durable Object it
 *     cannot, because the object is single-threaded, and that is the whole
 *     reason the gate lives there.
 *
 * ⚠ AND "APPROXIMATE" NOW COSTS THE CUSTOMER, NOT US. While the gate could only
 * refuse, a permissive gate meant unbilled revenue and the reconciler swept it
 * up. With `overage` enabled the gate never refuses, so the same imprecision
 * puts units on somebody's invoice. The tiering is still right — no invoice is
 * ever computed from this number, only from the ledger — but the bound on
 * "approximate" has to be stated before sharding, because sharding is what
 * makes it loose. See docs/decisions/metering.md.
 *
 * ⚠ AND IT IS PURE ARITHMETIC WITH NO CLOCK AND NO STORAGE. Everything that
 * makes a decision hard to test — when the window rolled over, what the store
 * said, who else was asking — is resolved by the caller and passed in. What is
 * left is small enough to be obviously right.
 */

/**
 * What a plan grants per window, or holds at once.
 *
 * ⚠ `"unlimited"` IS A DISTINCT VALUE, NOT A LARGE NUMBER. Sentinels like
 * `Infinity` or `-1` survive exactly until someone writes them to a database
 * column, renders them in a dashboard, or adds them to a rollover. Making it a
 * string forces every branch that could get it wrong to be written out.
 */
export type Allowance = number | "unlimited"

export interface DrawInput {
  allowance: Allowance
  /**
   * Consumed in the current window, or currently held. May exceed the
   * allowance — see above.
   */
  used: number
  /** How many units this request wants. A batch of 500 asks once, for 500. */
  requested: number
  /**
   * Whether units past the allowance are billed rather than refused.
   *
   * ⚠ ALREADY RESOLVED BY THE CALLER, AND THAT IS DELIBERATE. It is true only
   * when the PLAN permits overage for this feature and the TENANT has switched
   * it on; both halves are needed, and neither belongs in arithmetic. Defaults
   * to `false`, which is the safe direction: a caller that forgets gets a hard
   * cap rather than a surprise invoice.
   */
  overage?: boolean
}

export type DrawOutcome =
  | {
      status: "allowed"
      /** After this request. Zero, never negative. */
      remaining: number
    }
  /**
   * Accepted, and part of it is billable.
   *
   * ⚠ THE REQUEST IS STILL ACCEPTED WHOLE — THIS IS NOT PARTIAL ACCEPTANCE.
   * Five hundred asked for with three hundred included left is five hundred
   * sent, attributed as three hundred included and two hundred billable.
   * Acceptance is all-or-nothing; attribution is not, and conflating the two is
   * how a quota decision turns into silent data loss.
   */
  | {
      status: "overage"
      /** Nothing included is left, by definition. */
      remaining: 0
      /** Units of this request covered by the allowance. May be 0. */
      included: number
      /** Units of this request that will be billed. Always at least 1. */
      billable: number
    }
  | {
      status: "exceeded"
      remaining: number
      /** How many units short this request is. Always at least 1. */
      shortfall: number
    }

/**
 * Decide a single request against an allowance.
 *
 * ⚠ ALL-OR-NOTHING, NEVER PARTIAL. A batch of five hundred with three hundred
 * left and no overage is refused, not trimmed. Partial acceptance would mean
 * answering a single `POST /emails` with "some of these were accepted" and
 * leaving the caller to work out which two hundred recipients were dropped — an
 * outcome no sender can act on, and one that turns a quota error into silent
 * data loss.
 *
 * ⚠ A REQUEST OF ZERO IS ALLOWED AND CHANGES NOTHING, including when the tenant
 * is already over. It is not a send, so refusing it would report a quota error
 * for an operation that consumes no quota.
 */
export function draw({
  allowance,
  used,
  requested,
  overage = false,
}: DrawInput): DrawOutcome {
  if (!Number.isFinite(requested) || requested < 0) {
    throw new RangeError(`requested must be a non-negative number, got ${requested}`)
  }

  if (allowance === "unlimited") {
    // ⚠ NEVER `overage`. There is no allowance to be past, so there is nothing
    // to bill — and an unlimited feature that produced billable units would be
    // a contradiction somebody has to notice on an invoice.
    return { status: "allowed", remaining: Number.POSITIVE_INFINITY }
  }

  if (!Number.isFinite(allowance) || allowance < 0) {
    throw new RangeError(`allowance must be a non-negative number, got ${allowance}`)
  }

  const remaining = remainingOf({ allowance, used })

  if (requested === 0) return { status: "allowed", remaining }

  if (requested > remaining) {
    if (!overage) {
      return { status: "exceeded", remaining, shortfall: requested - remaining }
    }
    return {
      status: "overage",
      remaining: 0,
      included: remaining,
      billable: requested - remaining,
    }
  }

  return { status: "allowed", remaining: remaining - requested }
}

/**
 * What is left, clamped at zero.
 *
 * ⚠ CLAMPED, BECAUSE A NEGATIVE REMAINING IS A NUMBER THAT REACHES CUSTOMERS.
 * It goes in a `X-RateLimit-Remaining` header and onto a usage dashboard, and
 * "-1,204 remaining" reads as a bug in our product rather than as an overdraft
 * we already decided to tolerate. The overdraft is still visible where it
 * belongs — `used` against `allowance` in the ledger.
 */
export function remainingOf({
  allowance,
  used,
}: {
  allowance: Allowance
  used: number
}): number {
  if (allowance === "unlimited") return Number.POSITIVE_INFINITY
  return Math.max(0, allowance - used)
}
