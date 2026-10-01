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
