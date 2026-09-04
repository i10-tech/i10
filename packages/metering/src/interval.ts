/**
 * Reset windows.
 *
 * A metered allowance refills on a cycle, and everything else in this package
 * depends on one question: for a given moment, which window are we in and when
 * does it end? That is what this file answers.
 *
 * ⚠ THE WINDOW IS COMPUTED FROM THE ANCHOR, NEVER STORED AND ADVANCED. This is
 * the single most important decision in the file and it is a deliberate
 * divergence from Autumn, which keeps a `next_reset_at` column and steps it
 * forward by one interval each time its reset cron fires.
 *
 * Storing the boundary makes the cron load-bearing for correctness, and its
 * failure mode is silent. Autumn's `resetCustomerEntitlement` advances by
 * exactly one period regardless of how overdue the row is, so a cron that
 * missed three months restores one month of allowance and leaves `next_reset_at`
 * still in the past — a customer who is somehow both due for a reset and never
 * getting one.
 *
 * Deriving the window from a fixed anchor has no such state to corrupt. A
 * process that has been down for a year computes the same answer as one that
 * has been up the whole time, because the answer is a pure function of the
 * anchor and the clock. It also means a reset is not an event that must happen —
 * it is simply the moment the computed window changes, so `alarm()` in a Durable
 * Object schedules a convenience (flushing, notifications) rather than the
 * correctness of the balance itself.
 */

/**
 * How often an allowance refills.
 *
 * ⚠ `lifetime` IS NOT "VERY LONG", IT IS "NEVER". A lifetime allowance is a
 * total that is consumed once — credits bought as a pack, a trial's cap. It has
 * a window that starts at the anchor and never ends, and the arithmetic below
 * treats it as such rather than as an interval with a large number in it.
 */
export type ResetInterval = "day" | "week" | "month" | "year" | "lifetime"

/**
 * A half-open window: `start` inclusive, `end` exclusive.
 *
 * ⚠ HALF-OPEN, SO A SINGLE INSTANT BELONGS TO EXACTLY ONE WINDOW. With both
 * ends inclusive, an event landing precisely on a boundary is billable in two
 * periods at once, and the two sides of a reconciliation disagree by however
 * many events happened to fall on the tick.
 */
export interface ResetWindow {
  start: Date
  /** `null` for `lifetime`, which has no end. */
  end: Date | null
}

export interface WindowInput {
  /**
   * When this allowance began — the subscription start, or the moment the plan
   * was assigned. Every boundary is derived from it, so it must not drift once
   * chosen.
   */
  anchor: Date
  interval: ResetInterval
  /** e.g. `interval: "month", intervalCount: 3` is quarterly. Defaults to 1. */
  intervalCount?: number
  /** The moment being asked about. */
  at: Date
}

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/**
 * The window containing `at`.
 *
 * ⚠ `at` BEFORE `anchor` RETURNS THE FIRST WINDOW RATHER THAN THROWING. Clocks
 * disagree, and a customer whose plan was assigned by a server a few hundred
 * milliseconds ahead of the one now checking their quota must not get an
 * exception on their first send.
 */
export function windowFor({
  anchor,
  interval,
  intervalCount = 1,
  at,
}: WindowInput): ResetWindow {
  if (intervalCount < 1 || !Number.isInteger(intervalCount)) {
    throw new RangeError(
      `intervalCount must be a positive integer, got ${intervalCount}`,
    )
  }

  if (interval === "lifetime") return { start: new Date(anchor), end: null }

  const elapsed = periodsElapsed({ anchor, interval, intervalCount, at })
  return {
    start: addPeriods({ anchor, interval, intervalCount, periods: elapsed }),
    end: addPeriods({ anchor, interval, intervalCount, periods: elapsed + 1 }),
  }
}

/** When the allowance containing `at` refills. `null` for `lifetime`. */
export function resetsAt(input: WindowInput): Date | null {
  return windowFor(input).end
}

/**
 * How many whole periods have passed between `anchor` and `at`.
 *
 * Fixed-length intervals are division. Month and year are not: they have to
 * count calendar steps and then check whether the day-of-month has actually
 * been reached, because the last step may land after `at`.
 */
function periodsElapsed({
  anchor,
  interval,
  intervalCount,
  at,
}: Required<Omit<WindowInput, "interval">> & { interval: ResetInterval }): number {
  if (at.getTime() <= anchor.getTime()) return 0

  if (interval === "day" || interval === "week") {
    const span = (interval === "day" ? DAY_MS : WEEK_MS) * intervalCount
    return Math.floor((at.getTime() - anchor.getTime()) / span)
  }

  const monthsPerPeriod = (interval === "month" ? 1 : 12) * intervalCount
  const calendarMonths =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchor.getUTCMonth())

  // Floor rather than round: three months and twenty-nine days is three months.
  let periods = Math.floor(calendarMonths / monthsPerPeriod)

  // ⚠ THE CALENDAR-MONTH COUNT OVERSHOOTS WHEN THE DAY HAS NOT ARRIVED YET. An
  // anchor of the 20th asked about the 5th of the following month is zero whole
  // months, not one — the month number changed but the anniversary has not
  // happened. Comparing against the computed boundary is what catches it, and
  // doing it as a loop rather than a single correction handles the case where
  // clamping (below) moved the boundary by more than a day.
  while (
    periods > 0 &&
    addPeriods({ anchor, interval, intervalCount, periods }).getTime() > at.getTime()
  ) {
    periods -= 1
  }
  return periods
}

/**
 * `anchor` advanced by `periods` whole intervals.
 *
 * ⚠ THE ANCHOR DAY IS PRESERVED ACROSS SHORT MONTHS, AND THIS IS THE OTHER
 * DELIBERATE DIVERGENCE FROM AUTUMN. Their `addInterval` documents itself as
 * "preserves the anchor day (Stripe-compatible end-of-month behavior)" and then
 * computes `anchorDay` and `isMonthBased` and uses neither — it calls date-fns
 * `addMonths` on the *previous* boundary and returns.
 *
 * `addMonths` clamps, so stepping repeatedly walks the date backwards and never
 * recovers: 31 Jan → 28 Feb → 28 Mar → 28 Apr. A customer who subscribed on the
 * 31st silently migrates to the 28th, permanently, after one February.
 *
 * Because every boundary here is computed from the original anchor rather than
 * from the previous boundary, clamping is local to the short month: 31 Jan →
 * 28 Feb → 31 Mar. That is what Stripe does, and what their docstring says.
 */
function addPeriods({
  anchor,
  interval,
  intervalCount,
  periods,
}: Omit<WindowInput, "at" | "intervalCount"> & {
  intervalCount: number
  periods: number
}): Date {
  if (interval === "day" || interval === "week") {
    const span = (interval === "day" ? DAY_MS : WEEK_MS) * intervalCount
    return new Date(anchor.getTime() + span * periods)
  }

  const monthsPerPeriod = (interval === "month" ? 1 : 12) * intervalCount
  const target = anchor.getUTCMonth() + monthsPerPeriod * periods
  const year = anchor.getUTCFullYear() + Math.floor(target / 12)
  const month = ((target % 12) + 12) % 12

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), daysInMonth(year, month)),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  )
}

/** Day 0 of the next month is the last day of this one. */
const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
