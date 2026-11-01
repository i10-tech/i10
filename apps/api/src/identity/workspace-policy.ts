import { sessionVerdict, needsTouch, type SessionPolicy } from "./model.js"
import {
  clientAddress,
  formatAddress,
  inRanges,
  parseAddress,
  readRanges,
  type Address,
} from "./network.js"
import type {
  ClerkIdentity,
  IdentityStore,
  Logger,
  SessionFacts,
  WorkspacePolicy,
  WorkspacePolicyStore,
} from "./ports.js"

/**
 * The workspace policy gate (#345, sso.md 2.5 and 2.11): what a workspace asks
 * of every request that reaches it, whoever the person is and however they
 * signed in.
 *
 *   - the IP allowlist, for console sessions and for API keys;
 *   - the session policy: a maximum session length and an idle timeout;
 *   - a second factor for members outside SSO.
 *
 * It runs once `requireTenant` knows the workspace (like enforcement,
 * identity/enforcement.ts) and for API keys once `requireApiKey` knows the
 * key's workspace. Most workspaces ask for none of it: one cached read of the
 * settings row per workspace (`policyTtlMs`), nothing else.
 *
 * ⚠ ANY FAILURE IS `unknown`, A 503. Not knowing a workspace's allowlist is
 * not knowing whether the caller may pass. Failures are never cached.
 *
 * ⚠ CHANGES ARE SEEN AT ONCE ON THIS PROCESS (`forgetTenant`, called by every
 * route that changes the policy) and within `policyTtlMs` on the others, so a
 * tightened allowlist can keep admitting for up to that long on another
 * replica.
 */

// ── The session policy's bounds ──────────────────────────────────────────

/** A session may be limited to no less than this: shorter would sign people out mid-task. */
export const MAX_SESSION_SECONDS_MIN = 15 * 60
export const MAX_SESSION_SECONDS_LIMIT = 90 * 24 * 60 * 60
/** The activity row is written once a minute, so an idle timeout below five is a guess. */
export const IDLE_TIMEOUT_SECONDS_MIN = 5 * 60
export const IDLE_TIMEOUT_SECONDS_LIMIT = 30 * 24 * 60 * 60

/**
 * The limits that apply to a session: the stricter (smaller) of the
 * workspace's and, for an SSO-bound session, its connection's, per limit.
 *
 * ⚠ A LIMIT IS NEVER LOOSENED BY THE OTHER SIDE'S SILENCE. Null on one side
 * means "that side asks for nothing", so the other side's limit stands.
 */
export function effectiveLimits(
  workspace: SessionPolicy,
  connection: SessionPolicy | null,
): SessionPolicy {
  const stricter = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : Math.min(a, b)
  return {
    maxSessionSeconds: stricter(
      workspace.maxSessionSeconds,
      connection?.maxSessionSeconds ?? null,
    ),
    idleTimeoutSeconds: stricter(
      workspace.idleTimeoutSeconds,
      connection?.idleTimeoutSeconds ?? null,
    ),
  }
}

/** A session's verdict under the workspace policy, with its connection's limits if bound. */
export function workspaceVerdict(
  policy: SessionPolicy,
  facts: SessionFacts,
  now: Date,
): "ok" | "max_age" | "idle" {
  if (facts.bound)
    return sessionVerdict(
      facts.bound,
      effectiveLimits(policy, {
        maxSessionSeconds: facts.bound.connectionMaxSessionSeconds,
        idleTimeoutSeconds: facts.bound.connectionIdleTimeoutSeconds,
      }),
      now,
    )
  if (!facts.activity) return "ok"
  return sessionVerdict(
    { boundAt: facts.activity.startedAt, lastSeenAt: facts.activity.lastSeenAt },
    policy,
    now,
  )
}

// ── The gate ─────────────────────────────────────────────────────────────

export type WorkspaceOutcome =
  | { status: "pass" }
  | { status: "ip_not_allowed" }
  | { status: "session_expired"; reason: "max_age" | "idle" | "revoked" }
  | { status: "mfa_required" }
  | { status: "unknown" }

export type NetworkOutcome =
  { status: "pass" } | { status: "ip_not_allowed" } | { status: "unknown" }

export interface WorkspaceGateDeps {
  store: WorkspacePolicyStore
  identity: Pick<IdentityStore, "revokeSessionRow" | "record">
  clerk: Pick<ClerkIdentity, "user" | "session" | "revokeSession">
  /** The managed gate's cache, dropped when a session here is revoked. */
  forget(input: { userId?: string; sessionId?: string }): void
  /** `CLIENT_CONTEXT_SECRET`: the signed context carrying the browser's address. */
  contextSecret: string | undefined
  /** `EDGE_SECRET`: without it no `cf-connecting-ip` is believed. */
  edgeSecret: string | undefined
  log: Logger
  now?: () => number
  policyTtlMs?: number
  factsTtlMs?: number
  /** Never more than 60 seconds: how long "has a second factor" may be believed. */
  factorTtlMs?: number
  /** How often one address's refusals are audited (the log is not a request log). */
  denialAuditMs?: number
  maxEntries?: number
}

export interface ConsoleRequest {
  tenantId: string
  userId: string
  sessionId: string
  headers: Headers
  method: string
  path: string
}

export interface WorkspaceGate {
  /** The IP allowlist and the session policy, for a console request. */
  admit(request: ConsoleRequest): Promise<WorkspaceOutcome>
  /** Required second factor for members outside SSO, for a console request. */
  secondFactor(request: ConsoleRequest): Promise<WorkspaceOutcome>
  /** The IP allowlist for an API key's request. */
  admitApiKey(tenantId: string, headers: Headers): Promise<NetworkOutcome>
  /** Drops what this process cached about a workspace. */
  forgetTenant(tenantId: string): void
}

interface Entry<T> {
  value: T
  until: number
}

function boundedSet<T>(
  map: Map<string, Entry<T>>,
  key: string,
  entry: Entry<T>,
  max: number,
) {
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, entry)
}

/**
 * The one console route a person without a second factor may still call
 * (leaving the workspace). Signing out itself is Clerk's frontend API, which
 * never passes through this API at all.
 */
const MFA_EXEMPT = /\/team\/leave$/

/** The longest a "has a second factor" answer is believed. */
export const FACTOR_TTL_CEILING_MS = 60_000

export function workspaceGate(d: WorkspaceGateDeps): WorkspaceGate {
  const now = d.now ?? Date.now
  const policyTtl = d.policyTtlMs ?? 15_000
  const factsTtl = d.factsTtlMs ?? 10_000
  // ⚠ CLAMPED, so a mis-set option cannot make a believed "yes" outlive a minute.
  const factorTtl = Math.min(
    d.factorTtlMs ?? FACTOR_TTL_CEILING_MS,
    FACTOR_TTL_CEILING_MS,
  )
  const denialAudit = d.denialAuditMs ?? 5 * 60_000
  const max = d.maxEntries ?? 50_000
  const policies = new Map<
    string,
    Entry<{ policy: WorkspacePolicy; ranges: ReturnType<typeof readRanges> }>
  >()
  const facts = new Map<
    string,
    Entry<SessionFacts & { revoked: boolean; complete: boolean }>
  >()
  /** Only "has a second factor" is ever stored here. */
  const factors = new Map<string, Entry<true>>()
  const touched = new Map<string, Entry<true>>()
  const denials = new Map<string, Entry<true>>()

  async function policyOf(tenantId: string) {
    const t = now()
    const hit = policies.get(tenantId)
    if (hit && hit.until > t) return hit.value
    const policy = await d.store.policy(tenantId)
    const value = { policy, ranges: readRanges(policy.network.ranges) }
    boundedSet(policies, tenantId, { value, until: t + policyTtl }, max)
    return value
  }

  async function auditDenial(
    tenantId: string,
    surface: "console" | "api_key",
    address: Address | null,
    userId: string | null,
  ) {
    const key = `${tenantId}:${surface}:${address ? formatAddress(address) : "unknown"}`
    const seen = denials.get(key)
    if (seen && seen.until > now()) return
    boundedSet(denials, key, { value: true, until: now() + denialAudit }, max)
    try {
      await d.identity.record(tenantId, {
        type: "network.ip_denied",
        subjectUserId: userId,
        reason: address ? "outside_allowlist" : "address_unknown",
        data: { surface, address: address ? formatAddress(address) : null },
      })
    } catch (error) {
      d.log.warn(
        { err: error instanceof Error ? error.name : "unknown" },
        "could not audit a refused address",
      )
    }
  }

  async function networkVerdict(
    tenantId: string,
    headers: Headers,
    surface: "console" | "api_key",
    userId: string | null,
  ): Promise<"pass" | "denied"> {
    const { policy, ranges } = await policyOf(tenantId)
    const on = surface === "console" ? policy.network.console : policy.network.apiKeys
    if (!on) return "pass"
    // ⚠ UNKNOWN IS REFUSED, NOT ALLOWED: no address we trust is no address in the list.
    const address = clientAddress(headers, d.contextSecret, d.edgeSecret)
    if (address) {
      if (inRanges(address, ranges)) return "pass"
      const grace = policy.network.grace
      if (surface === "console" && grace && userId === grace.userId) {
        const held = parseAddress(grace.address)
        if (
          held &&
          grace.until.getTime() > now() &&
          formatAddress(held) === formatAddress(address)
        )
          return "pass"
      }
    }
    await auditDenial(tenantId, surface, address, userId)
    return "denied"
  }

  /**
   * The session's facts. `track` makes the activity row of a session no SSO
   * bind tracks (a Clerk call, once); the second-factor check only needs to
   * know about a bind and leaves no row behind.
   */
  async function factsOf(
    tenantId: string,
    userId: string,
    sessionId: string,
    track: boolean,
  ) {
    const t = now()
    const key = `${tenantId}:${sessionId}`
    const hit = facts.get(key)
    if (hit && hit.until > t && (hit.value.complete || !track)) return hit.value
    let value = {
      ...(await d.store.sessionFacts(tenantId, sessionId)),
      complete: true,
    }
    if (!value.bound && !value.activity && !value.revoked) {
      value = { ...value, complete: false }
      if (track) {
        const session = await d.clerk.session(sessionId)
        // ⚠ A VERIFIED SESSION CLERK DOES NOT KNOW IS A CONTRADICTION, not a new one.
        if (!session || session.userId !== userId)
          throw new Error("clerk does not know a signed-in session")
        const row = await d.store.startActivity(tenantId, {
          sessionId,
          clerkUserId: userId,
          startedAt: session.createdAt,
          now: new Date(t),
        })
        value = {
          bound: null,
          activity: { startedAt: row.startedAt, lastSeenAt: row.lastSeenAt },
          revoked: row.revoked,
          complete: true,
        }
      }
    }
    boundedSet(facts, key, { value, until: t + factsTtl }, max)
    return value
  }

  async function endSession(
    request: ConsoleRequest,
    current: SessionFacts,
    reason: "max_age" | "idle",
    at: Date,
  ) {
    /*
     * ⚠ REFUSED NOW, REVOKED AS WELL. The refusal is what protects us; the
     * revocation stops the session refreshing at Clerk. A failure here is
     * logged and does not turn the refusal into a pass - the next request
     * revokes again.
     */
    try {
      await d.clerk.revokeSession(request.sessionId)
      const ended = current.bound
        ? await d.identity.revokeSessionRow(
            request.tenantId,
            request.sessionId,
            reason,
            at,
          )
        : await d.store.revokeActivity(request.tenantId, request.sessionId, reason, at)
      if (ended)
        await d.identity.record(request.tenantId, {
          type: "session.revoked",
          subjectUserId: request.userId,
          sessionId: request.sessionId,
          reason,
          data: { source: "workspace_policy" },
        })
    } catch (error) {
      d.log.warn(
        { err: error instanceof Error ? error.name : "unknown", reason },
        "could not revoke a session past the workspace policy - refused anyway",
      )
    }
    facts.delete(`${request.tenantId}:${request.sessionId}`)
    d.forget({ userId: request.userId, sessionId: request.sessionId })
  }

  async function admit(request: ConsoleRequest): Promise<WorkspaceOutcome> {
    const { tenantId, userId, sessionId } = request
    if (
      (await networkVerdict(tenantId, request.headers, "console", userId)) === "denied"
    )
      return { status: "ip_not_allowed" }
    const { policy } = await policyOf(tenantId)
    if (policy.maxSessionSeconds === null && policy.idleTimeoutSeconds === null)
      return { status: "pass" }

    const current = await factsOf(tenantId, userId, sessionId, true)
    if (current.revoked) return { status: "session_expired", reason: "revoked" }
    const at = new Date(now())
    const verdict = workspaceVerdict(policy, current, at)
    if (verdict !== "ok") {
      await endSession(request, current, verdict, at)
      return { status: "session_expired", reason: verdict }
    }
    // A bound session's `last_seen_at` is the managed gate's to write.
    if (current.activity && needsTouch(current.activity.lastSeenAt, at)) {
      const key = `${tenantId}:${sessionId}`
      const writing = touched.get(key)
      if (!writing || writing.until <= now()) {
        // ⚠ THE CACHED COPY MOVES FIRST, so a burst of requests writes once.
        current.activity.lastSeenAt = at
        boundedSet(touched, key, { value: true, until: now() + 30_000 }, max)
        d.store
          .touchActivity(tenantId, sessionId, at)
          .catch((error: unknown) =>
            d.log.warn(
              { err: error instanceof Error ? error.name : "unknown" },
              "could not record a session as seen",
            ),
          )
      }
    }
    return { status: "pass" }
  }

  async function hasSecondFactor(userId: string): Promise<boolean> {
    const t = now()
    const hit = factors.get(userId)
    if (hit && hit.until > t) return true
    const user = await d.clerk.user(userId)
    if (!user) throw new Error("clerk does not know a signed-in user")
    const has = user.twoFactorEnabled || user.totpEnabled
    // ⚠ ONLY "YES" IS CACHED, AND FOR UNDER A MINUTE. A person who adds a
    // second factor to get in must get in on the next request, and one who
    // removes it must not keep a stale yes for long.
    if (has) boundedSet(factors, userId, { value: true, until: t + factorTtl }, max)
    return has
  }

  async function secondFactor(request: ConsoleRequest): Promise<WorkspaceOutcome> {
    const { policy } = await policyOf(request.tenantId)
    if (!policy.requireSecondFactor) return { status: "pass" }
    if (MFA_EXEMPT.test(request.path) && request.method === "POST")
      return { status: "pass" }
    /*
     * ⚠ A SESSION THE IdP BOUND IS EXEMPT; THE IdP OWNS ITS MFA (sso.md 2.4).
     * A managed account has no Clerk second factor at all, so asking Clerk
     * would lock out exactly the people who signed in the strongest way their
     * company chose. Only a bind that is still live counts.
     */
    const current = await factsOf(
      request.tenantId,
      request.userId,
      request.sessionId,
      false,
    )
    if (current.bound && !current.revoked) return { status: "pass" }
    return (await hasSecondFactor(request.userId))
      ? { status: "pass" }
      : { status: "mfa_required" }
  }

  const guarded = async <T extends { status: string }>(
    what: string,
    run: () => Promise<T>,
  ): Promise<T | { status: "unknown" }> => {
    try {
      return await run()
    } catch (error) {
      d.log.error(
        { err: error instanceof Error ? error.name : "unknown" },
        `the workspace policy gate could not ${what} - refusing with 503`,
      )
      return { status: "unknown" }
    }
  }

  return {
    admit: (request) => guarded("read", () => admit(request)),
    secondFactor: (request) => guarded("read", () => secondFactor(request)),
    admitApiKey: (tenantId, headers) =>
      guarded("read", async () =>
        (await networkVerdict(tenantId, headers, "api_key", null)) === "pass"
          ? { status: "pass" as const }
          : { status: "ip_not_allowed" as const },
      ),
    forgetTenant(tenantId) {
      policies.delete(tenantId)
      for (const key of [...facts.keys()])
        if (key.startsWith(`${tenantId}:`)) facts.delete(key)
    },
  }
}
