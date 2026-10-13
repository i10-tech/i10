import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { domains, joinDomains, joinRequests } from "../db/core.js"

/**
 * Join suggestions and requests, ours (2026-10-13) - what Clerk's "verified
 * organization domains" did, which is not on our Clerk plan. See
 * `join_domains` in db/core.ts for the two audiences and their policies.
 *
 * ⚠ THE SEEKER'S DOMAINS COME FROM THE CALLER, WHO READS THEM FROM CLERK'S
 * VERIFIED ADDRESSES - never from a request body. Everything a seeker can see
 * or do here is bounded by that list and by their own user id.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export interface JoinRequestRow {
  id: string
  user_id: string
  email: string
  created_at: string
}

export interface Suggestion {
  tenantId: string
  clerkOrgId: string
  domain: string
  /** They have asked, and nobody has answered yet. */
  requested: boolean
}

export interface JoinStore {
  /** This workspace's domains with suggestions on, lowercased. */
  enabled(tenantId: string): Promise<string[]>
  /**
   * Switches suggestions for one of this workspace's verified domains.
   * `missing` when the name is not a verified domain of the workspace.
   */
  set(
    tenantId: string,
    input: { name: string; on: boolean; clerkOrgId: string },
  ): Promise<"ok" | "missing">
  /** Workspaces suggesting one of these domains, other than `exceptOrgIds`. */
  suggestionsFor(input: {
    currentTenantId: string
    userId: string
    seekerDomains: string[]
    exceptOrgIds: string[]
  }): Promise<Suggestion[]>
  /** Asks to join; `not_suggested` unless the workspace suggests their domain. */
  request(input: {
    currentTenantId: string
    userId: string
    email: string
    seekerDomains: string[]
    tenantId: string
  }): Promise<"created" | "exists" | "not_suggested">
  /** This workspace's unanswered requests, newest first. */
  pending(tenantId: string): Promise<JoinRequestRow[]>
  /** Marks a request answered; null when it is not this workspace's or is answered. */
  answer(tenantId: string, id: string, accept: boolean): Promise<JoinRequestRow | null>
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

const row = (r: typeof joinRequests.$inferSelect): JoinRequestRow => ({
  id: r.id,
  user_id: r.userId,
  email: r.email,
  created_at: r.createdAt.toISOString(),
})

export function joinStore(db: Database): JoinStore {
  return {
    async enabled(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: joinDomains.name })
          .from(joinDomains)
          .where(eq(joinDomains.tenantId, tenantId)),
      )
      return rows.map((r) => r.name)
    },

    async set(tenantId, { name, on, clerkOrgId }) {
      const lower = name.trim().toLowerCase()
      return withTenant(db, tenantId, async (tx) => {
        if (!on) {
          await tx
            .delete(joinDomains)
            .where(and(eq(joinDomains.tenantId, tenantId), eq(joinDomains.name, lower)))
          return "ok"
        }
        // ⚠ ONLY A DOMAIN THIS WORKSPACE HAS VERIFIED: DNS is the proof.
        const [domain] = await tx
          .select({ id: domains.id })
          .from(domains)
          .where(
            and(
              eq(domains.tenantId, tenantId),
              eq(domains.name, lower),
              eq(domains.status, "verified"),
            ),
          )
          .limit(1)
        if (!domain) return "missing"
        await tx
          .insert(joinDomains)
          .values({ tenantId, domainId: domain.id, name: lower, clerkOrgId })
          .onConflictDoUpdate({
            target: [joinDomains.tenantId, joinDomains.name],
            set: { domainId: domain.id, clerkOrgId },
          })
        return "ok"
      })
    },

    async suggestionsFor({ currentTenantId, userId, seekerDomains, exceptOrgIds }) {
      const names = cleanDomains(seekerDomains)
      if (names.length === 0) return []
      return withTenant(db, currentTenantId, async (tx) => {
        await asSeeker(tx, userId, names)
        const offered = await tx
          .select({
            tenantId: joinDomains.tenantId,
            clerkOrgId: joinDomains.clerkOrgId,
            domain: joinDomains.name,
          })
          .from(joinDomains)
          .where(inArray(joinDomains.name, names))
        const open = await tx
          .select({ tenantId: joinRequests.tenantId })
          .from(joinRequests)
          .where(and(eq(joinRequests.userId, userId), isNull(joinRequests.answeredAt)))
        const asked = new Set(open.map((r) => r.tenantId))
        // One suggestion per workspace, whichever of its domains matched first.
        const seen = new Set<string>()
        return offered.flatMap((o) => {
          if (exceptOrgIds.includes(o.clerkOrgId) || seen.has(o.tenantId)) return []
          seen.add(o.tenantId)
          return [{ ...o, requested: asked.has(o.tenantId) }]
        })
      })
    },

    async request({ currentTenantId, userId, email, seekerDomains, tenantId }) {
      return withTenant(db, currentTenantId, async (tx) => {
        await asSeeker(tx, userId, seekerDomains)
        const [suggested] = await tx
          .select({ id: joinDomains.id })
          .from(joinDomains)
          .where(
            and(
              eq(joinDomains.tenantId, tenantId),
              inArray(joinDomains.name, cleanDomains(seekerDomains)),
            ),
          )
          .limit(1)
        if (!suggested) return "not_suggested"
        const made = await tx
          .insert(joinRequests)
          .values({ tenantId, userId, email: email.toLowerCase() })
          .onConflictDoNothing()
          .returning({ id: joinRequests.id })
        return made.length > 0 ? "created" : "exists"
      })
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
      return rows.map(row)
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
      return answered ? row(answered) : null
    },
  }
}
