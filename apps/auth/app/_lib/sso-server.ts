import "server-only"
import { randomBytes } from "node:crypto"
import type { NextRequest } from "next/server"

/**
 * The SSO bridge's browser half, server side (#337). See the API's
 * routes/sso.ts and identity/bridge.ts for what each step proves.
 *
 * ⚠ TWO httpOnly `__Host-` COOKIES, AND NO PAGE SCRIPT EVER SEES EITHER:
 *
 *   - `__Host-i10_sso`: the browser-binding value, drawn here when a sign-in
 *     starts. The API keeps only its hash on the attempt; finishing the
 *     sign-in or swapping the handoff code needs it again, which a callback
 *     URL forwarded to another machine cannot supply. SameSite=Lax so it
 *     comes back on the IdP's top-level redirect to us (OIDC, #338); a SAML
 *     POST binding (#339) is cross-site and will need its own answer.
 *   - `__Host-i10_sso_handoff`: the secret the API hands back with the ticket,
 *     presented at `/sso/bind`. Strict: only our own pages ever send it.
 *
 * The page sees the one-time code (in the URL fragment, which no server and
 * no log is sent) and the sixty-second ticket, nothing else.
 */

export const BINDING_COOKIE = "__Host-i10_sso"
export const HANDOFF_COOKIE = "__Host-i10_sso_handoff"

export function newBinding(): string {
  return randomBytes(32).toString("base64url")
}

export function bindingCookie(value: string): string {
  return `${BINDING_COOKIE}=${value}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`
}

export function handoffCookie(value: string): string {
  return `${HANDOFF_COOKIE}=${value}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Strict`
}

export function clearCookies(response: Response): void {
  for (const name of [BINDING_COOKIE, HANDOFF_COOKIE])
    response.headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; Secure`,
    )
}

export function readCookie(request: NextRequest, name: string): string | null {
  const value = request.cookies.get(name)?.value
  return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null
}

/** Where a refused or broken sign-in lands: the continue page shows why. */
export function failedUrl(request: NextRequest, message: string): URL {
  const url = new URL("/sso/continue", request.url)
  url.hash = new URLSearchParams({ error: message }).toString()
  return url
}

/**
 * Whether a GET that starts an SSO sign-in came from us: our own pages
 * (same-site, which covers dash.* and auth.*) or the address bar (`none`).
 *
 * ⚠ NEVER FROM ANOTHER SITE. A link on somebody else's page that starts a
 * sign-in through THEIR connection would end with this browser signed in to
 * their account (login CSRF). Browsers that send no Sec-Fetch-Site at all are
 * let through: they predate the header, and the binding cookie still holds.
 */
export function startedByUs(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site")
  return (
    site === null || site === "same-origin" || site === "same-site" || site === "none"
  )
}
