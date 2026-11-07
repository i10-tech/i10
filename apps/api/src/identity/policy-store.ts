import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { joinDomains, workspaceRoles } from "../db/core.js"
import {
  bypassSignIns,
  bypassUsers,
  connectionDomains,
  connections,
  events,
  managedAccounts,
  setupLinks,
  ssoSessions,
  testRuns,
  workspaceSettings,
} from "../db/identity.js"
import { NO_TENANT } from "../middleware/tenant.js"
import type { Enforcement } from "./model.js"
import type {
  BypassEntry,
  DiscoveredConnection,
  RequiredConnection,
  SetupLinkRow,
  SsoPolicyStore,
} from "./ports.js"

/**
 * The database half of enforcement, break-glass, setup links and home realm
 * discovery (#340, sso.md 2.10 and decision 7). See db/identity.ts for the
 * tables and the policies each read relies on.
 *
 * ⚠ TWO OUTSIDER READS, EACH ON ONE SETTING. A setup link's hash
 * (`app.setup_token`, `setup_links_hash_read`) reads exactly its own row; an
 * address's domain (`app.seeker_domains`, #326's `join_domains_seeker_read`)
 * reads the proofs of exactly that name. Everything after either is read
 * under `withTenant` with the tenant taken from the row, never the request.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/** How long a first owner's request to turn the exemption off can be approved. */
export const EXEMPTION_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

const REQUIRED: readonly Enforcement[] = ["required_domain", "required_all"]

/** A proof a sign-in may use: verified, not lapsed, not displaced. */
const liveProof = sql`${joinDomains.verifiedAt} is not null and ${joinDomains.lapsedAt} is null and ${joinDomains.displacedAt} is null`

async function asOutsider<T>(
  db: Database,
  setting: "app.setup_token" | "app.seeker_domains",
  value: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // ⚠ THE NIL TENANT, as identity/store.ts explains: the workspace policy is
  // evaluated beside the outsider one and must have a setting to read.
  return withTenant(db, NO_TENANT, async (tx) => {
    await tx.execute(sql`select set_config(${setting}, ${value}, true)`)
    return fn(tx)
  })
}

const toLink = (r: typeof setupLinks.$inferSelect): SetupLinkRow => ({
  id: r.id,
  tenantId: r.tenantId,
  connectionId: r.connectionId,
  contactEmail: r.contactEmail,
  createdBy: r.createdBy,
  expiresAt: r.expiresAt,
  usedAt: r.usedAt,
  revokedAt: r.revokedAt,
  revokedReason: r.revokedReason,
  createdAt: r.createdAt,
})

const toBypass = (r: typeof bypassUsers.$inferSelect): BypassEntry => ({
  clerkUserId: r.clerkUserId,
  reason: r.reason,
  addedBy: r.addedBy,
  createdAt: r.createdAt,
})

/** A request is live while it is younger than a day. */
const liveRequest = (
  row: { exemptionOffRequestedBy: string | null; exemptionOffRequestedAt: Date | null },
  now: Date,
) =>
  row.exemptionOffRequestedBy !== null &&
  row.exemptionOffRequestedAt !== null &&
  now.getTime() - row.exemptionOffRequestedAt.getTime() < EXEMPTION_REQUEST_TTL_MS

export function ssoPolicyStore(db: Database): SsoPolicyStore {
  /** The settings row under a lock, made with its defaults first when missing. */
  const lockedSettings = async (tx: Tx, tenantId: string) => {
    await tx.insert(workspaceSettings).values({ tenantId }).onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId))
      .for("update")
      .limit(1)
    return row!
  }

  return {
    async enforcementRead(tenantId, clerkUserId, sessionId) {
      return withTenant(db, tenantId, async (tx) => {
        const required = await tx
          .select({
            id: connections.id,
            enforcement: connections.enforcement,
            createdAt: connections.createdAt,
          })
          .from(connections)
          .where(
            and(
              eq(connections.tenantId, tenantId),
              eq(connections.status, "active"),
              inArray(connections.enforcement, [...REQUIRED]),
            ),
          )
          .orderBy(connections.createdAt)
        if (required.length === 0) return { required: false as const }
        const ids = required.map((r) => r.id)
        const domains = await tx
          .select({
            connectionId: connectionDomains.connectionId,
            name: joinDomains.name,
          })
          .from(connectionDomains)
          .innerJoin(joinDomains, eq(joinDomains.id, connectionDomains.joinDomainId))
          .where(
            and(
              eq(connectionDomains.tenantId, tenantId),
              eq(joinDomains.tenantId, tenantId),
              inArray(connectionDomains.connectionId, ids),
              sql`${liveProof}`,
            ),
          )
        const bypassed = await tx
          .select({ connectionId: bypassUsers.connectionId })
          .from(bypassUsers)
          .where(
            and(
              eq(bypassUsers.tenantId, tenantId),
              eq(bypassUsers.clerkUserId, clerkUserId),
              inArray(bypassUsers.connectionId, ids),
            ),
          )
        const [settings] = await tx
          .select({ exemption: workspaceSettings.ownerExemption })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1)
        const [role] = await tx
          .select({ role: workspaceRoles.role })
          .from(workspaceRoles)
          .where(
            and(
              eq(workspaceRoles.tenantId, tenantId),
              eq(workspaceRoles.clerkUserId, clerkUserId),
            ),
          )
          .limit(1)
        const [session] = await tx
          .select({
            boundAt: ssoSessions.boundAt,
            lastSeenAt: ssoSessions.lastSeenAt,
            revokedAt: ssoSessions.revokedAt,
            status: connections.status,
            maxSessionSeconds: connections.maxSessionSeconds,
            idleTimeoutSeconds: connections.idleTimeoutSeconds,
            domainLive: sql<boolean>`exists (
              select 1 from ${connectionDomains}
                join ${joinDomains} on ${joinDomains.id} = ${connectionDomains.joinDomainId}
               where ${connectionDomains.connectionId} = ${ssoSessions.connectionId}
                 and ${liveProof})`,
          })
          .from(ssoSessions)
          .innerJoin(connections, eq(connections.id, ssoSessions.connectionId))
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
              eq(ssoSessions.clerkUserId, clerkUserId),
            ),
          )
          .limit(1)
        /*
         * ⚠ MANAGED IN ANY WORKSPACE, read as the user (`managed_accounts_
         * user_read`): an owner whom another workspace manages is not exempt
         * here either, since their way in is that workspace's IdP.
         */
        await tx.execute(sql`select set_config('app.user_id', ${clerkUserId}, true)`)
        const [managed] = await tx
          .select({ id: managedAccounts.clerkUserId })
          .from(managedAccounts)
          .where(eq(managedAccounts.clerkUserId, clerkUserId))
          .limit(1)
        const listed = new Set(bypassed.map((b) => b.connectionId))
        return {
          required: true as const,
          connections: required.map((r): RequiredConnection => ({
            id: r.id,
            enforcement: r.enforcement as RequiredConnection["enforcement"],
            createdAt: r.createdAt,
            domains: domains.filter((d) => d.connectionId === r.id).map((d) => d.name),
            bypassed: listed.has(r.id),
          })),
          exemption: settings?.exemption ?? true,
          privileged: role?.role === "owner" || role?.role === "admin",
          managed: Boolean(managed),
          session:
            session &&
            !session.revokedAt &&
            session.status === "active" &&
            Boolean(session.domainLive)
              ? {
                  boundAt: session.boundAt,
                  lastSeenAt: session.lastSeenAt,
                  revokedAt: session.revokedAt,
                  maxSessionSeconds: session.maxSessionSeconds,
                  idleTimeoutSeconds: session.idleTimeoutSeconds,
                }
              : null,
        }
      })
    },

    async noteBypassSignIn(tenantId, row) {
      const first = row.connectionIds[0]
      if (!first) return false
      return withTenant(db, tenantId, async (tx) => {
        const made = await tx
          .insert(bypassSignIns)
          .values({
            tenantId,
            sessionId: row.sessionId,
            clerkUserId: row.clerkUserId,
            connectionId: first,
          })
          .onConflictDoNothing()
          .returning({ id: bypassSignIns.sessionId })
        if (made.length === 0) return false
        await tx.insert(events).values({
          tenantId,
          type: "sso.bypass_used",
          subjectUserId: row.clerkUserId,
          sessionId: row.sessionId,
          connectionId: first,
          reason: "bypass_list",
          data: { connections: row.connectionIds },
        })
        return true
      })
    },

    async bypassList(tenantId, connectionId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(bypassUsers)
          .where(
            and(
              eq(bypassUsers.tenantId, tenantId),
              eq(bypassUsers.connectionId, connectionId),
            ),
          )
          .orderBy(bypassUsers.createdAt),
      )
      return rows.map(toBypass)
    },

    async addBypass(tenantId, connectionId, entry) {
      return withTenant(db, tenantId, async (tx) => {
        const [connection] = await tx
          .select({ id: connections.id })
          .from(connections)
          .where(
            and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)),
          )
          .limit(1)
        if (!connection) return "not_found" as const
        const made = await tx
          .insert(bypassUsers)
          .values({
            tenantId,
            connectionId,
            clerkUserId: entry.clerkUserId,
            reason: entry.reason,
            addedBy: entry.addedBy,
          })
          .onConflictDoNothing()
          .returning({ id: bypassUsers.clerkUserId })
        return made.length > 0 ? ("added" as const) : ("exists" as const)
      })
    },

    async removeBypass(tenantId, connectionId, clerkUserId) {
      const [gone] = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(bypassUsers)
          .where(
            and(
              eq(bypassUsers.tenantId, tenantId),
              eq(bypassUsers.connectionId, connectionId),
              eq(bypassUsers.clerkUserId, clerkUserId),
            ),
          )
          .returning(),
      )
      return gone ? toBypass(gone) : null
    },

    async ownerExemption(tenantId, now) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1),
      )
      if (!row) return { enabled: true, pending: null }
      return {
        enabled: row.ownerExemption,
        pending:
          row.ownerExemption && liveRequest(row, now)
            ? {
                requestedBy: row.exemptionOffRequestedBy!,
                requestedAt: row.exemptionOffRequestedAt!,
                expiresAt: new Date(
                  row.exemptionOffRequestedAt!.getTime() + EXEMPTION_REQUEST_TTL_MS,
                ),
              }
            : null,
      }
    },

    async requestExemptionOff(tenantId, by, now) {
      return withTenant(db, tenantId, async (tx) => {
        const row = await lockedSettings(tx, tenantId)
        if (!row.ownerExemption) return "off" as const
        if (liveRequest(row, now)) return "pending" as const
        await tx
          .update(workspaceSettings)
          .set({ exemptionOffRequestedBy: by, exemptionOffRequestedAt: now })
          .where(eq(workspaceSettings.tenantId, tenantId))
        return "requested" as const
      })
    },

    async approveExemptionOff(tenantId, by, now) {
      return withTenant(db, tenantId, async (tx) => {
        const row = await lockedSettings(tx, tenantId)
        if (!row.ownerExemption || !liveRequest(row, now))
          return { outcome: "none" as const }
        const requestedBy = row.exemptionOffRequestedBy!
        if (requestedBy === by) return { outcome: "same_owner" as const }
        /*
         * ⚠ THE FIRST OWNER MUST STILL BE ONE. A request from somebody demoted
         * since is one owner's decision, not two.
         */
        const [role] = await tx
          .select({ role: workspaceRoles.role })
          .from(workspaceRoles)
          .where(
            and(
              eq(workspaceRoles.tenantId, tenantId),
              eq(workspaceRoles.clerkUserId, requestedBy),
            ),
          )
          .limit(1)
        if (role?.role !== "owner") return { outcome: "none" as const }
        await tx
          .update(workspaceSettings)
          .set({
            ownerExemption: false,
            exemptionOffRequestedBy: null,
            exemptionOffRequestedAt: null,
            updatedBy: by,
            updatedAt: now,
          })
          .where(eq(workspaceSettings.tenantId, tenantId))
        return { outcome: "applied" as const, requestedBy }
      })
    },

    async cancelExemptionOff(tenantId) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(workspaceSettings)
          .set({ exemptionOffRequestedBy: null, exemptionOffRequestedAt: null })
          .where(
            and(
              eq(workspaceSettings.tenantId, tenantId),
              isNotNull(workspaceSettings.exemptionOffRequestedBy),
            ),
          )
          .returning({ id: workspaceSettings.tenantId }),
      )
      return done.length > 0
    },

    async enableExemption(tenantId, by) {
      return withTenant(db, tenantId, async (tx) => {
        const row = await lockedSettings(tx, tenantId)
        if (row.ownerExemption && row.exemptionOffRequestedBy === null) return false
        await tx
          .update(workspaceSettings)
          .set({
            ownerExemption: true,
            exemptionOffRequestedBy: null,
            exemptionOffRequestedAt: null,
            updatedBy: by,
            updatedAt: new Date(),
          })
          .where(eq(workspaceSettings.tenantId, tenantId))
        return true
      })
    },

    async passedTestRunSince(tenantId, connectionId, since) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(
            and(
              eq(testRuns.tenantId, tenantId),
              eq(testRuns.connectionId, connectionId),
              eq(testRuns.outcome, "passed"),
              gte(testRuns.createdAt, since),
            ),
          )
          .limit(1),
      )
      return rows.length > 0
    },

    async discover(domain) {
      // ⚠ ONE NAME, NO LIST: a comma would make it two (`app.seeker_domains`).
      if (!/^[a-z0-9.-]{1,253}$/.test(domain)) return []
      const proofs = await asOutsider(db, "app.seeker_domains", domain, (tx) =>
        tx
          .select({ id: joinDomains.id, tenantId: joinDomains.tenantId })
          .from(joinDomains)
          .where(and(eq(joinDomains.name, domain), sql`${liveProof}`)),
      )
      const found: DiscoveredConnection[] = []
      for (const tenantId of new Set(proofs.map((p) => p.tenantId))) {
        const ids = proofs.filter((p) => p.tenantId === tenantId).map((p) => p.id)
        const rows = await withTenant(db, tenantId, (tx) =>
          tx
            .select({
              id: connections.id,
              name: connections.name,
              enforcement: connections.enforcement,
              createdAt: connections.createdAt,
            })
            .from(connectionDomains)
            .innerJoin(connections, eq(connections.id, connectionDomains.connectionId))
            .where(
              and(
                eq(connectionDomains.tenantId, tenantId),
                eq(connections.tenantId, tenantId),
                inArray(connectionDomains.joinDomainId, ids),
                eq(connections.status, "active"),
              ),
            ),
        )
        for (const r of rows)
          found.push({ ...r, tenantId, enforcement: r.enforcement as Enforcement })
      }
      return found
    },

    async createSetupLink(tenantId, input) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(setupLinks)
          .values({
            tenantId,
            connectionId: input.connectionId,
            tokenHash: input.tokenHash,
            contactEmail: input.contactEmail,
            createdBy: input.createdBy,
            expiresAt: input.expiresAt,
          })
          .returning(),
      )
      return toLink(row!)
    },

    async setupLinks(tenantId, connectionId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(setupLinks)
          .where(
            and(
              eq(setupLinks.tenantId, tenantId),
              eq(setupLinks.connectionId, connectionId),
            ),
          )
          .orderBy(desc(setupLinks.createdAt))
          .limit(100),
      )
      return rows.map(toLink)
    },

    async revokeSetupLink(tenantId, connectionId, id, reason, at) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(setupLinks)
          .set({ revokedAt: at, revokedReason: reason })
          .where(
            and(
              eq(setupLinks.tenantId, tenantId),
              eq(setupLinks.connectionId, connectionId),
              eq(setupLinks.id, id),
              isNull(setupLinks.revokedAt),
            ),
          )
          .returning(),
      )
      return row ? toLink(row) : null
    },

    async revokeSetupLinksOf(tenantId, connectionId, reason, at) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .update(setupLinks)
          .set({ revokedAt: at, revokedReason: reason })
          .where(
            and(
              eq(setupLinks.tenantId, tenantId),
              eq(setupLinks.connectionId, connectionId),
              isNull(setupLinks.revokedAt),
              gt(setupLinks.expiresAt, at),
            ),
          )
          .returning({ id: setupLinks.id }),
      )
      return rows.map((r) => r.id)
    },

    async setupLinkByHash(tokenHash) {
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null
      const [row] = await asOutsider(db, "app.setup_token", tokenHash, (tx) =>
        tx
          .select()
          .from(setupLinks)
          .where(eq(setupLinks.tokenHash, tokenHash))
          .limit(1),
      )
      return row ? { ...toLink(row), tokenHash: row.tokenHash } : null
    },

    async markSetupLinkUsed(tenantId, id, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(setupLinks)
          .set({ usedAt: at })
          .where(
            and(
              eq(setupLinks.tenantId, tenantId),
              eq(setupLinks.id, id),
              isNull(setupLinks.usedAt),
            ),
          )
          .returning({ id: setupLinks.id }),
      )
      return done.length > 0
    },
  }
}
