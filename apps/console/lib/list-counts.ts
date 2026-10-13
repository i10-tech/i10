/**
 * The cookie side of the remembered list counts - plain, so the app layout
 * (a server component) can read them. See components/list/remembered-counts.
 */

export const countCookie = (key: string) => `i10-count-${key}`

/** The most rows a skeleton draws: past a screenful more is just noise. */
export const MAX_SKELETON_ROWS = 10

/** Cookie values `<tenantId>:<count>` for this tenant, as `{ key: count }`. */
export function parseCounts(
  cookies: { name: string; value: string }[],
  tenantId: string,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const cookie of cookies) {
    if (!cookie.name.startsWith("i10-count-")) continue
    const value = decodeURIComponent(cookie.value)
    const cut = value.lastIndexOf(":")
    if (cut <= 0 || value.slice(0, cut) !== tenantId) continue
    const count = Number(value.slice(cut + 1))
    if (Number.isInteger(count) && count >= 0)
      out[cookie.name.slice("i10-count-".length)] = count
  }
  return out
}
