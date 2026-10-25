import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import {
  directories,
  directoryGroups,
  directoryMailboxes,
  directoryMemberships,
  directoryUsers,
  events,
  workspaceSettings,
} from "../db/identity.js"
import { aliases, groupMembers, groups } from "../db/schema.js"
import { directoryMail } from "../mailboxes/store.js"
import type {
  DirectoryMailStore,
  LeaverAction,
  MailboxNext,
  MailboxNote,
  MailboxRow,
  ManagerRead,
  Plan,
} from "./directory-mail.js"
import { SCHEMA } from "./scim.js"
import type { AuditEvent } from "./ports.js"

/**
 * The database half of mail from the directory (#344, identity/directory-mail.ts).
 *
 * ⚠ EVERY TRANSITION IS ONE TRANSACTION OF THREE THINGS: the `authd` rows the
 * mailbox is made of (written only through `directoryMail`, mailboxes/store.ts),
 * our lifecycle row, and the audit event. A crash leaves all three or none, so
 * a mailbox is never suspended without the record that says why, and the record
 * never claims what did not happen.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const record = (tx: Tx, tenantId: string, event: AuditEvent) =>
  tx.insert(events).values({
    tenantId,
    type: event.type,
    actorUserId: event.actorUserId ?? null,
    subjectUserId: event.subjectUserId ?? null,
    connectionId: event.connectionId ?? null,
    sessionId: event.sessionId ?? null,
    reason: event.reason ?? null,
    data: event.data ?? {},
  })

const toRow = (r: typeof directoryMailboxes.$inferSelect): MailboxRow => ({
  tenantId: r.tenantId,
  clerkUserId: r.clerkUserId,
  address: r.address,
  state: r.state as MailboxRow["state"],
  suspendedAt: r.suspendedAt,
  next: r.next as MailboxNext,
  targetUserId: r.targetUserId,
  deleteAfterDays: r.deleteAfterDays,
  deleteAt: r.deleteAt,
})

/** Writes the forward or delegate route a plan names, after clearing the old ones. */
async function route(
  tx: Tx,
  leaverId: string,
  email: string,
  plan: Plan,
): Promise<void> {
  await directoryMail.dropRoutes(tx, leaverId)
  if (plan.next === "forward_manager" && plan.targetUserId)
    await directoryMail.setRoute(tx, {
      kind: "fwd",
      leaverId,
      email,
      targetId: plan.targetUserId,
    })
  if (plan.next === "delegate" && plan.targetUserId)
    await directoryMail.setRoute(tx, {
      kind: "dlg",
      leaverId,
      email: null,
      targetId: plan.targetUserId,
    })
}

/** Postgres' unique violation on a constraint or index. */
const uniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: unknown; cause?: unknown }
  const inner = (e?.cause ?? e) as { code?: unknown }
  return inner?.code === "23505"
}

export interface GroupMailStore {
  group(
    tenantId: string,
    directoryId: string,
    groupId: string,
  ): Promise<{
    id: string
    displayName: string
    mailAddress: string | null
    mailKind: "list" | "shared" | null
  } | null>
  /**
   * Opts a group in (address and kind) or out (null), mirrors it to authd and
   * seats its active members, with the audit event, in one transaction.
   * `taken`: the address is some mailbox's, alias, or another list's.
   */
  setGroupMail(
    tenantId: string,
    directoryId: string,
    groupId: string,
    input: { address: string; kind: "list" | "shared" } | null,
    audit: AuditEvent,
  ): Promise<"ok" | "not_found" | "taken">
}

export function directoryMailStore(db: Database): DirectoryMailStore & GroupMailStore {
  const hostedBy = async (domain: string): Promise<string | null> => {
    const rows = (await db.execute(
      sql`select tenant_id::text as tenant_id
            from core.mailbox_domains()
           where lower(name) = ${domain.toLowerCase()}
           limit 1`,
    )) as unknown as { tenant_id: string | null }[]
    return rows[0]?.tenant_id ?? null
  }

  return {
    hostedBy,

    async leaverDefault(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            action: workspaceSettings.leaverAction,
            days: workspaceSettings.leaverDays,
          })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1),
      )
      return row
        ? { action: row.action as LeaverAction, days: row.days }
        : { action: "keep", days: null }
    },

    async setLeaverDefault(tenantId, input, audit) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(workspaceSettings)
          .values({
            tenantId,
            leaverAction: input.action,
            leaverDays: input.days,
            updatedBy: input.by,
          })
          .onConflictDoUpdate({
            target: workspaceSettings.tenantId,
            set: {
              leaverAction: input.action,
              leaverDays: input.days,
              updatedBy: input.by,
              updatedAt: new Date(),
            },
          })
        await record(tx, tenantId, audit)
      })
    },

    async mailbox(tenantId, clerkUserId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
          .limit(1),
      )
      return row ? toRow(row) : null
    },

    async mailboxes(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryMailboxes)
          .where(eq(directoryMailboxes.tenantId, tenantId))
          .orderBy(desc(directoryMailboxes.updatedAt))
          .limit(500),
      )
      return rows.map(toRow)
    },

    async account(tenantId, clerkUserId) {
      const row = await withTenant(db, tenantId, (tx) =>
        directoryMail.account(tx, tenantId, clerkUserId),
      )
      return row?.active
        ? { address: row.email, suspended: row.suspendedAt !== null }
        : null
    },

    async recordActive(tenantId, clerkUserId, address) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .insert(directoryMailboxes)
          .values({ tenantId, clerkUserId, address })
          .onConflictDoUpdate({
            target: [directoryMailboxes.tenantId, directoryMailboxes.clerkUserId],
            set: { address, updatedAt: new Date() },
            // A suspended row keeps the address it was suspended with.
            setWhere: eq(directoryMailboxes.state, "active"),
          }),
      )
    },

    async suspend(tenantId, clerkUserId, plan, at, audit) {
      return withTenant(db, tenantId, async (tx) => {
        const account = await directoryMail.account(tx, tenantId, clerkUserId)
        if (!account) return "no_mailbox" as const
        const [existing] = await tx
          .select({ state: directoryMailboxes.state })
          .from(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
          .for("update")
        // ⚠ THE LOGIN IS REFUSED EITHER WAY: a row that says suspended while
        // the account was not (a repair) is put right, but nothing else moves.
        await directoryMail.suspend(tx, tenantId, clerkUserId, at)
        if (existing?.state === "suspended") return "already" as const
        const values = {
          address: account.email,
          state: "suspended",
          suspendedAt: at,
          next: plan.next,
          targetUserId: plan.targetUserId,
          deleteAfterDays: plan.days,
          deleteAt: plan.deleteAt,
          updatedAt: at,
        }
        await tx
          .insert(directoryMailboxes)
          .values({ tenantId, clerkUserId, ...values })
          .onConflictDoUpdate({
            target: [directoryMailboxes.tenantId, directoryMailboxes.clerkUserId],
            set: values,
          })
        await route(tx, clerkUserId, account.email, plan)
        await record(tx, tenantId, audit)
        return "suspended" as const
      })
    },

    async resume(tenantId, clerkUserId, audit) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ state: directoryMailboxes.state })
          .from(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
          .for("update")
        const account = await directoryMail.account(tx, tenantId, clerkUserId)
        if (!account) return "none" as const
        if (row?.state !== "suspended" && account.suspendedAt === null)
          return "none" as const
        await directoryMail.resume(tx, tenantId, clerkUserId)
        await directoryMail.dropRoutes(tx, clerkUserId)
        if (row)
          await tx
            .update(directoryMailboxes)
            .set({
              state: "active",
              suspendedAt: null,
              next: "keep",
              targetUserId: null,
              deleteAfterDays: null,
              deleteAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(directoryMailboxes.tenantId, tenantId),
                eq(directoryMailboxes.clerkUserId, clerkUserId),
              ),
            )
        await record(tx, tenantId, audit)
        return "resumed" as const
      })
    },

    async choose(tenantId, clerkUserId, plan, audit) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ state: directoryMailboxes.state })
          .from(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
          .for("update")
        const account = await directoryMail.account(tx, tenantId, clerkUserId)
        if (row?.state !== "suspended" || !account) return "not_suspended" as const
        await tx
          .update(directoryMailboxes)
          .set({
            next: plan.next,
            targetUserId: plan.targetUserId,
            deleteAfterDays: plan.days,
            deleteAt: plan.deleteAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
        await route(tx, clerkUserId, account.email, plan)
        await record(tx, tenantId, audit)
        return "ok" as const
      })
    },

    async remove(tenantId, clerkUserId, at, audit) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
          .for("update")
        if (!row || row.state !== "suspended" || row.next !== "delete" || !row.deleteAt)
          return "not_scheduled" as const
        // ⚠ THE DATE IS CHECKED HERE, IN THE DATABASE'S OWN ROW, AS WELL AS BY
        // THE CALLER: a caller with a wrong clock deletes nothing.
        if (row.deleteAt.getTime() > at.getTime()) return "not_due" as const
        await directoryMail.dropRoutes(tx, clerkUserId)
        await directoryMail.drop(tx, tenantId, clerkUserId)
        await tx
          .delete(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
        await record(tx, tenantId, audit)
        return "deleted" as const
      })
    },

    async due(tenantId, at) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.state, "suspended"),
              eq(directoryMailboxes.next, "delete"),
              isNotNull(directoryMailboxes.deleteAt),
              lte(directoryMailboxes.deleteAt, at),
            ),
          )
          .orderBy(asc(directoryMailboxes.deleteAt))
          .limit(100),
      )
      return rows.map(toRow)
    },

    async manager(tenantId, leaverId): Promise<ManagerRead> {
      return withTenant(db, tenantId, async (tx) => {
        const own = await tx
          .select({
            directoryId: directoryUsers.directoryId,
            resource: directoryUsers.resource,
          })
          .from(directoryUsers)
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.clerkUserId, leaverId),
              isNull(directoryUsers.deletedAt),
            ),
          )
          .orderBy(desc(directoryUsers.updatedAt))
          .limit(10)
        for (const mine of own) {
          const extension = mine.resource[SCHEMA.enterprise] as
            { manager?: { value?: unknown } | null } | undefined
          const value = extension?.manager?.value
          if (typeof value !== "string" || value.length === 0 || value.length > 256)
            continue
          const found = await tx
            .select({
              id: directoryUsers.id,
              clerkUserId: directoryUsers.clerkUserId,
              active: directoryUsers.active,
              conflict: directoryUsers.conflict,
              enabled: directories.enabled,
            })
            .from(directoryUsers)
            .innerJoin(directories, eq(directories.id, directoryUsers.directoryId))
            .where(
              and(
                eq(directoryUsers.tenantId, tenantId),
                eq(directoryUsers.directoryId, mine.directoryId),
                isNull(directoryUsers.deletedAt),
                or(
                  UUID.test(value) ? eq(directoryUsers.id, value) : undefined,
                  eq(directoryUsers.externalId, value),
                  sql`lower(${directoryUsers.userName}) = lower(${value})`,
                ),
              ),
            )
            .limit(3)
          // ⚠ SEVERAL ROWS FOR ONE STRING IS NOBODY: a guess would copy a
          // leaver's mail to the wrong person.
          if (found.length !== 1) return { status: "none" as const }
          const m = found[0]!
          if (!m.clerkUserId) return { status: "none" as const }
          const account = await directoryMail.account(tx, tenantId, m.clerkUserId)
          return {
            status: "found" as const,
            clerkUserId: m.clerkUserId,
            active: m.enabled && (m.active || m.conflict === "last_owner"),
            address: account?.active ? account.email : null,
            suspended: account?.suspendedAt != null,
          }
        }
        return { status: "none" as const }
      })
    },

    async setAliases(tenantId, clerkUserId, wanted, audit) {
      return withTenant(db, tenantId, async (tx) => {
        const account = await directoryMail.account(tx, tenantId, clerkUserId)
        if (!account) return { taken: [...wanted] }
        const mine = () =>
          tx
            .select({ address: aliases.address })
            .from(aliases)
            .where(
              and(
                eq(aliases.clerkUserId, clerkUserId),
                eq(aliases.source, "directory"),
              ),
            )
        const before = new Set((await mine()).map((r) => r.address))
        const { taken } = await directoryMail.setAliases(tx, clerkUserId, wanted)
        const after = new Set((await mine()).map((r) => r.address))
        const added = [...after].filter((a) => !before.has(a)).sort()
        const removed = [...before].filter((a) => !after.has(a)).sort()
        if (added.length > 0 || removed.length > 0)
          await record(tx, tenantId, audit(added, removed))
        return { taken }
      })
    },

    async noteAliases(tenantId, directoryUserId, ignored) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryUsers)
          .set({ aliasesIgnored: ignored })
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.id, directoryUserId),
              sql`${directoryUsers.aliasesIgnored} <> ${ignored}`,
            ),
          ),
      )
    },

    async setNote(tenantId, directoryUserId, note: MailboxNote | null) {
      const changed = await withTenant(db, tenantId, (tx) =>
        tx
          .update(directoryUsers)
          .set({ mailboxNote: note })
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.id, directoryUserId),
              sql`${directoryUsers.mailboxNote} is distinct from ${note}`,
            ),
          )
          .returning({ id: directoryUsers.id }),
      )
      return changed.length > 0
    },

    async syncLists(tenantId, clerkUserId) {
      // The group names are read outside the transaction: hostedBy is a
      // SECURITY DEFINER function and needs no tenant context.
      const wanted = await withTenant(db, tenantId, async (tx) => {
        const account = await directoryMail.account(tx, tenantId, clerkUserId)
        if (!account) return null
        return tx
          .selectDistinct({
            id: directoryGroups.id,
            displayName: directoryGroups.displayName,
          })
          .from(directoryMemberships)
          .innerJoin(directoryUsers, eq(directoryUsers.id, directoryMemberships.userId))
          .innerJoin(
            directoryGroups,
            eq(directoryGroups.id, directoryMemberships.groupId),
          )
          .innerJoin(directories, eq(directories.id, directoryUsers.directoryId))
          .where(
            and(
              eq(directoryUsers.tenantId, tenantId),
              eq(directoryUsers.clerkUserId, clerkUserId),
              isNull(directoryUsers.deletedAt),
              eq(directories.enabled, true),
              or(
                eq(directoryUsers.active, true),
                eq(directoryUsers.conflict, "last_owner"),
              ),
              isNotNull(directoryGroups.mailAddress),
            ),
          )
      })
      if (wanted === null) return { added: 0, removed: 0 }
      const desired: string[] = []
      for (const g of wanted) {
        // ⚠ A GROUP RENAMED TO SOMEBODY ELSE'S ADDRESS STOPS SEATING ANYONE.
        const at = g.displayName.lastIndexOf("@")
        if (at >= 0 && (await hostedBy(g.displayName.slice(at + 1))) !== tenantId)
          continue
        desired.push(`dg-${g.id}`)
      }
      return withTenant(db, tenantId, async (tx) => {
        const existing = desired.length
          ? (
              await tx
                .select({ name: groups.name })
                .from(groups)
                .where(inArray(groups.name, desired))
            ).map((r) => r.name)
          : []
        const current = (
          await tx
            .select({ name: groupMembers.groupName })
            .from(groupMembers)
            .innerJoin(groups, eq(groups.name, groupMembers.groupName))
            .innerJoin(directoryGroups, eq(directoryGroups.id, groups.directoryGroupId))
            .where(
              and(
                eq(groupMembers.clerkUserId, clerkUserId),
                eq(directoryGroups.tenantId, tenantId),
              ),
            )
        ).map((r) => r.name)
        await directoryMail.setMemberships(tx, tenantId, clerkUserId, existing)
        return {
          added: existing.filter((n) => !current.includes(n)).length,
          removed: current.filter((n) => !existing.includes(n)).length,
        }
      })
    },

    async group(tenantId, directoryId, groupId) {
      if (!UUID.test(groupId) || !UUID.test(directoryId)) return null
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: directoryGroups.id,
            displayName: directoryGroups.displayName,
            mailAddress: directoryGroups.mailAddress,
            mailKind: directoryGroups.mailKind,
          })
          .from(directoryGroups)
          .where(
            and(
              eq(directoryGroups.tenantId, tenantId),
              eq(directoryGroups.directoryId, directoryId),
              eq(directoryGroups.id, groupId),
            ),
          )
          .limit(1),
      )
      return row ? { ...row, mailKind: row.mailKind as "list" | "shared" | null } : null
    },

    async setGroupMail(tenantId, directoryId, groupId, input, audit) {
      if (!UUID.test(groupId) || !UUID.test(directoryId)) return "not_found"
      try {
        return await withTenant(db, tenantId, async (tx) => {
          const [group] = await tx
            .select({
              id: directoryGroups.id,
              displayName: directoryGroups.displayName,
            })
            .from(directoryGroups)
            .where(
              and(
                eq(directoryGroups.tenantId, tenantId),
                eq(directoryGroups.directoryId, directoryId),
                eq(directoryGroups.id, groupId),
              ),
            )
            .for("update")
          if (!group) return "not_found" as const
          if (input === null) {
            await directoryMail.dropGroup(tx, groupId)
            await tx
              .update(directoryGroups)
              .set({ mailAddress: null, mailKind: null })
              .where(eq(directoryGroups.id, groupId))
            await record(tx, tenantId, audit)
            return "ok" as const
          }
          const name = `dg-${groupId}`
          const mirrored = await directoryMail.mirrorGroup(tx, {
            name,
            email: input.address,
            description: group.displayName,
            directoryGroupId: groupId,
          })
          if (mirrored === "taken") return "taken" as const
          await tx
            .update(directoryGroups)
            .set({ mailAddress: input.address, mailKind: input.kind })
            .where(eq(directoryGroups.id, groupId))
          // Seat the members who are active and have a mailbox.
          const members = await tx
            .selectDistinct({ id: directoryUsers.clerkUserId })
            .from(directoryMemberships)
            .innerJoin(
              directoryUsers,
              eq(directoryUsers.id, directoryMemberships.userId),
            )
            .innerJoin(directories, eq(directories.id, directoryUsers.directoryId))
            .where(
              and(
                eq(directoryMemberships.groupId, groupId),
                eq(directoryUsers.tenantId, tenantId),
                isNull(directoryUsers.deletedAt),
                isNotNull(directoryUsers.clerkUserId),
                eq(directories.enabled, true),
                or(
                  eq(directoryUsers.active, true),
                  eq(directoryUsers.conflict, "last_owner"),
                ),
              ),
            )
          await tx.delete(groupMembers).where(eq(groupMembers.groupName, name))
          for (const m of members) {
            if (!m.id) continue
            if (await directoryMail.account(tx, tenantId, m.id))
              await tx
                .insert(groupMembers)
                .values({ groupName: name, clerkUserId: m.id })
                .onConflictDoNothing()
          }
          await record(tx, tenantId, audit)
          return "ok" as const
        })
      } catch (error) {
        // The unique index on a list's address: another group already has it.
        if (uniqueViolation(error)) return "taken"
        throw error
      }
    },
  }
}
