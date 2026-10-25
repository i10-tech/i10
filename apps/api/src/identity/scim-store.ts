import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  sql,
} from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { joinDomains, joinRequests } from "../db/core.js"
import {
  directories,
  directoryGroups,
  directoryMemberships,
  directoryOutbox,
  directoryTokens,
  directoryUsers,
  directoryWatchChannels,
  events,
} from "../db/identity.js"
import { NO_TENANT } from "../middleware/tenant.js"
import type { AuditEvent } from "./ports.js"
import type {
  Directory,
  DirectoryConflict,
  DirectoryGroupRow,
  DirectoryProvider,
  DirectoryStore,
  DirectorySyncStatus,
  DirectoryToken,
  DirectoryUserRow,
  GoogleWatchEvent,
  OutboxEntry,
  WatchChannelRow,
} from "./directory-ports.js"
import type { StoredUser } from "./scim.js"

/**
 * The database half of SCIM directories (#342). See db/identity.ts for the
 * tables and the one outsider policy (`directory_tokens_hash_read`).
 *
 * ⚠ EVERY SCIM WRITE IS ONE TRANSACTION: the directory rows, the outbox
 * entries that tell the apply job about them, and the audit event. A crash
 * leaves all three or none, so a change is never stored without the job
 * hearing of it, and never audited without having happened.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/** Postgres' unique violation, with the constraint it hit. */
function uniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: unknown; constraint_name?: unknown; cause?: unknown }
  const inner = (e?.cause ?? e) as { code?: unknown; constraint_name?: unknown }
  return inner?.code === "23505" && inner?.constraint_name === constraint
}

const toDirectory = (r: typeof directories.$inferSelect): Directory => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  provider: r.provider as DirectoryProvider,
  enabled: r.enabled,
  createMailboxes: r.createMailboxes,
  adminEmail: r.adminEmail,
  domain: r.domain,
  lastSyncAt: r.lastSyncAt,
  lastSyncStatus: r.lastSyncStatus as DirectorySyncStatus | null,
  lastSyncError: r.lastSyncError,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})

const toWatchChannel = (
  r: typeof directoryWatchChannels.$inferSelect,
): WatchChannelRow => ({
  id: r.id,
  tenantId: r.tenantId,
  directoryId: r.directoryId,
  event: r.event as GoogleWatchEvent,
  resourceId: r.resourceId,
  tokenHash: r.tokenHash,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
})

const toToken = (r: typeof directoryTokens.$inferSelect): DirectoryToken => ({
  id: r.id,
  directoryId: r.directoryId,
  hint: r.hint,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
  lastUsedAt: r.lastUsedAt,
})

const toUser = (r: typeof directoryUsers.$inferSelect): DirectoryUserRow => ({
  id: r.id,
  tenantId: r.tenantId,
  directoryId: r.directoryId,
  userName: r.userName,
  externalId: r.externalId,
  displayName: r.displayName,
  givenName: r.givenName,
  familyName: r.familyName,
  email: r.email,
  active: r.active,
  resource: r.resource,
  clerkUserId: r.clerkUserId,
  conflict: r.conflict as DirectoryConflict | null,
  conflictDetail: r.conflictDetail ?? null,
  conflictAt: r.conflictAt,
  bannedByDirectory: r.bannedByDirectory,
  aliasesIgnored: r.aliasesIgnored,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt,
})

const toGroup = (r: typeof directoryGroups.$inferSelect): DirectoryGroupRow => ({
  id: r.id,
  tenantId: r.tenantId,
  directoryId: r.directoryId,
  displayName: r.displayName,
  externalId: r.externalId,
  resource: r.resource,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})

const userColumns = (input: StoredUser) => ({
  userName: input.userName,
  externalId: input.externalId,
  displayName: input.displayName,
  givenName: input.givenName,
  familyName: input.familyName,
  email: input.email,
  active: input.active,
  resource: input.resource,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A proof a directory's people may be on: verified, not lapsed, not displaced. */
const liveProof = sql`${joinDomains.verifiedAt} is not null and ${joinDomains.lapsedAt} is null and ${joinDomains.displacedAt} is null`

async function audit(tx: Tx, tenantId: string, event: AuditEvent) {
  await tx.insert(events).values({
    tenantId,
    type: event.type,
    actorUserId: event.actorUserId ?? null,
    subjectUserId: event.subjectUserId ?? null,
    connectionId: event.connectionId ?? null,
    sessionId: event.sessionId ?? null,
    reason: event.reason ?? null,
    data: event.data ?? {},
  })
}

async function outbox(
  tx: Tx,
  tenantId: string,
  directoryId: string,
  userIds: string[],
  cause: "created" | "updated" | "deleted" | "group",
): Promise<OutboxEntry[]> {
  if (userIds.length === 0) return []
  const made = await tx
    .insert(directoryOutbox)
    .values(
      userIds.map((directoryUserId) => ({
        tenantId,
        directoryId,
        directoryUserId,
        cause,
      })),
    )
    .returning({
      id: directoryOutbox.id,
      directoryUserId: directoryOutbox.directoryUserId,
    })
  return made
}

/** Live rows of this directory among `ids`: the members a group may hold. */
async function liveMembers(
  tx: Tx,
  tenantId: string,
  directoryId: string,
  ids: string[],
): Promise<string[]> {
  const wanted = ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase())
  if (wanted.length === 0) return []
  const found = new Set<string>()
  for (let i = 0; i < wanted.length; i += 1000) {
    const rows = await tx
      .select({ id: directoryUsers.id })
      .from(directoryUsers)
      .where(
        and(
          eq(directoryUsers.tenantId, tenantId),
          eq(directoryUsers.directoryId, directoryId),
          inArray(directoryUsers.id, wanted.slice(i, i + 1000)),
          isNull(directoryUsers.deletedAt),
        ),
      )
    for (const r of rows) found.add(r.id)
  }
  return wanted.filter((id) => found.has(id))
}

export function directoryStore(db: Database): DirectoryStore {
  return {
    // ── the console ──
    async createDirectory(tenantId, input) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(directories)
          .values({
            tenantId,
            name: input.name,
            provider: input.provider,
            enabled: input.enabled ?? input.provider !== "google",
            adminEmail: input.adminEmail ?? null,
            domain: input.domain ?? null,
            createdBy: input.createdBy,
          })
          .returning(),
      )
      return toDirectory(row!)
    },

    async directories(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(directories)
          .where(eq(directories.tenantId, tenantId))
          .orderBy(asc(directories.createdAt))
        if (rows.length === 0) return []
        const ids = rows.map((r) => r.id)
        const tokens = await tx
          .select()
          .from(directoryTokens)
          .where(
            and(
              eq(directoryTokens.tenantId, tenantId),
              inArray(directoryTokens.directoryId, ids),
            ),
          )
          .orderBy(desc(directoryTokens.createdAt))
        const users = await tx
          .select({
            directoryId: directoryUsers.directoryId,
            users: sql<number>`count(*) filter (where ${directoryUsers.deletedAt} is null)::int`,
            conflicts: sql<number>`count(*) filter (where ${directoryUsers.conflict} is not null)::int`,
          })
          .from(directoryUsers)
          .where(eq(directoryUsers.tenantId, tenantId))
          .groupBy(directoryUsers.directoryId)
        const pending = await tx
          .select({ directoryId: directoryOutbox.directoryId, n: count() })
          .from(directoryOutbox)
          .where(
            and(
              eq(directoryOutbox.tenantId, tenantId),
              isNull(directoryOutbox.appliedAt),
            ),
          )
          .groupBy(directoryOutbox.directoryId)
        return rows.map((r) => {
          const u = users.find((x) => x.directoryId === r.id)
          return {
            ...toDirectory(r),
            tokens: tokens.filter((t) => t.directoryId === r.id).map(toToken),
            users: u?.users ?? 0,
            conflicts: u?.conflicts ?? 0,
            pending: pending.find((p) => p.directoryId === r.id)?.n ?? 0,
          }
        })
      })
    },

    async directory(tenantId, id) {
      if (!UUID.test(id)) return null
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directories)
          .where(and(eq(directories.tenantId, tenantId), eq(directories.id, id)))
          .limit(1),
      )
      return row ? toDirectory(row) : null
    },

    async updateDirectory(tenantId, id, patch) {
      if (!UUID.test(id)) return null
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(directories)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(directories.tenantId, tenantId), eq(directories.id, id)))
          .returning(),
      )
      return row ? toDirectory(row) : null
    },

    async noteDirectorySync(tenantId, id, input) {
      if (!UUID.test(id)) return
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(directories)
          .set({
            lastSyncAt: input.at,
            lastSyncStatus: input.status,
            lastSyncError: input.error,
            updatedAt: input.at,
          })
          .where(and(eq(directories.tenantId, tenantId), eq(directories.id, id))),
      )
    },

    async dueGoogleDirectories(after, limit) {
      if (after !== null && !UUID.test(after)) return []
      const rows = (await db.execute(
        sql`select * from identity.google_directories_due(${after}::uuid, ${Math.trunc(limit)})`,
      )) as unknown as { id: string; tenant_id: string }[]
      return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }))
    },

    async watchChannels(tenantId, directoryId) {
      if (!UUID.test(directoryId)) return []
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryWatchChannels)
          .where(
            and(
              eq(directoryWatchChannels.tenantId, tenantId),
              eq(directoryWatchChannels.directoryId, directoryId),
            ),
          )
          .orderBy(asc(directoryWatchChannels.createdAt)),
      )
      return rows.map(toWatchChannel)
    },

    async saveWatchChannel(tenantId, input) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .insert(directoryWatchChannels)
          .values({
            id: input.id,
            tenantId,
            directoryId: input.directoryId,
            event: input.event,
            resourceId: input.resourceId,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          })
          .returning(),
      )
      return toWatchChannel(row!)
    },

    async deleteWatchChannels(tenantId, directoryId, ids) {
      if (!UUID.test(directoryId)) return []
      if (ids !== undefined) {
        const clean = ids.filter((x) => UUID.test(x))
        if (clean.length === 0) return []
        const gone = await withTenant(db, tenantId, (tx) =>
          tx
            .delete(directoryWatchChannels)
            .where(
              and(
                eq(directoryWatchChannels.tenantId, tenantId),
                eq(directoryWatchChannels.directoryId, directoryId),
                inArray(directoryWatchChannels.id, clean),
              ),
            )
            .returning(),
        )
        return gone.map(toWatchChannel)
      }
      const gone = await withTenant(db, tenantId, (tx) =>
        tx
          .delete(directoryWatchChannels)
          .where(
            and(
              eq(directoryWatchChannels.tenantId, tenantId),
              eq(directoryWatchChannels.directoryId, directoryId),
            ),
          )
          .returning(),
      )
      return gone.map(toWatchChannel)
    },

    async watchChannelById(id) {
      if (!UUID.test(id)) return null
      const lower = id.toLowerCase()
      const [row] = await withTenant(db, NO_TENANT, async (tx) => {
        await tx.execute(sql`select set_config('app.google_channel', ${lower}, true)`)
        return tx
          .select()
          .from(directoryWatchChannels)
          .where(eq(directoryWatchChannels.id, lower))
          .limit(1)
      })
      return row ? toWatchChannel(row) : null
    },

    async issueToken(tenantId, directoryId, input, now) {
      return withTenant(db, tenantId, async (tx) => {
        const [dir] = await tx
          .select({ id: directories.id })
          .from(directories)
          .where(
            and(eq(directories.tenantId, tenantId), eq(directories.id, directoryId)),
          )
          .for("update")
          .limit(1)
        if (!dir) return null
        const until = new Date(now.getTime() + input.overlapMs)
        const live = and(
          eq(directoryTokens.tenantId, tenantId),
          eq(directoryTokens.directoryId, directoryId),
          isNull(directoryTokens.revokedAt),
          or(isNull(directoryTokens.expiresAt), gt(directoryTokens.expiresAt, now)),
        )
        if (input.overlapMs === 0)
          await tx.update(directoryTokens).set({ revokedAt: now }).where(live)
        else
          await tx
            .update(directoryTokens)
            .set({
              // ⚠ NEVER LENGTHENS: an older token keeps the sooner of its own expiry and this one.
              expiresAt: sql`least(coalesce(${directoryTokens.expiresAt}, ${until.toISOString()}::timestamptz), ${until.toISOString()}::timestamptz)`,
            })
            .where(live)
        const [made] = await tx
          .insert(directoryTokens)
          .values({
            tenantId,
            directoryId,
            tokenHash: input.tokenHash,
            hint: input.hint,
            createdBy: input.createdBy,
            createdAt: now,
          })
          .returning()
        return toToken(made!)
      })
    },

    async revokeToken(tenantId, directoryId, tokenId, at) {
      if (!UUID.test(tokenId)) return false
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryTokens)
          .set({ revokedAt: at })
          .where(
            and(
              eq(directoryTokens.tenantId, tenantId),
              eq(directoryTokens.directoryId, directoryId),
              eq(directoryTokens.id, tokenId),
              isNull(directoryTokens.revokedAt),
            ),
          )
          .returning({ id: directoryTokens.id }),
      )
      return done.length > 0
    },

    async conflicts(tenantId, directoryId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.directoryId, directoryId),
              isNotNull(directoryUsers.conflict),
            ),
          )
          .orderBy(desc(directoryUsers.conflictAt))
          .limit(500),
      )
      return rows.map(toUser)
    },

    // ── credentials ──
    async tokenByHash(tokenHash) {
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null
      /*
       * ⚠ THE NIL TENANT AND THE TOKEN'S HASH, AS identity/store.ts's outsider
       * reads do: the workspace policy is evaluated beside the hash policy and
       * must have a setting to read; the nil uuid matches no workspace.
       */
      const [row] = await withTenant(db, NO_TENANT, async (tx) => {
        await tx.execute(sql`select set_config('app.scim_token', ${tokenHash}, true)`)
        return tx
          .select()
          .from(directoryTokens)
          .where(eq(directoryTokens.tokenHash, tokenHash))
          .limit(1)
      })
      return row
        ? {
            id: row.id,
            tenantId: row.tenantId,
            directoryId: row.directoryId,
            tokenHash: row.tokenHash,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            lastUsedAt: row.lastUsedAt,
          }
        : null
    },

    async touchToken(tenantId, tokenId, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryTokens)
          .set({ lastUsedAt: at })
          .where(
            and(
              eq(directoryTokens.tenantId, tenantId),
              eq(directoryTokens.id, tokenId),
              or(
                isNull(directoryTokens.lastUsedAt),
                lt(directoryTokens.lastUsedAt, new Date(at.getTime() - 60_000)),
              ),
            ),
          ),
      )
    },

    // ── Users ──
    async listUsers(tenantId, directoryId, input) {
      const f = input.filter
      const where = and(
        eq(directoryUsers.tenantId, tenantId),
        eq(directoryUsers.directoryId, directoryId),
        isNull(directoryUsers.deletedAt),
        f?.attr === "userName"
          ? sql`lower(${directoryUsers.userName}) = lower(${f.value})`
          : f?.attr === "externalId"
            ? eq(directoryUsers.externalId, f.value)
            : f?.attr === "emails.value"
              ? sql`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${directoryUsers.resource}->'emails') = 'array' then ${directoryUsers.resource}->'emails' else '[]'::jsonb end) e where lower(e->>'value') = lower(${f.value}))`
              : undefined,
      )
      return withTenant(db, tenantId, async (tx) => {
        const [total] = await tx
          .select({ n: count() })
          .from(directoryUsers)
          .where(where)
        const rows =
          input.count === 0
            ? []
            : await tx
                .select()
                .from(directoryUsers)
                .where(where)
                .orderBy(asc(directoryUsers.createdAt), asc(directoryUsers.id))
                .offset(input.startIndex - 1)
                .limit(input.count)
        return { total: total?.n ?? 0, rows: rows.map(toUser) }
      })
    },

    async user(tenantId, directoryId, id) {
      if (!UUID.test(id)) return null
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.directoryId, directoryId),
              eq(directoryUsers.id, id),
              isNull(directoryUsers.deletedAt),
            ),
          )
          .limit(1),
      )
      return row ? toUser(row) : null
    },

    async createUser(tenantId, directoryId, input, event) {
      try {
        return await withTenant(db, tenantId, async (tx) => {
          const [row] = await tx
            .insert(directoryUsers)
            .values({ tenantId, directoryId, ...userColumns(input) })
            .returning()
          const entries = await outbox(tx, tenantId, directoryId, [row!.id], "created")
          await audit(tx, tenantId, {
            ...event,
            data: { ...event.data, directoryUserId: row!.id },
          })
          return { row: toUser(row!), outbox: entries }
        })
      } catch (error) {
        if (uniqueViolation(error, "directory_users_user_name_unique")) return "taken"
        throw error
      }
    },

    async editUser(tenantId, directoryId, id, edit, event) {
      if (!UUID.test(id)) return null
      try {
        return await withTenant(db, tenantId, async (tx) => {
          const [current] = await tx
            .select()
            .from(directoryUsers)
            .where(
              and(
                eq(directoryUsers.tenantId, tenantId),
                eq(directoryUsers.directoryId, directoryId),
                eq(directoryUsers.id, id),
                isNull(directoryUsers.deletedAt),
              ),
            )
            .for("update")
            .limit(1)
          if (!current) return null
          const before = toUser(current)
          const next = edit(before)
          const [row] = await tx
            .update(directoryUsers)
            .set({ ...userColumns(next), updatedAt: new Date() })
            .where(
              and(eq(directoryUsers.tenantId, tenantId), eq(directoryUsers.id, id)),
            )
            .returning()
          const entries = await outbox(tx, tenantId, directoryId, [id], "updated")
          await audit(tx, tenantId, event(before, next))
          return { row: toUser(row!), outbox: entries }
        })
      } catch (error) {
        if (uniqueViolation(error, "directory_users_user_name_unique")) return "taken"
        throw error
      }
    },

    async deleteUser(tenantId, directoryId, id, event) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(directoryUsers)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.directoryId, directoryId),
              eq(directoryUsers.id, id),
              isNull(directoryUsers.deletedAt),
            ),
          )
          .returning({ id: directoryUsers.id })
        if (!row) return null
        await tx
          .delete(directoryMemberships)
          .where(
            and(
              eq(directoryMemberships.tenantId, tenantId),
              eq(directoryMemberships.userId, id),
            ),
          )
        const entries = await outbox(tx, tenantId, directoryId, [id], "deleted")
        await audit(tx, tenantId, event)
        return { row: { id }, outbox: entries }
      })
    },

    async groupsOf(tenantId, userIds) {
      const out = new Map<string, { id: string; displayName: string }[]>()
      if (userIds.length === 0) return out
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            userId: directoryMemberships.userId,
            id: directoryGroups.id,
            displayName: directoryGroups.displayName,
          })
          .from(directoryMemberships)
          .innerJoin(
            directoryGroups,
            eq(directoryGroups.id, directoryMemberships.groupId),
          )
          .where(
            and(
              eq(directoryMemberships.tenantId, tenantId),
              inArray(directoryMemberships.userId, userIds),
            ),
          )
          .orderBy(asc(directoryGroups.displayName)),
      )
      for (const r of rows)
        out.set(r.userId, [
          ...(out.get(r.userId) ?? []),
          { id: r.id, displayName: r.displayName },
        ])
      return out
    },

    // ── Groups ──
    async listGroups(tenantId, directoryId, input) {
      const f = input.filter
      const where = and(
        eq(directoryGroups.tenantId, tenantId),
        eq(directoryGroups.directoryId, directoryId),
        f?.attr === "displayName"
          ? sql`lower(${directoryGroups.displayName}) = lower(${f.value})`
          : f?.attr === "externalId"
            ? eq(directoryGroups.externalId, f.value)
            : undefined,
      )
      return withTenant(db, tenantId, async (tx) => {
        const [total] = await tx
          .select({ n: count() })
          .from(directoryGroups)
          .where(where)
        const rows =
          input.count === 0
            ? []
            : await tx
                .select()
                .from(directoryGroups)
                .where(where)
                .orderBy(asc(directoryGroups.createdAt), asc(directoryGroups.id))
                .offset(input.startIndex - 1)
                .limit(input.count)
        return { total: total?.n ?? 0, rows: rows.map(toGroup) }
      })
    },

    async group(tenantId, directoryId, id) {
      if (!UUID.test(id)) return null
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryGroups)
          .where(
            and(
              eq(directoryGroups.tenantId, tenantId),
              eq(directoryGroups.directoryId, directoryId),
              eq(directoryGroups.id, id),
            ),
          )
          .limit(1),
      )
      return row ? toGroup(row) : null
    },

    async membersOf(tenantId, groupIds) {
      const out = new Map<string, { id: string; display: string }[]>()
      if (groupIds.length === 0) return out
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            groupId: directoryMemberships.groupId,
            id: directoryUsers.id,
            userName: directoryUsers.userName,
            displayName: directoryUsers.displayName,
          })
          .from(directoryMemberships)
          .innerJoin(directoryUsers, eq(directoryUsers.id, directoryMemberships.userId))
          .where(
            and(
              eq(directoryMemberships.tenantId, tenantId),
              inArray(directoryMemberships.groupId, groupIds),
            ),
          )
          .orderBy(asc(directoryUsers.userName)),
      )
      for (const r of rows)
        out.set(r.groupId, [
          ...(out.get(r.groupId) ?? []),
          { id: r.id, display: r.displayName ?? r.userName },
        ])
      return out
    },

    async createGroup(tenantId, directoryId, input, event) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(directoryGroups)
          .values({
            tenantId,
            directoryId,
            displayName: input.displayName,
            externalId: input.externalId,
            resource: input.resource,
          })
          .returning()
        const members = await liveMembers(tx, tenantId, directoryId, input.members)
        if (members.length > 0)
          await tx.insert(directoryMemberships).values(
            members.map((userId) => ({
              groupId: row!.id,
              userId,
              directoryId,
              tenantId,
            })),
          )
        const entries = await outbox(tx, tenantId, directoryId, members, "group")
        const skipped = input.members.length - members.length
        await audit(tx, tenantId, {
          ...event,
          data: { ...event.data, groupId: row!.id, members: members.length, skipped },
        })
        return { row: toGroup(row!), outbox: entries, skipped }
      })
    },

    async editGroup(tenantId, directoryId, id, edit, event) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [current] = await tx
          .select()
          .from(directoryGroups)
          .where(
            and(
              eq(directoryGroups.tenantId, tenantId),
              eq(directoryGroups.directoryId, directoryId),
              eq(directoryGroups.id, id),
            ),
          )
          .for("update")
          .limit(1)
        if (!current) return null
        const had = (
          await tx
            .select({ userId: directoryMemberships.userId })
            .from(directoryMemberships)
            .where(
              and(
                eq(directoryMemberships.tenantId, tenantId),
                eq(directoryMemberships.groupId, id),
              ),
            )
        ).map((r) => r.userId)
        const next = edit({ row: toGroup(current), members: had })
        const wanted = await liveMembers(tx, tenantId, directoryId, next.members)
        const before = new Set(had)
        const after = new Set(wanted)
        const added = wanted.filter((u) => !before.has(u))
        const removed = had.filter((u) => !after.has(u))
        const [row] = await tx
          .update(directoryGroups)
          .set({
            displayName: next.displayName,
            externalId: next.externalId,
            resource: next.resource,
            updatedAt: new Date(),
          })
          .where(
            and(eq(directoryGroups.tenantId, tenantId), eq(directoryGroups.id, id)),
          )
          .returning()
        if (added.length > 0)
          await tx
            .insert(directoryMemberships)
            .values(
              added.map((userId) => ({ groupId: id, userId, directoryId, tenantId })),
            )
        for (let i = 0; i < removed.length; i += 1000)
          await tx
            .delete(directoryMemberships)
            .where(
              and(
                eq(directoryMemberships.tenantId, tenantId),
                eq(directoryMemberships.groupId, id),
                inArray(directoryMemberships.userId, removed.slice(i, i + 1000)),
              ),
            )
        // ⚠ A RENAME TOUCHES EVERY MEMBER: group-to-role rules (#341) read names.
        const renamed =
          current.displayName !== next.displayName ||
          current.externalId !== next.externalId
        const touched = renamed
          ? [...new Set([...wanted, ...removed])]
          : [...added, ...removed]
        const entries = await outbox(tx, tenantId, directoryId, touched, "group")
        const skipped = next.members.length - wanted.length
        await audit(tx, tenantId, {
          ...event,
          data: {
            ...event.data,
            groupId: id,
            added: added.length,
            removed: removed.length,
            skipped,
          },
        })
        return { row: toGroup(row!), outbox: entries, skipped }
      })
    },

    async deleteGroup(tenantId, directoryId, id, event) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const members = (
          await tx
            .select({ userId: directoryMemberships.userId })
            .from(directoryMemberships)
            .where(
              and(
                eq(directoryMemberships.tenantId, tenantId),
                eq(directoryMemberships.groupId, id),
              ),
            )
        ).map((r) => r.userId)
        const [row] = await tx
          .delete(directoryGroups)
          .where(
            and(
              eq(directoryGroups.tenantId, tenantId),
              eq(directoryGroups.directoryId, directoryId),
              eq(directoryGroups.id, id),
            ),
          )
          .returning({ id: directoryGroups.id })
        if (!row) return null
        const entries = await outbox(tx, tenantId, directoryId, members, "group")
        await audit(tx, tenantId, {
          ...event,
          data: { ...event.data, groupId: id, members: members.length },
        })
        return { row: { id }, outbox: entries }
      })
    },

    // ── the outbox and the apply job ──
    async pending(tenantId, directoryId, before, limit) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: directoryOutbox.id,
            directoryUserId: directoryOutbox.directoryUserId,
          })
          .from(directoryOutbox)
          .where(
            and(
              eq(directoryOutbox.tenantId, tenantId),
              eq(directoryOutbox.directoryId, directoryId),
              isNull(directoryOutbox.appliedAt),
              lt(directoryOutbox.createdAt, before),
            ),
          )
          .orderBy(asc(directoryOutbox.createdAt))
          .limit(limit),
      )
    },

    async forApply(tenantId, directoryUserId) {
      if (!UUID.test(directoryUserId)) return null
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ THE ENTRY FIRST, THEN THE ROW: whatever the job reads is at least
        // as new as every entry it will stamp applied.
        const [latest] = await tx
          .select({ id: directoryOutbox.id })
          .from(directoryOutbox)
          .where(
            and(
              eq(directoryOutbox.tenantId, tenantId),
              eq(directoryOutbox.directoryUserId, directoryUserId),
              isNull(directoryOutbox.appliedAt),
            ),
          )
          .orderBy(desc(directoryOutbox.id))
          .limit(1)
        const [row] = await tx
          .select({
            user: directoryUsers,
            enabled: directories.enabled,
            createMailboxes: directories.createMailboxes,
          })
          .from(directoryUsers)
          .innerJoin(directories, eq(directories.id, directoryUsers.directoryId))
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.id, directoryUserId),
            ),
          )
          .limit(1)
        if (!row) return null
        return {
          row: {
            ...toUser(row.user),
            directoryEnabled: row.enabled,
            createMailboxes: row.createMailboxes,
          },
          upTo: latest?.id ?? null,
        }
      })
    },

    async personStatus(tenantId, clerkUserId, except) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            active: directoryUsers.active,
            conflict: directoryUsers.conflict,
          })
          .from(directoryUsers)
          .innerJoin(directories, eq(directories.id, directoryUsers.directoryId))
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.clerkUserId, clerkUserId),
              isNull(directoryUsers.deletedAt),
              eq(directories.enabled, true),
              except && UUID.test(except)
                ? sql`${directoryUsers.id} <> ${except}`
                : undefined,
            ),
          )
          .limit(100),
      )
      if (rows.length === 0) return "unknown"
      return rows.some((r) => r.active || r.conflict === "last_owner")
        ? "active"
        : "inactive"
    },

    async personGroups(tenantId, clerkUserId) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .selectDistinct({
            id: directoryGroups.id,
            directoryId: directoryGroups.directoryId,
            displayName: directoryGroups.displayName,
            externalId: directoryGroups.externalId,
          })
          .from(directoryMemberships)
          .innerJoin(directoryUsers, eq(directoryUsers.id, directoryMemberships.userId))
          .innerJoin(
            directoryGroups,
            eq(directoryGroups.id, directoryMemberships.groupId),
          )
          .innerJoin(directories, eq(directories.id, directoryMemberships.directoryId))
          .where(
            and(
              eq(directoryMemberships.tenantId, tenantId),
              eq(directoryUsers.clerkUserId, clerkUserId),
              isNull(directoryUsers.deletedAt),
              eq(directories.enabled, true),
            ),
          ),
      )
    },

    async linkUser(tenantId, id, clerkUserId) {
      try {
        const done = await withTenant(db, tenantId, (tx) =>
          tx
            .update(directoryUsers)
            .set({ clerkUserId, updatedAt: new Date() })
            .where(
              and(
                eq(directoryUsers.tenantId, tenantId),
                eq(directoryUsers.id, id),
                or(
                  isNull(directoryUsers.clerkUserId),
                  eq(directoryUsers.clerkUserId, clerkUserId),
                ),
              ),
            )
            .returning({ id: directoryUsers.id }),
        )
        return done.length > 0 ? "linked" : "taken"
      } catch (error) {
        if (uniqueViolation(error, "directory_users_clerk_user_unique")) return "taken"
        throw error
      }
    },

    async setConflict(tenantId, id, conflict, detail, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryUsers)
          .set(
            conflict
              ? { conflict, conflictDetail: detail ?? {}, conflictAt: at }
              : { conflict: null, conflictDetail: null, conflictAt: null },
          )
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.id, id),
              conflict
                ? sql`${directoryUsers.conflict} is distinct from ${conflict}`
                : isNotNull(directoryUsers.conflict),
            ),
          )
          .returning({ id: directoryUsers.id }),
      )
      return done.length > 0
    },

    async bannedByDirectory(tenantId, clerkUserId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: directoryUsers.id })
          .from(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.clerkUserId, clerkUserId),
              eq(directoryUsers.bannedByDirectory, true),
            ),
          )
          .limit(1),
      )
      return rows.length > 0
    },

    async setBannedByDirectory(tenantId, clerkUserId, banned) {
      await withTenant(db, tenantId, async (tx) => {
        // ⚠ A DELETED ROW IS KEPT ONLY TO REMEMBER THE BAN: with the ban
        // lifted it has nothing left to remember.
        if (!banned)
          await tx
            .delete(directoryUsers)
            .where(
              and(
                eq(directoryUsers.tenantId, tenantId),
                eq(directoryUsers.clerkUserId, clerkUserId),
                eq(directoryUsers.bannedByDirectory, true),
                isNotNull(directoryUsers.deletedAt),
              ),
            )
        await tx
          .update(directoryUsers)
          .set({ bannedByDirectory: banned })
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.clerkUserId, clerkUserId),
            ),
          )
      })
    },

    async markApplied(tenantId, directoryUserId, upTo, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryOutbox)
          .set({ appliedAt: at })
          .where(
            and(
              eq(directoryOutbox.tenantId, tenantId),
              eq(directoryOutbox.directoryUserId, directoryUserId),
              isNull(directoryOutbox.appliedAt),
              lte(directoryOutbox.id, upTo),
            ),
          ),
      )
    },

    async noteFailure(tenantId, directoryUserId, reason) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryOutbox)
          .set({
            attempts: sql`${directoryOutbox.attempts} + 1`,
            lastError: reason.slice(0, 200),
          })
          .where(
            and(
              eq(directoryOutbox.tenantId, tenantId),
              eq(directoryOutbox.directoryUserId, directoryUserId),
              isNull(directoryOutbox.appliedAt),
            ),
          ),
      )
    },

    async purgeUser(tenantId, id) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .delete(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.id, id),
              isNotNull(directoryUsers.deletedAt),
            ),
          ),
      )
    },

    async requeue(tenantId, directoryId, id) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ id: directoryUsers.id })
          .from(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.directoryId, directoryId),
              eq(directoryUsers.id, id),
              isNull(directoryUsers.deletedAt),
            ),
          )
          .limit(1)
        if (!row) return null
        const [entry] = await outbox(tx, tenantId, directoryId, [id], "updated")
        return entry ?? null
      })
    },

    async seats(tenantId) {
      /*
       * ⚠ ONE KEY PER PERSON: their Clerk account when linked, else the
       * lowercased address, else the row. A person two directories list is one
       * seat, and so is one the directory knows by address before any account
       * exists. ENABLED directories only, and a row holding `last_owner` still
       * counts as active (personStatus).
       */
      const rows = (await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          with people as (
            select distinct
                   coalesce(u.clerk_user_id, 'e:' || lower(u.email), 'r:' || u.id::text) as person,
                   u.clerk_user_id as clerk_user_id
              from identity.directory_users u
              join identity.directories d
                on d.id = u.directory_id and d.tenant_id = u.tenant_id
             where u.tenant_id = ${tenantId}::uuid
               and d.enabled
               and u.deleted_at is null
               and (u.active or u.conflict = 'last_owner')
          )
          select count(*)::int as people,
                 count(*) filter (
                   where p.clerk_user_id is null
                      or not exists (
                        select 1 from core.workspace_roles r
                         where r.tenant_id = ${tenantId}::uuid
                           and r.clerk_user_id = p.clerk_user_id)
                 )::int as outside
            from people p`),
      )) as unknown as { people: number; outside: number }[]
      return { people: rows[0]?.people ?? 0, outside: rows[0]?.outside ?? 0 }
    },

    async requeueActive(tenantId, directoryId) {
      if (!UUID.test(directoryId)) return []
      return withTenant(db, tenantId, async (tx) => {
        const people = await tx
          .select({ id: directoryUsers.id })
          .from(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.directoryId, directoryId),
              eq(directoryUsers.active, true),
              isNull(directoryUsers.deletedAt),
              isNotNull(directoryUsers.clerkUserId),
            ),
          )
          .limit(5000)
        if (people.length === 0) return []
        return outbox(
          tx,
          tenantId,
          directoryId,
          people.map((p) => p.id),
          "updated",
        )
      })
    },

    async liveDomains(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ name: joinDomains.name })
          .from(joinDomains)
          .where(and(eq(joinDomains.tenantId, tenantId), sql`${liveProof}`)),
      )
      return rows.map((r) => r.name)
    },

    async fileWaitlist(tenantId, input) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .insert(joinRequests)
          .values({
            tenantId,
            userId: input.userId,
            email: input.email.toLowerCase(),
            via: "directory",
            full: true,
          })
          .onConflictDoNothing(),
      )
    },

    async closeWaitlist(tenantId, userId, accepted) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(joinRequests)
          .set({ answeredAt: new Date(), accepted })
          .where(
            and(
              eq(joinRequests.tenantId, tenantId),
              eq(joinRequests.userId, userId),
              eq(joinRequests.via, "directory"),
              isNull(joinRequests.answeredAt),
            ),
          ),
      )
    },

    // ── the bridge ──
    async provisioned(tenantId, input) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            clerkUserId: directoryUsers.clerkUserId,
            active: directoryUsers.active,
            conflict: directoryUsers.conflict,
            externalId: directoryUsers.externalId,
            userName: directoryUsers.userName,
          })
          .from(directoryUsers)
          .innerJoin(directories, eq(directories.id, directoryUsers.directoryId))
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              isNull(directoryUsers.deletedAt),
              eq(directories.enabled, true),
              or(
                eq(directoryUsers.externalId, input.subject),
                sql`lower(${directoryUsers.userName}) = lower(${input.subject})`,
                eq(directoryUsers.email, input.email),
              ),
            ),
          )
          .limit(20),
      )
      return rows.map((r) => ({
        clerkUserId: r.clerkUserId,
        // ⚠ AS personStatus: the last owner is not locked out of SSO by a directory.
        active: r.active || r.conflict === "last_owner",
        by:
          r.externalId === input.subject ||
          r.userName.toLowerCase() === input.subject.toLowerCase()
            ? ("subject" as const)
            : ("email" as const),
      }))
    },
  }
}
