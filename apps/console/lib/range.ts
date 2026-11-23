/**
 * The date ranges a list can be narrowed to, as `?days=`.
 *
 * ⚠ NOT IN THE TOOLBAR'S MODULE: that one is client code, and the server
 * pages turn `days` into the API's `from` themselves.
 */
export const RANGES = [
  { value: "1", label: "Last 24 hours" },
  { value: "3", label: "Last 3 days" },
  { value: "7", label: "Last 7 days" },
  { value: "15", label: "Last 15 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const

/** The start of a `?days=` range, as the API's `from`; nothing for "All time". */
export function rangeStart(days: string | undefined): string | undefined {
  if (!days || !RANGES.some((r) => r.value === days)) return undefined
  return new Date(Date.now() - Number(days) * 86_400_000).toISOString()
}

/**
 * `?days=all`: All time, chosen on purpose where a filter defaults to a range.
 * Not in `RANGES`, so `rangeStart` reads it as no bound.
 */
export const ALL_TIME = "all"

/**
 * The delivery log's range when `?days=` names none: the last 30 days while it
 * is filtered by an API key, else all time (undefined).
 *
 * ⚠ 30 DAYS UNDER A KEY FILTER (#507). No index leads with `api_key_id` on
 * `core.messages`, so a key filter reads the workspace's mail in the range and
 * keeps that key's: about 11 ms for the largest workspace on the scale seed
 * over 7 days, 190 ms and 1.2 GB over all time. An index would cost every
 * message three more index writes, for a filter used now and then. All time
 * stays one pick away in the menu (`ALL_TIME`).
 */
export function defaultEmailsRange(apiKeyId: string | undefined): string | undefined {
  return apiKeyId ? "30" : undefined
}
