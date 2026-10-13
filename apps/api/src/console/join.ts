import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import {
  domains,
  joinDismissals,
  joinDomains,
  joinExclusions,
  joinMemberships,
  joinRequests,
  type JoinRule,
} from "../db/core.js"
import { NO_TENANT } from "../middleware/tenant.js"
import type { TxtLookup } from "../domains/ownership.js"
import { coveringNames, normalizeName, type AccessDomain } from "./access-rules.js"

/**
 * Team access domains, join requests, and the removed and block lists - ours
 * since 2026-10-13, rules since #326. What Clerk's "verified organization
 * domains" did, which is not on our Clerk plan. See `join_domains` in
 * db/core.ts for the audiences and their policies.
 *
 * ⚠ THE SEEKER'S ADDRESSES COME FROM THE CALLER, WHO READS THEM FROM CLERK'S
 * VERIFIED ADDRESSES - never from a request body. Everything a seeker can see
 * here is bounded by that list and by their own user id.
 *
 * ⚠ CROSS-WORKSPACE WRITES TAKE THE TENANT ID FROM A ROW, NEVER FROM A
 * REQUEST. Filing a request, recording an auto-join, displacing an older
 * proof: each runs under the OTHER workspace's tenant, with the id read
 * from `join_domains` through a policy that only showed the row because the
 * seeker's verified domain (or the proven name) matched it.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export interface JoinRequestRow {
  id: string
  user_id: string
  email: string
  via: string | null
  /** Filed because an auto-join found the workspace full. */
  full: boolean
  created_at: string
}

export type AccessStatus =
  /** Proven and matching. */
  | "verified"
  /** Waiting for its TXT record. */
  | "pending"
  /** Was proven; the proof is gone, so its rules have stopped. */
  | "lapsed"
  /** Another workspace proved the same name later. */
  | "displaced"

export interface AccessDomainRow {
  id: string
  name: string
  source: "domains" | "txt"
  status: AccessStatus
  /** The TXT record that proves it for access only. */
  txt: { name: string; value: string }
  rules: JoinRule[]
  /** A /domains entry whose sending domain was deleted, now asking for its own TXT. */
  orphaned: boolean
  verified_at: string | null
  checked_at: string | null
  created_at: string
}

export interface ExclusionRow {
  email: string
  kind: "removed" | "blocked"
  created_at: string
}

export interface JoinRecord {
  user_id: string
  email: string
  how: "auto" | "join" | "request"
  via: string | null
  created_at: string
}

/** Where the TXT proof lives, and what it says. */
export const accessTxtName = (name: string) => `_i10-access.${name}`
export const accessTxtValue = (token: string) => `i10-access=${token}`

export interface JoinStore {
  // ── The workspace's own ──────────────────────────────────────────────────
  /** This workspace's access domains, /domains-sourced ones re-read first. */
  accessDomains(tenantId: string): Promise<AccessDomainRow[]>
  /**
   * Adds an access domain. From /domains: only a name this workspace has
   * verified there, proven at once. For TXT: pending until `verifyTxt`.
   */
  addAccessDomain(
    tenantId: string,
    input: { name: string; clerkOrgId: string; source: "domains" | "txt" },
  ): Promise<{ outcome: "created" | "exists" | "not_verified"; id: string | null }>
  /** Looks for the TXT record; proven takes the name from any older holder. */
  verifyTxt(
    tenantId: string,
    id: string,
    lookup: TxtLookup,
  ): Promise<"proven" | "absent" | "unreachable" | "missing">
  removeAccessDomain(tenantId: string, id: string): Promise<boolean>
  /** Replaces a domain's rules; the caller has validated them. Null when not found. */
  setRules(tenantId: string, id: string, rules: JoinRule[]): Promise<string | null>
  /** Names dismissed from the Team page's suggestion card. */
  dismissed(tenantId: string): Promise<string[]>
  dismiss(tenantId: string, name: string): Promise<void>
  /** This workspace's unanswered requests, newest first. */
  pending(tenantId: string): Promise<JoinRequestRow[]>
  /** Marks a request answered; null when it is not this workspace's or is answered. */
  answer(tenantId: string, id: string, accept: boolean): Promise<JoinRequestRow | null>
  exclusions(tenantId: string): Promise<ExclusionRow[]>
  /** Which of these addresses are on this workspace's lists. */
  excluded(
    tenantId: string,
    emails: string[],
  ): Promise<Map<string, ExclusionRow["kind"]>>
  /** Adds addresses; `blocked` replaces `removed`, never the other way. */
  exclude(tenantId: string, emails: string[], kind: ExclusionRow["kind"]): Promise<void>
  /** Takes addresses off both lists. */
  allow(tenantId: string, emails: string[]): Promise<void>
  joins(tenantId: string): Promise<JoinRecord[]>
  forgetJoin(tenantId: string, userId: string): Promise<void>

  // ── Writes into a workspace found by a seeker's match ────────────────────
  recordJoin(
    tenantId: string,
    input: {
      userId: string
      email: string
      how: JoinRecord["how"]
      via: string | null
    },
  ): Promise<void>
  fileRequest(
    tenantId: string,
    input: { userId: string; email: string; via: string | null; full: boolean },
  ): Promise<"created" | "exists">

  // ── The seeker's view ────────────────────────────────────────────────────
  /**
   * Active access domains covering any of these addresses, with this
   * person's open requests and recorded joins.
   */
  accessFor(input: {
    currentTenantId: string
    userId: string
    emails: string[]
  }): Promise<{ domains: AccessDomain[]; requested: Set<string>; joined: Set<string> }>
  /** Auto-joins and full-workspace requests for this person since `since`. */
  arrivals(
    userId: string,
    since: Date,
  ): Promise<{ tenantId: string; outcome: "joined" | "full"; via: string | null }[]>
}

const asSeeker = async (tx: Tx, userId: string, seekerDomains: string[]) => {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
  await tx.execute(
    sql`select set_config('app.seeker_domains', ${cleanDomains(seekerDomains).join(",")}, true)`,
  )
}

/** Lowercased, unique, and never carrying the comma the policy splits on. */
export function cleanDomains(names: string[]): string[] {
  return [
    ...new Set(
      names.map((n) => n.trim().toLowerCase()).filter((n) => n && !n.includes(",")),
    ),
  ]
}

/** The domain half of each address, for `app.seeker_domains`. */
export function domainsOf(emails: string[]): string[] {
  return cleanDomains(emails.map((e) => e.split("@")[1] ?? ""))
}

const requestRow = (r: typeof joinRequests.$inferSelect): JoinRequestRow => ({
  id: r.id,
  user_id: r.userId,
  email: r.email,
  via: r.via,
  full: r.full,
  created_at: r.createdAt.toISOString(),
})

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function statusOf(r: typeof joinDomains.$inferSelect): AccessStatus {
  if (r.displacedAt) return "displaced"
  if (r.source === "domains" && !r.domainId) return "pending"
  if (!r.verifiedAt) return "pending"
  if (r.lapsedAt) return "lapsed"
  return "verified"
}

/**
 * ⚠ "ACTIVE" IN SQL, FOR THE SEEKER. A /domains entry whose domain has been
 * deleted has a null `domain_id` and matches nobody from that moment - the
 * seeker cannot read `core.domains` to ask, so the row carries the answer.
 */
const active = and(
  isNotNull(joinDomains.verifiedAt),
  isNull(joinDomains.lapsedAt),
  isNull(joinDomains.displacedAt),
  or(eq(joinDomains.source, "txt"), isNotNull(joinDomains.domainId)),
)

/**
 * Latest proof wins (#326), as on /domains: every OTHER workspace's entry for
 * exactly this name is stood down. Their subdomain entries are their own
 * proofs and stay.
 *
 * ⚠ FOUND THROUGH THE SEEKER POLICY, WRITTEN UNDER EACH ONE'S OWN TENANT.
 * `app.seeker_domains` set to the proven name reads exactly the rows with
 * that name, which is the only thing this needs to know about them.
 */
async function displaceOthers(db: Database, name: string, tenantId: string) {
  const others = await withTenant(db, NO_TENANT, async (tx) => {
    await tx.execute(sql`select set_config('app.seeker_domains', ${name}, true)`)
    return tx
      .select({ id: joinDomains.id, tenantId: joinDomains.tenantId })
      .from(joinDomains)
      .where(and(eq(joinDomains.name, name), isNull(joinDomains.displacedAt)))
  })
  for (const other of others) {
    if (other.tenantId === tenantId) continue
    await withTenant(db, other.tenantId, (tx) =>
      tx
        .update(joinDomains)
        .set({ displacedAt: new Date() })
        .where(
          and(eq(joinDomains.id, other.id), eq(joinDomains.tenantId, other.tenantId)),
        ),
    )
  }
}

/**
 * Brings /domains-sourced entries in line with their sending domain, in the
 * workspace's own transaction.
 *
 * ⚠ THE SENDING DOMAIN IS THE PROOF, SO ITS STATE IS THIS ROW'S STATE. Failed
 * or displaced on /domains: lapsed here. Verified again: active again.
 * Deleted: `domain_id` went null with it, the entry stops matching, and the
 * Team page asks for its own TXT record instead of it vanishing - the one
 * thing a `cascade` key would have done wrong. Proving that TXT makes it a
 * `txt` entry.
 */
async function syncFromDomains(tx: Tx, tenantId: string, now: Date) {
  const rows = await tx
    .select({
      id: joinDomains.id,
      name: joinDomains.name,
      domainId: joinDomains.domainId,
      verifiedAt: joinDomains.verifiedAt,
      lapsedAt: joinDomains.lapsedAt,
      status: domains.status,
      displaced: domains.displacedAt,
    })
    .from(joinDomains)
    .leftJoin(domains, eq(domains.id, joinDomains.domainId))
    .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.source, "domains")))
  for (const r of rows) {
    if (!r.domainId) continue
    const proven = r.status === "verified" && !r.displaced
    /*
     * ⚠ A ROW FROM BEFORE #326 HAS NO `verified_at` AND NO RULES. It was the
     * old on/off switch, on, which meant "suggest to people at exactly this
     * name" - so it becomes that rule, and keeps doing what its admin chose.
     */
    if (!r.verifiedAt && proven) {
      await tx
        .update(joinDomains)
        .set({
          verifiedAt: now,
          checkedAt: now,
          lapsedAt: null,
          rules: [{ pattern: r.name, mode: "suggest", role: "org:member" }],
        })
        .where(eq(joinDomains.id, r.id))
      continue
    }
    if (proven === (r.lapsedAt === null)) continue
    await tx
      .update(joinDomains)
      .set({ lapsedAt: proven ? null : now, checkedAt: now })
      .where(eq(joinDomains.id, r.id))
  }
}

export function joinStore(db: Database): JoinStore {
  return {
    async accessDomains(tenantId) {
      const rows = await withTenant(db, tenantId, async (tx) => {
        await syncFromDomains(tx, tenantId, new Date())
        return tx
          .select()
          .from(joinDomains)
          .where(eq(joinDomains.tenantId, tenantId))
          .orderBy(joinDomains.name)
      })
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source === "txt" ? "txt" : "domains",
        status: statusOf(r),
        txt: { name: accessTxtName(r.name), value: accessTxtValue(r.token) },
        rules: r.rules,
        orphaned: r.source === "domains" && r.domainId === null,
        verified_at: iso(r.verifiedAt),
        checked_at: iso(r.checkedAt),
        created_at: r.createdAt.toISOString(),
      }))
    },

    async addAccessDomain(tenantId, { name, clerkOrgId, source }) {
      const lower = normalizeName(name)
      const made = await withTenant(db, tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: joinDomains.id })
          .from(joinDomains)
          .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.name, lower)))
          .limit(1)
        if (existing) return { outcome: "exists" as const, id: existing.id }
        if (source === "txt") {
          const [row] = await tx
            .insert(joinDomains)
            .values({ tenantId, name: lower, clerkOrgId, source: "txt", rules: [] })
            .returning({ id: joinDomains.id })
          return { outcome: "created" as const, id: row!.id }
        }
        // ⚠ ONLY A DOMAIN THIS WORKSPACE HAS VERIFIED, AND STILL HOLDS: DNS is the proof.
        const [domain] = await tx
          .select({ id: domains.id })
          .from(domains)
          .where(
            and(
              eq(domains.tenantId, tenantId),
              eq(domains.name, lower),
              eq(domains.status, "verified"),
              isNull(domains.displacedAt),
            ),
          )
          .limit(1)
        if (!domain) return { outcome: "not_verified" as const, id: null }
        const [row] = await tx
          .insert(joinDomains)
          .values({
            tenantId,
            domainId: domain.id,
            name: lower,
            clerkOrgId,
            source: "domains",
            rules: [],
            verifiedAt: new Date(),
            checkedAt: new Date(),
          })
          .returning({ id: joinDomains.id })
        return { outcome: "created" as const, id: row!.id }
      })
      if (made.outcome === "created" && source === "domains")
        await displaceOthers(db, lower, tenantId)
      return made
    },

    async verifyTxt(tenantId, id, lookup) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(joinDomains)
          .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.id, id)))
          .limit(1),
      )
      if (!row) return "missing"
      let published: string[]
      try {
        published = await lookup(accessTxtName(row.name))
      } catch {
        // ⚠ "WE COULD NOT ASK" IS NOT "THEY PUBLISHED NOTHING" - nothing is written.
        return "unreachable"
      }
      const wanted = accessTxtValue(row.token)
      const proven = published.some((v) => v.replace(/["\s]/g, "") === wanted)
      const now = new Date()
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(joinDomains)
          .set(
            proven
              ? {
                  source: "txt",
                  verifiedAt: now,
                  lapsedAt: null,
                  displacedAt: null,
                  checkedAt: now,
                }
              : { checkedAt: now },
          )
          .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.id, id))),
      )
      if (!proven) return "absent"
      await displaceOthers(db, row.name, tenantId)
      return "proven"
    },

    async removeAccessDomain(tenantId, id) {
      const gone = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(joinDomains)
          .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.id, id)))
          .returning({ id: joinDomains.id }),
      )
      return gone.length > 0
    },

    async setRules(tenantId, id, rules) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(joinDomains)
          .set({ rules })
          .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.id, id)))
          .returning({ name: joinDomains.name }),
      )
      return row?.name ?? null
    },

    async dismissed(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: joinDismissals.name })
          .from(joinDismissals)
          .where(eq(joinDismissals.tenantId, tenantId)),
      )
      return rows.map((r) => r.name)
    },

    async dismiss(tenantId, name) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .insert(joinDismissals)
          .values({ tenantId, name: normalizeName(name) })
          .onConflictDoNothing(),
      )
    },

    async pending(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(joinRequests)
          .where(
            and(eq(joinRequests.tenantId, tenantId), isNull(joinRequests.answeredAt)),
          )
          .orderBy(desc(joinRequests.createdAt)),
      )
      return rows.map(requestRow)
    },

    async answer(tenantId, id, accept) {
      const [answered] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(joinRequests)
          .set({ answeredAt: new Date(), accepted: accept })
          .where(
            and(
              eq(joinRequests.tenantId, tenantId),
              eq(joinRequests.id, id),
              isNull(joinRequests.answeredAt),
            ),
          )
          .returning(),
      )
      return answered ? requestRow(answered) : null
    },

    async exclusions(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(joinExclusions)
          .where(eq(joinExclusions.tenantId, tenantId))
          .orderBy(desc(joinExclusions.createdAt)),
      )
      return rows.map((r) => ({
        email: r.email,
        kind: r.kind === "blocked" ? "blocked" : "removed",
        created_at: r.createdAt.toISOString(),
      }))
    },

    async excluded(tenantId, emails) {
      const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()))]
      if (wanted.length === 0) return new Map()
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ email: joinExclusions.email, kind: joinExclusions.kind })
          .from(joinExclusions)
          .where(
            and(
              eq(joinExclusions.tenantId, tenantId),
              inArray(joinExclusions.email, wanted),
            ),
          ),
      )
      return new Map(
        rows.map(
          (r) => [r.email, r.kind === "blocked" ? "blocked" : "removed"] as const,
        ),
      )
    },

    async exclude(tenantId, emails, kind) {
      const wanted = [
        ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
      ]
      if (wanted.length === 0) return
      await withTenant(db, tenantId, async (tx) => {
        const insert = tx
          .insert(joinExclusions)
          .values(wanted.map((email) => ({ tenantId, email, kind })))
        // ⚠ BLOCKED IS THE STRONGER KIND: it replaces removed, never the reverse.
        await (kind === "blocked"
          ? insert.onConflictDoUpdate({
              target: [joinExclusions.tenantId, joinExclusions.email],
              set: { kind: "blocked" },
            })
          : insert.onConflictDoNothing())
      })
    },

    async allow(tenantId, emails) {
      const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()))]
      if (wanted.length === 0) return
      await withTenant(db, tenantId, (tx) =>
        tx
          .delete(joinExclusions)
          .where(
            and(
              eq(joinExclusions.tenantId, tenantId),
              inArray(joinExclusions.email, wanted),
            ),
          ),
      )
    },

    async joins(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx.select().from(joinMemberships).where(eq(joinMemberships.tenantId, tenantId)),
      )
      return rows.map((r) => ({
        user_id: r.userId,
        email: r.email,
        how: r.how === "auto" ? "auto" : r.how === "join" ? "join" : "request",
        via: r.via,
        created_at: r.createdAt.toISOString(),
      }))
    },

    async forgetJoin(tenantId, userId) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .delete(joinMemberships)
          .where(
            and(
              eq(joinMemberships.tenantId, tenantId),
              eq(joinMemberships.userId, userId),
            ),
          ),
      )
    },

    async recordJoin(tenantId, { userId, email, how, via }) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .insert(joinMemberships)
          .values({ tenantId, userId, email: email.toLowerCase(), how, via })
          .onConflictDoUpdate({
            target: [joinMemberships.tenantId, joinMemberships.userId],
            set: { email: email.toLowerCase(), how, via },
          }),
      )
    },

    async fileRequest(tenantId, { userId, email, via, full }) {
      const made = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(joinRequests)
          .values({ tenantId, userId, email: email.toLowerCase(), via, full })
          .onConflictDoNothing()
          .returning({ id: joinRequests.id }),
      )
      return made.length > 0 ? "created" : "exists"
    },

    async accessFor({ currentTenantId, userId, emails }) {
      const names = cleanDomains(domainsOf(emails).flatMap(coveringNames))
      if (names.length === 0)
        return { domains: [], requested: new Set(), joined: new Set() }
      return withTenant(db, currentTenantId, async (tx) => {
        await asSeeker(tx, userId, names)
        const rows = await tx
          .select({
            tenantId: joinDomains.tenantId,
            clerkOrgId: joinDomains.clerkOrgId,
            name: joinDomains.name,
            rules: joinDomains.rules,
          })
          .from(joinDomains)
          .where(and(inArray(joinDomains.name, names), active))
        const open = await tx
          .select({ tenantId: joinRequests.tenantId })
          .from(joinRequests)
          .where(and(eq(joinRequests.userId, userId), isNull(joinRequests.answeredAt)))
        const joined = await tx
          .select({ tenantId: joinMemberships.tenantId })
          .from(joinMemberships)
          .where(eq(joinMemberships.userId, userId))
        return {
          domains: rows,
          requested: new Set(open.map((r) => r.tenantId)),
          joined: new Set(joined.map((r) => r.tenantId)),
        }
      })
    },

    async arrivals(userId, since) {
      return withTenant(db, NO_TENANT, async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
        const joined = await tx
          .select({ tenantId: joinMemberships.tenantId, via: joinMemberships.via })
          .from(joinMemberships)
          .where(
            and(
              eq(joinMemberships.userId, userId),
              eq(joinMemberships.how, "auto"),
              gte(joinMemberships.createdAt, since),
            ),
          )
        const full = await tx
          .select({ tenantId: joinRequests.tenantId, via: joinRequests.via })
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.userId, userId),
              eq(joinRequests.full, true),
              isNull(joinRequests.answeredAt),
              gte(joinRequests.createdAt, since),
            ),
          )
        return [
          ...joined.map((r) => ({ ...r, outcome: "joined" as const })),
          ...full.map((r) => ({ ...r, outcome: "full" as const })),
        ]
      })
    },
  }
}

/**
 * The nightly re-check of access proofs (#326), run with the domain re-check.
 *
 * ⚠ A LAPSED PROOF STOPS ITS RULES AT ONCE, UNLIKE A SENDING DOMAIN'S WEEK OF
 * GRACE. Standing a sending domain down breaks somebody's mail, so absence
 * has to persist; a lapsed access domain only stops strangers being let in,
 * which is the safe direction to fail. It comes back by itself the night the
 * record is there again, or at once on Verify.
 *
 * ⚠ A FAILURE TO ASK IS NEVER AN ANSWER: `unreachable` writes nothing.
 */
export async function recheckAccessDomains({
  db,
  lookup,
  now = () => new Date(),
  intervalMs = 24 * 60 * 60 * 1000,
  batch = 200,
}: {
  db: Database
  lookup: TxtLookup
  now?: () => Date
  intervalMs?: number
  batch?: number
}): Promise<{
  checked: number
  lapsed: number
  restored: number
  unreachable: number
}> {
  const summary = { checked: 0, lapsed: 0, restored: 0, unreachable: 0 }
  const before = new Date(now().getTime() - intervalMs)
  const due = await withTenant(db, NO_TENANT, async (tx) => {
    await tx.execute(sql`select set_config('app.join_recheck', 'on', true)`)
    return tx
      .select()
      .from(joinDomains)
      .where(
        and(
          // /domains entries from before #326 have no `verified_at` until synced.
          or(isNotNull(joinDomains.verifiedAt), eq(joinDomains.source, "domains")),
          isNull(joinDomains.displacedAt),
          or(isNull(joinDomains.checkedAt), lt(joinDomains.checkedAt, before)),
        ),
      )
      .orderBy(joinDomains.checkedAt)
      .limit(batch)
  })
  const tenants = new Set<string>()
  for (const row of due) {
    if (row.source === "domains") {
      tenants.add(row.tenantId)
      continue
    }
    let published: string[]
    try {
      published = await lookup(accessTxtName(row.name))
    } catch {
      summary.unreachable += 1
      continue
    }
    summary.checked += 1
    const proven = published.some(
      (v) => v.replace(/["\s]/g, "") === accessTxtValue(row.token),
    )
    if (proven && row.lapsedAt) summary.restored += 1
    if (!proven && !row.lapsedAt) summary.lapsed += 1
    await withTenant(db, row.tenantId, (tx) =>
      tx
        .update(joinDomains)
        .set({
          checkedAt: now(),
          lapsedAt: proven ? null : (row.lapsedAt ?? now()),
        })
        .where(and(eq(joinDomains.id, row.id), eq(joinDomains.tenantId, row.tenantId))),
    )
  }
  // /domains-sourced entries follow their sending domain, which has its own re-check.
  for (const tenantId of tenants) {
    await withTenant(db, tenantId, async (tx) => {
      await syncFromDomains(tx, tenantId, now())
      await tx
        .update(joinDomains)
        .set({ checkedAt: now() })
        .where(
          and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.source, "domains")),
        )
    })
    summary.checked += 1
  }
  return summary
}
