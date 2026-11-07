import { onLiveDomain, sessionVerdict, type Enforcement } from "./model.js"
import type {
  ClerkIdentity,
  EnforcementRead,
  Logger,
  RequiredConnection,
  SsoPolicyStore,
} from "./ports.js"

/**
 * Enforcement (#340, sso.md 2.10 and decision 7): a workspace whose active
 * connection is "required" lets its covered members in only on a session the
 * bridge bound. The managed-account gate (identity/gate.ts) runs first and
 * everywhere; this one runs once `requireTenant` knows the workspace, because
 * a workspace's enforcement is about access to THAT workspace, never to the
 * person's other workspaces.
 *
 * Who is COVERED, for one active connection:
 *   - `required_all`: every member;
 *   - `required_domain`: a member holding a verified address on one of its
 *     live domains (Clerk's verified addresses, exact names).
 * Not covered:
 *   - EXEMPT people: owners and admins who are not managed, while the owner
 *     exemption is on. They cannot sign in through SSO at all (`role_exempt`
 *     in bridge.ts), so they pass on a passkey instead, and without one get
 *     `passkey_required`.
 *   - people on the bypass list of every connection covering them: a "bypass
 *     sign-in", audited once per session (`sso.bypass_used`).
 *
 * ⚠ WHAT IT COSTS. Most workspaces require nothing: one query, cached per
 * workspace for `tenantTtlMs`. In one that does, the database read is cached
 * per person and session for `readTtlMs`; Clerk is asked for addresses only
 * when a `required_domain` connection could cover the person (cached
 * `addressTtlMs`), and for passkeys only for an exempt person (a passkey held
 * is cached `passkeyTtlMs`; "none" is never cached, so adding one counts at
 * once).
 *
 * ⚠ ANY FAILURE IS `unknown`, A 503. Not knowing whether somebody is covered
 * is not knowing whether they may pass. Failures are never cached.
 *
 * ⚠ CHANGES ARE SEEN AT ONCE ON THIS PROCESS (`forgetTenant`, called by every
 * route that changes enforcement, domains, status, the bypass list, the
 * exemption or a role) and within the cache windows on the others.
 */

export type EnforcementOutcome =
  | { status: "pass" }
  | { status: "sso_required"; connectionId: string }
  | { status: "passkey_required" }
  | { status: "unknown" }

export interface EnforcementDeps {
  store: Pick<SsoPolicyStore, "enforcementRead" | "noteBypassSignIn">
  clerk: Pick<ClerkIdentity, "user">
  log: Logger
  /**
   * Told once per bypass session, after the audit event committed (#345): the
   * other owners and admins are emailed (identity/alerts.ts). It never throws
   * and is not awaited by the request.
   */
  onBypass?: (input: {
    tenantId: string
    userId: string
    sessionId: string
    connectionIds: string[]
  }) => Promise<void>
  now?: () => number
  tenantTtlMs?: number
  readTtlMs?: number
  addressTtlMs?: number
  passkeyTtlMs?: number
  maxEntries?: number
}

export interface EnforcementGate {
  check(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<EnforcementOutcome>
  /** Drops what this process cached about a workspace. */
  forgetTenant(tenantId: string): void
}

interface Entry<T> {
  value: T
  until: number
}

const RANK: Record<Enforcement, number> = {
  off: 0,
  optional: 1,
  required_domain: 2,
  required_all: 3,
}

/** Strictest first, then the oldest: the connection a person is sent to. */
export function strictestFirst<T extends { enforcement: Enforcement; createdAt: Date }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      RANK[b.enforcement] - RANK[a.enforcement] ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )
}

/**
 * The connections covering a person, before exemption and bypass: every
 * `required_all` one, and each `required_domain` one with one of `addresses`
 * on its live domains. `addresses` is asked for only when it can matter.
 */
export async function covering(
  connections: readonly RequiredConnection[],
  addresses: () => Promise<readonly string[]>,
): Promise<RequiredConnection[]> {
  const byDomain = connections.filter(
    (c) => c.enforcement === "required_domain" && c.domains.length > 0,
  )
  const held = byDomain.length ? await addresses() : []
  return connections.filter(
    (c) =>
      c.enforcement === "required_all" ||
      (c.enforcement === "required_domain" &&
        held.some((address) => onLiveDomain(address, c.domains))),
  )
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

export function enforcementGate(d: EnforcementDeps): EnforcementGate {
  const now = d.now ?? Date.now
  const tenantTtl = d.tenantTtlMs ?? 15_000
  const readTtl = d.readTtlMs ?? 10_000
  const addressTtl = d.addressTtlMs ?? 15_000
  const passkeyTtl = d.passkeyTtlMs ?? 60_000
  const max = d.maxEntries ?? 50_000
  const free = new Map<string, Entry<true>>()
  const reads = new Map<string, Entry<Extract<EnforcementRead, { required: true }>>>()
  const addresses = new Map<string, Entry<string[]>>()
  const passkeys = new Map<string, Entry<true>>()
  /** Sessions whose bypass this process has already noted. */
  const noted = new Map<string, Entry<true>>()

  async function read(tenantId: string, userId: string, sessionId: string) {
    const t = now()
    const none = free.get(tenantId)
    if (none && none.until > t) return { required: false as const }
    const key = `${tenantId}:${userId}:${sessionId}`
    const hit = reads.get(key)
    if (hit && hit.until > t) return hit.value
    const value = await d.store.enforcementRead(tenantId, userId, sessionId)
    if (!value.required)
      boundedSet(free, tenantId, { value: true, until: t + tenantTtl }, max)
    else boundedSet(reads, key, { value, until: t + readTtl }, max)
    return value
  }

  /** The person's verified addresses at Clerk, lowercased. */
  async function verified(userId: string): Promise<string[]> {
    const t = now()
    const hit = addresses.get(userId)
    if (hit && hit.until > t) return hit.value
    const user = await d.clerk.user(userId)
    // ⚠ A SIGNED-IN PERSON CLERK DOES NOT KNOW IS A CONTRADICTION, not "no address".
    if (!user) throw new Error("clerk does not know a signed-in user")
    const value = user.emails
      .filter((e) => e.verified)
      .map((e) => e.address.toLowerCase())
    boundedSet(addresses, userId, { value, until: t + addressTtl }, max)
    return value
  }

  async function hasPasskey(userId: string): Promise<boolean> {
    const t = now()
    const hit = passkeys.get(userId)
    if (hit && hit.until > t) return true
    const user = await d.clerk.user(userId)
    if (!user) throw new Error("clerk does not know a signed-in user")
    if (user.passkeyIds.length === 0) return false
    boundedSet(passkeys, userId, { value: true, until: t + passkeyTtl }, max)
    return true
  }

  async function decide(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<EnforcementOutcome> {
    const facts = await read(tenantId, userId, sessionId)
    if (!facts.required) return { status: "pass" }
    /*
     * ⚠ A BOUND SESSION PASSES, inside its connection's session policy. The
     * managed gate revokes a managed account's expired session; here the
     * refusal alone is enough, and the next bind starts a fresh one.
     */
    if (
      facts.session &&
      sessionVerdict(facts.session, facts.session, new Date(now())) === "ok"
    )
      return { status: "pass" }
    const covered = await covering(facts.connections, () => verified(userId))
    if (covered.length === 0) return { status: "pass" }

    /*
     * ⚠ EXEMPT ONLY WHILE NOT MANAGED (decision 7). A managed owner signs in
     * through the link they have; an unmanaged one cannot use SSO at all, so
     * a passkey is what keeps their way in strong.
     */
    if (facts.exemption && facts.privileged && !facts.managed)
      return (await hasPasskey(userId))
        ? { status: "pass" }
        : { status: "passkey_required" }

    const ordered = strictestFirst(covered)
    // ⚠ EVERY COVERING CONNECTION MUST LIST THEM: one IdP's break-glass does
    // not open another's.
    if (ordered.every((c) => c.bypassed)) {
      const key = `${tenantId}:${sessionId}`
      const seen = noted.get(key)
      if (!seen || seen.until <= now()) {
        if (
          await d.store.noteBypassSignIn(tenantId, {
            sessionId,
            clerkUserId: userId,
            connectionIds: ordered.map((c) => c.id),
          })
        ) {
          /*
           * ⚠ THE ALERT TO THE OTHER ADMINS IS AN EMAIL (#345), ONCE PER
           * SESSION: `noteBypassSignIn` returned true only for the first
           * sign-in of this session, in the same transaction as its audit
           * event. Fire and forget - the request never waits on mail, and a
           * failure is the alert's to log.
           */
          const connectionIds = ordered.map((c) => c.id)
          d.log.warn(
            { tenantId, userId, sessionId, connectionIds },
            "a bypass sign-in passed the SSO requirement",
          )
          void d
            .onBypass?.({ tenantId, userId, sessionId, connectionIds })
            .catch((error: unknown) =>
              d.log.error({ err: String(error), tenantId }, "bypass alert failed"),
            )
        }
        boundedSet(noted, key, { value: true, until: now() + readTtl * 6 }, max)
      }
      return { status: "pass" }
    }
    return { status: "sso_required", connectionId: ordered[0]!.id }
  }

  return {
    async check(tenantId, userId, sessionId) {
      try {
        return await decide(tenantId, userId, sessionId)
      } catch (error) {
        d.log.error(
          { err: error instanceof Error ? error.name : "unknown" },
          "the SSO enforcement gate could not read - refusing with 503",
        )
        return { status: "unknown" }
      }
    },
    forgetTenant(tenantId) {
      free.delete(tenantId)
      for (const key of [...reads.keys()])
        if (key.startsWith(`${tenantId}:`)) reads.delete(key)
    },
  }
}
