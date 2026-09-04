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
 * ⚠ AND IT IS PURE ARITHMETIC WITH NO CLOCK AND NO STORAGE. Everything that
 * makes a decision hard to test — when the window rolled over, what the store
 * said, who else was asking — is resolved by the caller and passed in. What is
 * left is small enough to be obviously right.
 */

/**
 * What a plan grants per window.
 *
 * ⚠ `"unlimited"` IS A DISTINCT VALUE, NOT A LARGE NUMBER. Sentinels like
 * `Infinity` or `-1` survive exactly until someone writes them to a database
 * column, renders them in a dashboard, or adds them to a rollover. Making it a
 * string forces every branch that could get it wrong to be written out.
 */
export type Allowance = number | "unlimited"

export interface DrawInput {
  allowance: Allowance
  /** Consumed in the current window. May exceed the allowance — see above. */
  used: number
  /** How many units this request wants. A batch of 500 asks once, for 500. */
  requested: number
}

export type DrawOutcome =
  | {
      status: "allowed"
      /** After this request. Zero, never negative. */
      remaining: number
    }
  | {
      status: "exceeded"
      remaining: number
      /** How many units short this request is. Always at least 1. */
      shortfall: number
    }

/**
 * Decide a single request against a window's allowance.
 *
 * ⚠ ALL-OR-NOTHING, NEVER PARTIAL. A batch of five hundred with three hundred
 * left is refused, not trimmed. Partial acceptance would mean answering a single
 * `POST /emails` with "some of these were accepted" and leaving the caller to
 * work out which two hundred recipients were dropped — an outcome no sender can
 * act on, and one that turns a quota error into silent data loss.
 *
 * ⚠ A REQUEST OF ZERO IS ALLOWED AND CHANGES NOTHING, including when the tenant
 * is already over. It is not a send, so refusing it would report a quota error
 * for an operation that consumes no quota.
 */
export function draw({ allowance, used, requested }: DrawInput): DrawOutcome {
  if (!Number.isFinite(requested) || requested < 0) {
    throw new RangeError(`requested must be a non-negative number, got ${requested}`)
  }

  if (allowance === "unlimited") {
    return { status: "allowed", remaining: Number.POSITIVE_INFINITY }
  }

  if (!Number.isFinite(allowance) || allowance < 0) {
    throw new RangeError(`allowance must be a non-negative number, got ${allowance}`)
  }

  const remaining = remainingOf({ allowance, used })

  if (requested === 0) return { status: "allowed", remaining }

  if (requested > remaining) {
    return { status: "exceeded", remaining, shortfall: requested - remaining }
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
