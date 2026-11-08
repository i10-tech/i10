import "server-only"
import { randomBytes } from "node:crypto"
import type { NextRequest } from "next/server"
import { afterAuthUrl, allowedReturnUrl, isAllowedOrigin } from "./redirect"
import { connectionOf } from "./saml-server"

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

const FRAMED_DESTINATIONS = new Set(["iframe", "frame", "embed", "object"])

/**
 * Whether `POST /sso/start` came from our own interstitial page on this origin.
 *
 * ⚠ TIGHTER THAN `startedByUs`: only our interstitial submits a POST, so
 * `same-site` neighbours and `cross-site` (even with a console Referer) are
 * refused. `Sec-Fetch-Site` also checks ancestor frames per W3C Fetch Metadata,
 * and `Sec-Fetch-Dest` rejects embedded frame navigations as defense in depth
 * alongside `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
 */
export function submittedFromHere(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site")
  // ⚠ A BROWSER WITHOUT FETCH METADATA STILL SENDS `Origin` ON A FORM POST,
  // so there the Origin must be this host; a GET start has no such header.
  if (site === null) return sameHostOrigin(request)
  if (site !== "same-origin") return false
  const dest = request.headers.get("sec-fetch-dest")
  return dest === null || !FRAMED_DESTINATIONS.has(dest)
}

function sameHostOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin")
  const host = request.headers.get("host")
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Validates `login_hint` identically to `identity/model.ts`: one `@` with
 * non-empty parts, no whitespace or control characters, at most 254 characters,
 * lowercased. Duplicate parameters are dropped rather than guessed.
 */
export function readLoginHint(
  raw: string | readonly string[] | null | undefined,
): string | null {
  const value = Array.isArray(raw)
    ? raw.length === 1
      ? raw[0]
      : null
    : (raw as string | null | undefined)
  if (typeof value !== "string") return null
  const hint = value.trim().toLowerCase()
  if (hint.length === 0 || hint.length > 254) return null
  if (/[\s\p{Cc}]/u.test(hint)) return null
  const parts = hint.split("@")
  return parts.length === 2 && parts[0] && parts[1] ? hint : null
}

export type IssInput =
  { kind: "absent" } | { kind: "present"; value: string } | { kind: "invalid" }

/**
 * Reads OIDC Core Section 4 `iss` from query or form values.
 *
 * ⚠ EXACT, BOUNDED, SINGLE-VALUED. An empty `?iss=`, duplicate `?iss=a&iss=b`
 * parameter pollution, or a value past 2048 characters becomes `invalid`, which
 * maps to `""` on the wire so OIDC connections audit and refuse it while SAML
 * connections ignore it.
 */
export function readIss(raw: string | readonly string[] | null | undefined): IssInput {
  if (raw === undefined || raw === null) return { kind: "absent" }
  const values = Array.isArray(raw) ? raw : [raw]
  if (values.length === 0) return { kind: "absent" }
  if (values.length !== 1) return { kind: "invalid" }
  const value = values[0]!
  if (value.length === 0 || value.length > 2048) return { kind: "invalid" }
  return { kind: "present", value }
}

export function issWireValue(iss: IssInput): string | null {
  switch (iss.kind) {
    case "absent":
      return null
    case "present":
      return iss.value
    case "invalid":
      return ""
  }
}

/**
 * The validated outside-start parameters, read the same way from a query
 * string and from page props. `redirect_url` wins over OIDC `target_link_uri`.
 */
function readEntryParams(getAll: (name: string) => readonly string[]): {
  returnTo: string | null
  loginHint: string | null
  iss: string | null
} {
  const redirects = getAll("redirect_url")
  const targets = getAll("target_link_uri")
  const returnTo =
    redirects.length === 1
      ? allowedReturnUrl(redirects[0])
      : targets.length === 1
        ? allowedReturnUrl(targets[0])
        : null
  return {
    returnTo,
    loginHint: readLoginHint(getAll("login_hint")),
    iss: issWireValue(readIss(getAll("iss"))),
  }
}

export type SsoEntryDecision =
  | { action: "invalid" }
  | {
      action: "start"
      connection: string
      returnTo: string | null
      /** Set when `redirect_url` was explicitly supplied, normalized via `afterAuthUrl`. */
      forwardedRedirectUrl: string | null
      loginHint: string | null
      iss: string | null
    }
  | {
      action: "interstitial"
      connection: string
      returnTo: string | null
      loginHint: string | null
      iss: string | null
    }

/**
 * Decides what `GET /sso/<connection>` or `GET /sso/start` does before talking
 * to the API: start immediately when `startedByUs`, render the interstitial
 * when cross-site, or render the invalid-link page when `connection` is not a UUID.
 *
 * ⚠ `target_link_uri` IS TREATED ONLY AS A RETURN URL CANDIDATE THROUGH THE
 * `afterAuthUrl` ALLOWLIST; anything disallowed or duplicated is dropped silently.
 */
export function decideSsoEntry(
  request: NextRequest,
  rawConnection: string | null | undefined,
  searchParams: URLSearchParams,
): SsoEntryDecision {
  const connection = connectionOf(rawConnection ?? "")
  if (!connection) return { action: "invalid" }

  const { returnTo, loginHint, iss } = readEntryParams((name) =>
    searchParams.getAll(name),
  )
  const redirects = searchParams.getAll("redirect_url")
  const forwardedRedirectUrl =
    redirects.length === 1 ? afterAuthUrl(redirects[0]) : returnTo

  if (startedByUs(request))
    return {
      action: "start",
      connection,
      returnTo,
      forwardedRedirectUrl,
      loginHint,
      iss,
    }

  return {
    action: "interstitial",
    connection,
    returnTo,
    loginHint,
    iss,
  }
}

/**
 * Relative URL to `/sso/confirm` carrying only validated parameters.
 *
 * ⚠ NEVER CARRY `name` IN THE QUERY STRING: `/sso/confirm` always fetches the
 * display name from the API by connection id so a crafted URL cannot spoof
 * another company's name on the interstitial button.
 */
export function confirmUrl(
  entry?: Pick<
    Extract<SsoEntryDecision, { action: "interstitial" }>,
    "connection" | "returnTo" | "loginHint" | "iss"
  >,
): string {
  if (!entry) return "/sso/confirm"
  const query = new URLSearchParams({ connection: entry.connection })
  if (entry.returnTo) query.set("redirect_url", entry.returnTo)
  if (entry.loginHint) query.set("login_hint", entry.loginHint)
  if (entry.iss !== null) query.set("iss", entry.iss)
  return `/sso/confirm?${query.toString()}`
}

function parseConnectionResponse(raw: unknown): {
  name: string
  protocol: "oidc" | "saml" | "test"
  provider: string
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const { name, protocol, provider } = raw as Record<string, unknown>
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return null
  if (protocol !== "oidc" && protocol !== "saml" && protocol !== "test") return null
  if (typeof provider !== "string" || provider.length === 0 || provider.length > 64)
    return null
  return { name, protocol, provider }
}

export type InterstitialState =
  | { state: "invalid" }
  | { state: "unavailable" }
  | {
      state: "confirm"
      connection: string
      name: string
      protocol: "oidc" | "saml" | "test"
      provider: string
      title: string
      returnTo: string | null
      loginHint: string | null
      iss: string | null
    }

/**
 * Resolves the `/sso/confirm` page's server state via the API without touching
 * React or the DOM, so tests can exercise every outcome directly.
 */
export async function loadInterstitial(
  rawParams: Record<string, string | string[] | undefined>,
  fetchConnection: (
    path: string,
    body: { connection: string; iss?: string },
  ) => Promise<Response>,
): Promise<InterstitialState> {
  const rawConn = rawParams.connection
  const connection = typeof rawConn === "string" ? connectionOf(rawConn) : null
  if (!connection) return { state: "invalid" }

  const { returnTo, loginHint, iss } = readEntryParams((name) => {
    const value = rawParams[name]
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
  })

  try {
    const response = await fetchConnection("/sso/connection", {
      connection,
      ...(iss !== null ? { iss } : {}),
    })
    if (response.status === 404 || response.status === 422) return { state: "invalid" }
    if (!response.ok) return { state: "unavailable" }
    const parsed = parseConnectionResponse(await response.json())
    if (!parsed) return { state: "unavailable" }
    return {
      state: "confirm",
      connection,
      name: parsed.name,
      protocol: parsed.protocol,
      provider: parsed.provider,
      title: `Continue to ${parsed.name} sign-in`,
      returnTo,
      loginHint,
      iss,
    }
  } catch {
    return { state: "unavailable" }
  }
}

/** Bounded form body cap for `POST /sso/start` (well above max URL-encoded fields). */
export const MAX_START_FORM = 16 * 1024

/**
 * Reads `POST /sso/start`'s `application/x-www-form-urlencoded` body with a
 * 16 KiB byte cap instead of unbounded `formData()`.
 */
export async function readStartForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? ""
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_START_FORM)
    return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_START_FORM) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks))
  return new URLSearchParams(text)
}
