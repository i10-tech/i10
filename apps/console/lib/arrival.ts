/**
 * One-off facts a page is told on arrival — "you just paid", "we just wrote
 * your records" — carried in cookies rather than in the URL.
 *
 * ⚠ THE ADDRESS BAR IS THE PAGE, NOT ITS NEWS. `?checkout_id=` and
 * `?published=` used to ride in the URL, so they sat in history, in every link
 * copied out of the page, and in the bar somebody was reading. A cookie scoped
 * to the page's own path carries the same fact to the server render without
 * showing it anywhere.
 *
 * ⚠ SHORT-LIVED, AND SCOPED TO THE PAGE THAT OWNS IT. A checkout id outlives a
 * reload — the banner is still polling — but not ten minutes, and it is never
 * sent to any other page. The published count is one-shot: the page that shows
 * it deletes it.
 *
 * Browser half; the server reads through ./arrival-server.ts.
 */

export const ARRIVAL = {
  checkout: "i10_checkout_id",
  published: "i10_published",
} as const

export type Arrival = (typeof ARRIVAL)[keyof typeof ARRIVAL]

/** The query parameter each cookie replaces, for pages reached by a redirect. */
export const ARRIVAL_PARAM: Record<Arrival, string> = {
  i10_checkout_id: "checkout_id",
  i10_published: "published",
}

const TEN_MINUTES = 600

export function setArrival(
  name: Arrival,
  value: string,
  path: string,
  maxAge = TEN_MINUTES,
): void {
  const secure = window.location.protocol === "https:" ? "; secure" : ""
  document.cookie = `${name}=${encodeURIComponent(value)}; path=${path}; max-age=${maxAge}; samesite=lax${secure}`
}

export function clearArrival(name: Arrival, path: string): void {
  setArrival(name, "", path, 0)
}
