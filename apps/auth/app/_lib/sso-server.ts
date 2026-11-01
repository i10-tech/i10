import "server-only"
import { randomBytes } from "node:crypto"
import type { NextRequest } from "next/server"
import { isAllowedOrigin } from "./redirect"

/**
 * The SSO bridge's browser half, server side (#337). See the API's
 * routes/sso.ts and identity/bridge.ts for what each step proves.
 *
 * ⚠ THREE httpOnly `__Host-` COOKIES, AND NO PAGE SCRIPT EVER SEES ANY:
 *
 *   - `__Host-i10_sso`: the browser-binding value, drawn here when a sign-in
 *     starts. The API keeps only its hash on the attempt; finishing the
 *     sign-in or swapping the handoff code needs it again, which a callback
 *     URL forwarded to another machine cannot supply. SameSite=Lax so it
 *     comes back on the IdP's top-level redirect to us (OIDC, #338).
 *   - `__Host-i10_sso_saml` (#339): the SAME binding value, set only when the
 *     sign-in is SAML, SameSite=None and ten minutes. The IdP answers with a
 *     cross-site form POST, on which no Lax cookie is sent; this one is, and
 *     only the ACS (`/sso/saml/acs/<id>`) ever reads it. Every other route
 *     reads the Lax cookie, so None widens nothing else. See sso.md 2.16.
 *   - `__Host-i10_sso_handoff`: the secret the API hands back with the ticket,
 *     presented at `/sso/bind`. Strict: only our own pages ever send it.
 *
 * The page sees the one-time code (in the URL fragment, which no server and
 * no log is sent) and the sixty-second ticket, nothing else.
 */

export const BINDING_COOKIE = "__Host-i10_sso"
export const HANDOFF_COOKIE = "__Host-i10_sso_handoff"
export const SAML_COOKIE = "__Host-i10_sso_saml"

export function newBinding(): string {
  return randomBytes(32).toString("base64url")
}

export function bindingCookie(value: string): string {
  return `${BINDING_COOKIE}=${value}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`
}

export function samlBindingCookie(value: string): string {
  return `${SAML_COOKIE}=${value}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=None`
}

export function handoffCookie(value: string): string {
  return `${HANDOFF_COOKIE}=${value}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Strict`
}

export function clearCookies(response: Response): void {
  for (const name of [BINDING_COOKIE, HANDOFF_COOKIE, SAML_COOKIE])
    response.headers.append(
      "Set-Cookie",
      `${name}=; Path=/; Max-Age=0; HttpOnly; Secure`,
    )
}

export function readCookie(request: NextRequest, name: string): string | null {
  const value = request.cookies.get(name)?.value
  return value && /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null
}

/**
 * Where a refused or broken sign-in lands: the continue page shows why.
 *
 * ⚠ A RELATIVE PATH, NEVER A URL BUILT FROM `request.url`. Behind the proxy
 * that is the server's bind address (`https://localhost:3004` in dev,
 * `http://0.0.0.0:3000` in the pod), not the host the browser asked for. The
 * browser resolves a relative Location against the URL it actually requested.
 * Nor is the Host header trusted to build an absolute one.
 */
export function failedUrl(message: string): string {
  return `/sso/continue#${new URLSearchParams({ error: message }).toString()}`
}

/** A redirect to a path (and hash) of this same app: relative, see `failedUrl`. */
export function redirectHere(pathAndHash: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: { Location: pathAndHash, "Cache-Control": "no-store" },
  })
}

/**
 * Whether a GET that starts an SSO sign-in came from us: our own pages
 * (same-site, which covers dash.* and auth.*) or the address bar (`none`).
 *
 * ⚠ NEVER FROM ANOTHER SITE. A link on somebody else's page that starts a
 * sign-in through THEIR connection would end with this browser signed in to
 * their account (login CSRF). Browsers that send no Sec-Fetch-Site at all are
 * let through: they predate the header, and the binding cookie still holds.
 *
 * ⚠ OR CROSS-SITE WITH OUR CONSOLE AS THE REFERER. Chromium labels a click
 * from dash.i10.localhost to auth.i10.localhost `cross-site` (measured
 * 2026-10-31, while sibling *.lab.localhost hosts are same-site), so the
 * header alone refused every start from the console. The Referer is set by the
 * browser and another site cannot make it ours; a missing one still refuses.
 */
export function startedByUs(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site")
  if (
    site === null ||
    site === "same-origin" ||
    site === "same-site" ||
    site === "none"
  )
    return true
  return site === "cross-site" && isAllowedOrigin(refererOrigin(request))
}

function refererOrigin(request: NextRequest): string | null {
  const referer = request.headers.get("referer")
  if (!referer) return null
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}
