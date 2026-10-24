/**
 * Where a setup link's token lives once the page has it (#340).
 *
 * ⚠ THE TOKEN IS A CREDENTIAL IN THE ADDRESS BAR, SO IT LEAVES IT AT ONCE. It
 * is read from the path (`/sso/setup/<token>`) or, if a link was made with a
 * fragment, from `#token=`; stored in sessionStorage (this tab only, gone when
 * it closes); and the address is replaced with `/sso/setup` so history, a
 * screenshot, a shared URL and the `Referer` of the next request no longer
 * hold it. A reload then finds it in sessionStorage.
 */

const KEY = "i10.sso.setup"
const SHAPE = /^i10_setup_[A-Za-z0-9_-]{43}$/

/** Only if storage is blocked: the token then lives in this page's memory. */
let memory: string | null = null

/** The token from a path or a fragment, or null. Pure, so it is tested. */
export function tokenFromLocation(pathname: string, hash: string): string | null {
  const segment = pathname.match(/^\/sso\/setup\/([^/]+)\/?$/)?.[1]
  if (segment && SHAPE.test(segment)) return segment
  const fragment = new URLSearchParams(hash.replace(/^#/, "")).get("token")
  return fragment && SHAPE.test(fragment) ? fragment : null
}

/** Moves the token out of the URL and returns it; or the one already kept; or null. */
export function takeToken(): string | null {
  const found = tokenFromLocation(window.location.pathname, window.location.hash)
  if (found) {
    try {
      window.sessionStorage.setItem(KEY, found)
    } catch {
      // Storage may be blocked; the token then lives only in this page's memory.
      memory = found
    }
    // Keep a test result's fragment, drop everything else.
    const result = new URLSearchParams(window.location.hash.replace(/^#/, "")).get(
      "sso_test",
    )
    window.history.replaceState(
      null,
      "",
      result ? `/sso/setup#sso_test=${result}` : "/sso/setup",
    )
    return found
  }
  try {
    const stored = window.sessionStorage.getItem(KEY)
    if (stored && SHAPE.test(stored)) return stored
  } catch {
    // fall through to memory
  }
  return memory
}
