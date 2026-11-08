import { isFresh, needsTouch, sessionVerdict } from "./model.js"
import type { ClerkIdentity, GateRead, IdentityStore, Logger } from "./ports.js"

/**
 * The gate (sso.md 2.2, layer 2): a managed account's request passes only on
 * a session the bridge bound, on a connection that is still active, inside
 * its connection's session policy.
 *
 * ⚠ IT RUNS ON EVERY SESSION REQUEST, SO WHAT IT COSTS IS THE DESIGN. Almost
 * every person is NOT managed, and for them the gate is a second local JWT
 * verification (for the session id, identity/middleware.ts) and one map
 * lookup:
 *
 *   - `managed: null` is cached per user for `unmanagedTtlMs` (15 s). On a
 *     miss it is one transaction reading one row by primary key under
 *     `managed_accounts_user_read`. No Clerk call, ever.
 *   - A managed person's BOUND read (managed row and session row, one
 *     transaction) is cached per session for `managedTtlMs` (10 s), and
 *     `last_seen_at` is written at most once a minute per session.
 *
 * Why not a claim in the session token (sso.md 1.1, JWT templates): the
 * default session token carries no `public_metadata` without a dashboard
 * change on each instance, and a claim can only ever say "managed" - its
 * absence could never skip the lookup safely, because a token minted before
 * the account became managed would still say nothing. So the lookup is the
 * truth and the cache is what makes it cheap.
 *
 * ⚠ WHAT THE CACHE COSTS: a person who BECOMES managed is gated at most
 * `unmanagedTtlMs` later on a pod that had them cached - and the bridge has
 * already revoked every session they had when it claimed them, so what is left
 * is a Clerk token's remaining minute. Our own revocations evict locally at
 * once; other pods see them within `managedTtlMs`. Failures are never cached.
 *
 * ⚠ ANY FAILURE IS `unknown`, WHICH IS A 503 - for everybody, managed or not.
 * Not knowing whether somebody is managed is not knowing whether they may
 * pass; the console reads the same database, so it is down anyway.
 */

export type GateOutcome =
  | { status: "pass" }
  | {
      status: "sso_required"
      /** The connection to sign in through, for the start URL. */
      connectionId: string | null
      reason: "unbound" | "connection_inactive" | "max_age" | "idle" | "revoked"
    }
  | { status: "unknown" }

export interface GateDeps {
  store: Pick<
    IdentityStore,
    "gateRead" | "touchSession" | "revokeSessionRow" | "record"
  >
  clerk: Pick<ClerkIdentity, "revokeSession">
  log: Logger
  now?: () => number
  unmanagedTtlMs?: number
  managedTtlMs?: number
  maxEntries?: number
}

export interface SsoGateChecker {
  check(userId: string, sessionId: string): Promise<GateOutcome>
  /** Is this session fresh by the IdP (sso.md 2.4)? `managed: false` for non-managed people. */
  freshness(
    userId: string,
    sessionId: string,
  ): Promise<{ managed: false } | { managed: true; fresh: boolean }>
  /** Drops what this process cached about a user or session. */
  forget(input: { userId?: string; sessionId?: string }): void
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

export function ssoGate(d: GateDeps): SsoGateChecker {
  const now = d.now ?? Date.now
  const unmanagedTtl = d.unmanagedTtlMs ?? 15_000
  const managedTtl = d.managedTtlMs ?? 10_000
  const max = d.maxEntries ?? 50_000
  const unmanaged = new Map<string, Entry<true>>()
  const reads = new Map<string, Entry<GateRead>>()

  async function read(userId: string, sessionId: string): Promise<GateRead> {
    const t = now()
    const free = unmanaged.get(userId)
    if (free && free.until > t) return { managed: null }
    const key = `${userId}:${sessionId}`
    const hit = reads.get(key)
    if (hit && hit.until > t) return hit.value
    const value = await d.store.gateRead(userId, sessionId)
    if (value.managed === null)
      boundedSet(unmanaged, userId, { value: true, until: t + unmanagedTtl }, max)
    // ⚠ ONLY A BOUND SESSION IS CACHED. "Not bound yet" is true for the few
    // seconds between `signIn.ticket()` and `POST /sso/bind`; caching it would
    // refuse the person's first page after a sign-in that just worked.
    else if (value.session)
      boundedSet(reads, key, { value, until: t + managedTtl }, max)
    return value
  }

  async function check(userId: string, sessionId: string): Promise<GateOutcome> {
    let value: GateRead
    try {
      value = await read(userId, sessionId)
    } catch (error) {
      d.log.error(
        { err: String(error) },
        "the SSO gate could not read - refusing with 503",
      )
      return { status: "unknown" }
    }
    if (value.managed === null) return { status: "pass" }
    const connectionId = value.managed.connectionId
    const session = value.session
    if (!session) return { status: "sso_required", connectionId, reason: "unbound" }
    if (session.revokedAt)
      return { status: "sso_required", connectionId, reason: "revoked" }
    if (session.connectionStatus !== "active" || !session.domainLive)
      return { status: "sso_required", connectionId, reason: "connection_inactive" }

    const at = new Date(now())
    const verdict = sessionVerdict(session, session, at)
    if (verdict !== "ok") {
      /*
       * ⚠ REFUSED NOW, REVOKED AS WELL. The refusal is what protects us; the
       * revocation stops the session refreshing at Clerk and its other uses
       * there. A Clerk failure is logged and does not turn the refusal into a
       * pass - the next request revokes again.
       */
      try {
        await d.clerk.revokeSession(sessionId)
        if (await d.store.revokeSessionRow(session.tenantId, sessionId, verdict, at))
          await d.store.record(session.tenantId, {
            type: "session.revoked",
            subjectUserId: userId,
            sessionId,
            connectionId: session.connectionId,
            reason: verdict,
          })
      } catch (error) {
        d.log.warn(
          { err: String(error), sessionId, reason: verdict },
          "could not revoke an SSO session past its connection's policy - refused anyway",
        )
      }
      reads.delete(`${userId}:${sessionId}`)
      return { status: "sso_required", connectionId, reason: verdict }
    }

    if (needsTouch(session.lastSeenAt, at)) {
      // ⚠ THE CACHED COPY MOVES FIRST, so a burst of requests writes once.
      session.lastSeenAt = at
      d.store
        .touchSession(session.tenantId, sessionId, at)
        .catch((error: unknown) =>
          d.log.warn(
            { err: String(error), sessionId },
            "could not record an SSO session as seen",
          ),
        )
    }
    return { status: "pass" }
  }

  return {
    check,
    async freshness(userId, sessionId) {
      /*
       * ⚠ NOT FROM THE CACHE. Step-up is the one read whose answer changes
       * because the person just did something (`fresh_at` moved), and a cached
       * copy would send them straight back to their IdP. Only the step-up
       * routes ask, so the database read costs nothing that matters.
       */
      const value = await d.store.gateRead(userId, sessionId)
      if (value.managed === null) return { managed: false }
      const session = value.session
      return {
        managed: true,
        fresh: Boolean(
          session &&
          !session.revokedAt &&
          session.connectionStatus === "active" &&
          session.domainLive &&
          isFresh(session.freshAt, new Date(now())),
        ),
      }
    },
    forget({ userId, sessionId }) {
      if (userId) unmanaged.delete(userId)
      for (const key of [...reads.keys()]) {
        const [user, session] = key.split(":")
        if ((!userId || user === userId) && (!sessionId || session === sessionId))
          reads.delete(key)
      }
    },
  }
}
