/**
 * Durations for the session policy (#345): the API speaks whole seconds, the
 * screens speak minutes, hours and days.
 */

export type DurationUnit = "minutes" | "hours" | "days"

export const DURATION_UNITS: { unit: DurationUnit; seconds: number; label: string }[] =
  [
    { unit: "minutes", seconds: 60, label: "Minutes" },
    { unit: "hours", seconds: 3600, label: "Hours" },
    { unit: "days", seconds: 86400, label: "Days" },
  ]

const SECONDS: Record<DurationUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
}

/**
 * The largest unit a number of seconds is a whole count of, so 7200 is "2
 * hours" and 5400 is "90 minutes". A count that is not whole minutes keeps
 * its fraction (90 seconds is 1.5 minutes) rather than being rounded away.
 */
export function splitDuration(seconds: number): { value: number; unit: DurationUnit } {
  if (seconds > 0 && seconds % SECONDS.days === 0)
    return { value: seconds / SECONDS.days, unit: "days" }
  if (seconds > 0 && seconds % SECONDS.hours === 0)
    return { value: seconds / SECONDS.hours, unit: "hours" }
  return { value: seconds / SECONDS.minutes, unit: "minutes" }
}

/** A count and unit as whole seconds, or null for anything that is not a positive number. */
export function toSeconds(value: number, unit: DurationUnit): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * SECONDS[unit])
}

/** "8 hours", "1 day", "90 minutes". */
export function formatSeconds(seconds: number): string {
  const { value, unit } = splitDuration(seconds)
  const singular = unit.slice(0, -1)
  return `${trimNumber(value)} ${value === 1 ? singular : unit}`
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/** Which side of its bounds a number of seconds falls on, or null when it is inside. */
export function outsideBounds(
  seconds: number,
  bounds: { min: number; max: number },
): "below" | "above" | null {
  if (seconds < bounds.min) return "below"
  if (seconds > bounds.max) return "above"
  return null
}

/** "15 minutes to 90 days". */
export function formatBounds(bounds: { min: number; max: number }): string {
  return `${formatSeconds(bounds.min)} to ${formatSeconds(bounds.max)}`
}

/** A limit as the editor holds it: "no limit", or a count and a unit as typed. */
export interface LimitDraft {
  on: boolean
  value: string
  unit: DurationUnit
}

/**
 * The editor's starting state for a stored limit. With no limit the fields
 * still hold `fallback`, so turning it on offers a sensible number.
 */
export function draftOf(
  seconds: number | null,
  fallback: { value: number; unit: DurationUnit },
): LimitDraft {
  const { value, unit } = seconds === null ? fallback : splitDuration(seconds)
  return { on: seconds !== null, value: trimNumber(value), unit }
}

/** What the editor would send: seconds (or null for no limit), or why it cannot. */
export function draftSeconds(
  draft: LimitDraft,
  bounds: { min: number; max: number },
):
  | { ok: true; seconds: number | null }
  | { ok: false; reason: "empty" | "below" | "above" } {
  if (!draft.on) return { ok: true, seconds: null }
  const seconds =
    draft.value.trim() === "" ? null : toSeconds(Number(draft.value), draft.unit)
  if (seconds === null) return { ok: false, reason: "empty" }
  const outside = outsideBounds(seconds, bounds)
  return outside ? { ok: false, reason: outside } : { ok: true, seconds }
}
