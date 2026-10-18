/**
 * Invitation expiry and capacity, as the console words them (#327).
 *
 * ⚠ FORMATTING ONLY. Which zones a country uses comes from the API (some
 * browsers have no `Intl.Locale#getTimeZones`); every browser can format a
 * time in a named zone, which is all this does. The instant sent to the API
 * is one UTC moment; the zone only says how to word it.
 */

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
export const MIN_EXPIRY_MS = HOUR_MS
export const MAX_EXPIRY_MS = 7 * DAY_MS

/** "America/Argentina/Buenos_Aires" is "Buenos Aires". */
export function cityOf(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "UTC"
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ")
}

/** "3:00 PM" in that zone, or in the reader's own with none. */
export function clockIn(at: Date, zone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(at)
}

/** "GMT+2" for that zone at that instant. */
export function offsetIn(at: Date, zone: string): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT"
  )
}

/** "1 day 12 hours", "3 hours", "45 minutes": the two largest units. */
export function spanOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const parts: string[] = []
  if (days > 0) parts.push(unit(days, "day"))
  if (hours > 0) parts.push(unit(hours, "hour"))
  if (days === 0 && mins > 0) parts.push(unit(mins, "minute"))
  return parts.slice(0, 2).join(" ") || "less than a minute"
}

/** "2 days", "5 hours", "20 minutes": the largest unit, for a list row. */
export function roughly(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  if (minutes >= 1440) return unit(Math.floor(minutes / 1440), "day")
  if (minutes >= 60) return unit(Math.floor(minutes / 60), "hour")
  return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
}

/**
 * What the form says under the picker: "3:00 PM in Paris - 1 day 12 hours
 * from now, 2:00 PM your time". The last part only when the reader is
 * somewhere else.
 */
export function expirySummary(
  at: Date,
  zone: string,
  now: Date,
  yourZone?: string,
): string {
  const there = `${clockIn(at, zone)} in ${cityOf(zone)}`
  const left = `${spanOf(at.getTime() - now.getTime())} from now`
  const mine = yourZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const same = offsetIn(at, mine) === offsetIn(at, zone)
  return same
    ? `${there} - ${left}`
    : `${there} - ${left}, ${clockIn(at, mine)} your time`
}

/** A pending invitation's line: "Expires 15 Mar, 3:00 PM - in 2 days". */
export function expiresLine(at: Date, now: Date, zone?: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    ...(zone ? { timeZone: zone } : {}),
    day: "numeric",
    month: "short",
  }).format(at)
  const left = at.getTime() - now.getTime()
  if (left <= 0) return `Expired ${day}, ${clockIn(at, zone)}`
  return `Expires ${day}, ${clockIn(at, zone)} - in ${roughly(left)}`
}

// ── Wall clock in a zone <-> one instant ────────────────────────────────────

interface Wall {
  year: number
  /** 1 to 12. */
  month: number
  day: number
  hour: number
  minute: number
}

/** The wall clock in `zone` at `at`. */
export function wallIn(at: Date, zone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  }
}

/**
 * The instant at which `zone`'s wall clock reads `wall`.
 *
 * ⚠ TWO PASSES, BECAUSE THE OFFSET DEPENDS ON THE ANSWER. A first guess uses
 * the offset at the wall time read as UTC; near a daylight-saving change that
 * offset can be the wrong side of it, and the second pass corrects it.
 */
export function instantIn(wall: Wall, zone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const offsetAt = (t: number) => {
    const w = wallIn(new Date(t), zone)
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - t
  }
  let guess = asUtc - offsetAt(asUtc)
  guess = asUtc - offsetAt(guess)
  return new Date(guess)
}

/** "14:05" from a wall clock, for the time field. */
export const hhmm = (wall: Wall) =>
  `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`

/**
 * A quick pick: `ms` from now, on the time field's five-minute steps.
 *
 * ⚠ ROUNDED INWARD. Up for the short end, so "1 hour" is never under an hour;
 * down for the long end, so "7 days" is never over seven.
 */
export function quickPick(now: Date, ms: number): Date {
  const step = 5 * 60_000
  const raw = now.getTime() + ms
  const at =
    ms >= MAX_EXPIRY_MS ? Math.floor(raw / step) * step : Math.ceil(raw / step) * step
  return new Date(at)
}

/** Why an expiry cannot be used, or null. */
export function expiryProblem(at: Date | null, now: Date): string | null {
  if (!at || Number.isNaN(at.getTime())) return "Pick when it expires."
  const ahead = at.getTime() - now.getTime()
  if (ahead < MIN_EXPIRY_MS) return "An invitation has to last at least an hour."
  if (ahead > MAX_EXPIRY_MS) return "An invitation can last at most 7 days."
  return null
}

// ── Capacity ────────────────────────────────────────────────────────────────

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** What would make room, as one choice: "remove a member or upgrade". */
export function roomText(reasons: string[]): string {
  const items = (reasons.length > 0 ? reasons : ["Remove a member"]).map((r) =>
    r.toLowerCase(),
  )
  if (items.length === 1) return items[0]!
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`
}

/**
 * The warning on the invitation (or batch) that takes the last free spot,
 * naming the access domains it shuts out. The API's own copy is in
 * apps/api/src/console/capacity.ts; the two say the same thing.
 */
export function lastSpotWarning(input: {
  free: number
  adding: number
  patterns: string[]
}): string | null {
  if (input.adding <= 0 || input.free <= 0 || input.adding !== input.free) return null
  const who = [...new Set(input.patterns)].map((p) => `@${p}`)
  const first =
    input.adding === 1
      ? "This invitation takes the last spot."
      : "These invitations take the last spots."
  if (who.length === 0) return `${first} The workspace will be full.`
  return `${first} ${listOf(who)} sign-ups won't be able to join until a spot frees up.`
}

/** "10 members | 3 invitations | 7 free spots". */
export function seatsLine(seats: {
  members: number
  invitations: number
  free: number
}) {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  return [
    n(seats.members, "member"),
    n(seats.invitations, "invitation"),
    n(seats.free, "free spot"),
  ].join(" | ")
}
