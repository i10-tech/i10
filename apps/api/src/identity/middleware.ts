import type { ClerkClient } from "@clerk/backend"
import type { FreshAuthReader, SsoGateReader } from "../middleware/session.js"
import type { EnforcementGate } from "./enforcement.js"
import type { SsoGateChecker } from "./gate.js"
import { capabilitiesOf } from "./idp-capabilities.js"
import type { Protocol } from "./model.js"
import type { WorkspaceGate } from "./workspace-policy.js"

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

/**
 * ⚠ WITH A TENANT IT ASKS ONLY THE WORKSPACE'S OWN RULES (#340, #345): the
 * managed-account check already ran for this request, without one, before
 * the workspace was resolved. No `enforcement` or `workspace` wired means
 * that part is not enforced, which is only ever a test's or a process
 * without the identity core.
 */
export function gateReader(
  sessionIds: SessionIdReader,
  checker: SsoGateChecker,
  startUrl: (connectionId: string | null) => string | null,
  enforcement?: EnforcementGate,
  workspace?: WorkspaceGate,
): SsoGateReader {
  return async (request, userId, tenantId) => {
    const ids = await sessionIds(request)
    // ⚠ A DIFFERENT USER THAN THE VERIFIER SAW IS A CONTRADICTION, not a pass.
    if (ids.status !== "ok" || ids.userId !== userId) return { status: "unknown" }
    if (tenantId !== undefined) {
      /*
       * ⚠ THE WORKSPACE'S OWN RULES, IN THIS ORDER (#345): where the request
       * comes from and how old the session is (nothing else is said to a
       * caller the workspace does not admit), then SSO enforcement, then the
       * second factor - last, so a covered member without a bound session is
       * told to use SSO rather than to add a factor they will not need.
       */
      const req = {
        tenantId,
        userId,
        sessionId: ids.sessionId,
        headers: request.headers,
        method: request.method,
        path: new URL(request.url).pathname,
      }
      const admitted = await workspace?.admit(req)
      if (admitted && admitted.status !== "pass") return admitted
      if (enforcement) {
        const enforced = await enforcement.check(tenantId, userId, ids.sessionId)
        if (enforced.status === "sso_required")
          return {
            status: "sso_required",
            startUrl: startUrl(enforced.connectionId),
            reason: "enforced",
          }
        if (enforced.status !== "pass") return enforced
      }
      const factor = await workspace?.secondFactor(req)
      return factor && factor.status !== "pass" ? factor : { status: "pass" }
    }
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

export type StepUpConnection =
  string | { id: string; protocol: Protocol; provider: string } | null

/**
 * `requireFreshAuth` with SSO step-up (sso.md 2.4, 2.22).
 *
 * ⚠ FOR A MANAGED ACCOUNT WHOSE IdP CAN PROVE FRESH AUTH, ONLY
 * `sso_sessions.fresh_at` COUNTS, NOT CLERK'S `strict`. When the connection's
 * provider cannot prove a fresh sign-in (`canProveFreshAuth === "no"`, e.g.
 * Google OIDC has no `auth_time` and Google SAML ignores `ForceAuthn`), SSO
 * step-up is not offered and `inner` (our own step-up via Clerk) runs instead.
 */
export function withSsoFreshness(
  inner: FreshAuthReader,
  sessionIds: SessionIdReader,
  checker: SsoGateChecker,
  startUrl: (connectionId: string | null) => string | null,
  connectionOf: (userId: string, sessionId: string) => Promise<StepUpConnection>,
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
    let connection: StepUpConnection = null
    try {
      connection = await connectionOf(ids.userId, ids.sessionId)
    } catch (error) {
      log.error({ err: String(error) }, "could not find a managed account's connection")
      return managed.fresh
        ? { status: "unknown" }
        : { status: "sso_stale", startUrl: null }
    }
    if (
      connection &&
      typeof connection === "object" &&
      capabilitiesOf(connection.protocol, connection.provider).canProveFreshAuth ===
        "no"
    )
      return inner(request)
    if (managed.fresh) return { status: "fresh" }
    const connectionId =
      typeof connection === "string" ? connection : (connection?.id ?? null)
    return { status: "sso_stale", startUrl: startUrl(connectionId) }
  }
}
