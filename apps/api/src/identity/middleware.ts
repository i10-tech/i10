import type { ClerkClient } from "@clerk/backend"
import type { FreshAuthReader, SsoGateReader } from "../middleware/session.js"
import type { SsoGateChecker } from "./gate.js"

/**
 * The identity core, plugged into the middleware: the gate's reader for
 * `requireUser` / `requireTenant`, and step-up for `requireFreshAuth`.
 */

export type SessionIdReader = (
  request: Request,
) => Promise<
  { status: "ok"; userId: string; sessionId: string } | { status: "unknown" }
>

/**
 * The verified session's `sid`.
 *
 * ⚠ THE SAME CLERK CLIENT AND ALLOWLIST AS THE VERIFIER, and a local JWT
 * check like every other reader there: no network call on the common path.
 * A verified request with no session id is a contradiction, so `unknown`.
 */
export function clerkSessionIds(
  clerk: ClerkClient,
  options: {
    authorizedParties: readonly string[]
    log?: { error: (o: object, m: string) => void }
  },
): SessionIdReader {
  const authorizedParties = options.authorizedParties.length
    ? [...options.authorizedParties]
    : undefined
  return async (request) => {
    try {
      const state = await clerk.authenticateRequest(request, { authorizedParties })
      if (!state.isAuthenticated) return { status: "unknown" }
      const auth = state.toAuth() as {
        userId?: string | null
        sessionId?: string | null
      }
      return auth.userId && auth.sessionId
        ? { status: "ok", userId: auth.userId, sessionId: auth.sessionId }
        : { status: "unknown" }
    } catch (error) {
      options.log?.error({ err: String(error) }, "clerk could not read the session id")
      return { status: "unknown" }
    }
  }
}

/**
 * Where a managed account starts again: apps/auth's `/sso/start`, which
 * makes the attempt and sends the browser to its IdP.
 */
export function startUrlFor(
  authOrigin: string | undefined,
  path: "/sso/start" | "/sso/step-up" = "/sso/start",
) {
  return (connectionId: string | null): string | null => {
    if (!authOrigin || !connectionId) return null
    const url = new URL(path, authOrigin)
    url.searchParams.set("connection", connectionId)
    return url.href
  }
}

export function gateReader(
  sessionIds: SessionIdReader,
  checker: SsoGateChecker,
  startUrl: (connectionId: string | null) => string | null,
): SsoGateReader {
  return async (request, userId) => {
    const ids = await sessionIds(request)
    // ⚠ A DIFFERENT USER THAN THE VERIFIER SAW IS A CONTRADICTION, not a pass.
    if (ids.status !== "ok" || ids.userId !== userId) return { status: "unknown" }
    const verdict = await checker.check(userId, ids.sessionId)
    if (verdict.status === "sso_required")
      return {
        status: "sso_required",
        startUrl: startUrl(verdict.connectionId),
        reason: verdict.reason,
      }
    return verdict
  }
}

/**
 * `requireFreshAuth` with SSO step-up (sso.md 2.4).
 *
 * ⚠ FOR A MANAGED ACCOUNT ONLY `sso_sessions.fresh_at` COUNTS, NOT CLERK'S
 * `strict`. The design reads "Clerk strict OR fresh_at"; for a managed account
 * Clerk's strict would be satisfiable with an email code (no password, no 2FA:
 * `strict` falls back to the first factor), which is not what their company
 * asked for. So the OR is by person: managed people go to their IdP, everyone
 * else to Clerk, unchanged. Right after an SSO sign-in both agree anyway: the
 * `fresh` ticket makes `fva [0,0]` and `fresh_at` is the IdP's `auth_time`.
 */
export function withSsoFreshness(
  inner: FreshAuthReader,
  sessionIds: SessionIdReader,
  checker: SsoGateChecker,
  startUrl: (connectionId: string | null) => string | null,
  connectionOf: (userId: string) => Promise<string | null>,
  log: { error: (o: object, m: string) => void },
): FreshAuthReader {
  return async (request) => {
    const ids = await sessionIds(request)
    if (ids.status !== "ok") return { status: "unknown" }
    let managed: Awaited<ReturnType<SsoGateChecker["freshness"]>>
    try {
      managed = await checker.freshness(ids.userId, ids.sessionId)
    } catch (error) {
      log.error(
        { err: String(error) },
        "could not read SSO step-up - refusing with 503",
      )
      return { status: "unknown" }
    }
    if (!managed.managed) return inner(request)
    if (managed.fresh) return { status: "fresh" }
    try {
      return { status: "sso_stale", startUrl: startUrl(await connectionOf(ids.userId)) }
    } catch (error) {
      // Still stale, only without a link: the refusal does not depend on it.
      log.error({ err: String(error) }, "could not find a managed account's connection")
      return { status: "sso_stale", startUrl: null }
    }
  }
}
