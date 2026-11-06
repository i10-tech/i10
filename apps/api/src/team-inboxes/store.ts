import { and, asc, eq, inArray, isNotNull, not, sql } from "drizzle-orm"
import { union } from "drizzle-orm/pg-core"
import type { Database } from "../db/client.js"
import {
  accounts,
  aliases,
  groupMembers,
  groups,
  groupSentCopies,
} from "../db/schema.js"
import { mailboxDirectory } from "../mailboxes/store.js"
import type { SentCopyStore } from "./sent-copy.js"
import { AddressTakenError, type TeamInboxRow, type TeamInboxStore } from "./service.js"

/**
 * The directory rows behind team inboxes.
 *
 * ⚠ NO `withTenant`, FOR THE REASON GIVEN IN `mailboxes/store.ts`: the `authd`
 * schema has no row level security. Every read and write below therefore names
 * the tenant in its own `WHERE`, and that clause IS the isolation - a missing
 * one shows a workspace another workspace's inboxes. `find`, `setMembers`,
 * `remove` and `dropMember` all take the tenant and none can be called without.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]
type GroupRow = typeof groups.$inferSelect

/**
 * A unique violation: the address was taken between the check and the write.
 *
 * ⚠ THE CODE IS ON THE CAUSE. Drizzle wraps the driver's error in a
 * `DrizzleQueryError` whose own `code` is absent, so reading it off the thrown
 * error alone never matches and the race answers 500 instead of 409. Found by
 * running this against a real database, which a fake store cannot do.
 */
const isUniqueViolation = (error: unknown): boolean => {
  const codeOf = (e: unknown) =>
    typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined
  const cause =
    typeof error === "object" && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined
  return codeOf(error) === "23505" || codeOf(cause) === "23505"
}

export function teamInboxStore(db: Database): TeamInboxStore {
  const directory = mailboxDirectory(db)

  async function load(
    reader: Database | Tx,
    rows: GroupRow[],
  ): Promise<TeamInboxRow[]> {
    if (rows.length === 0) return []

    const members = await reader
      .select({
        groupName: groupMembers.groupName,
        userId: accounts.clerkUserId,
        address: accounts.email,
      })
      .from(groupMembers)
      .innerJoin(accounts, eq(accounts.clerkUserId, groupMembers.clerkUserId))
      .where(
        inArray(
          groupMembers.groupName,
          rows.map((r) => r.name),
        ),
      )
      .orderBy(asc(accounts.email))

    return rows.map((row) => ({
      name: row.name,
      address: row.email ?? row.name,
      displayName: row.description,
      // ⚠ NON-NULL BECAUSE EVERY QUERY HERE FILTERS ON IT; a team inbox without a
      // tenant is not one, whatever else is in the table.
      tenantId: row.tenantId as string,
      createdAt: row.createdAt,
      members: members
        .filter((m) => m.groupName === row.name)
        .map(({ userId, address }) => ({ userId, address })),
    }))
  }

  const owned = (tenantId: string) => eq(groups.tenantId, tenantId)

  return {
    domainOwner: (domain) => directory.domainOwner(domain),

    /**
     * ⚠ ACCOUNTS, ALIASES AND GROUPS, in one round trip like `mailboxDirectory`.
     * A team inbox made on an address that is somebody's alias would start
     * competing with their mail for it.
     */
    async addressTaken(address) {
      const rows = await union(
        db
          .select({ address: accounts.email })
          .from(accounts)
          .where(eq(accounts.email, address)),
        db
          .select({ address: aliases.address })
          .from(aliases)
          .where(eq(aliases.address, address)),
        db
          .select({ address: sql<string>`${groups.email}` })
          .from(groups)
          .where(eq(sql`lower(${groups.email})`, address)),
      ).limit(1)

      return rows.length > 0
    },

    async mailboxes(addresses) {
      if (addresses.length === 0) return []
      const rows = await db
        .select({
          userId: accounts.clerkUserId,
          address: accounts.email,
          active: accounts.active,
        })
        .from(accounts)
        .where(inArray(accounts.email, addresses))
      return rows
    },

    async create(input) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(groups)
            .values({
              name: input.name,
              email: input.address,
              description: input.displayName,
              tenantId: input.tenantId,
            })
            .returning()

          if (input.memberUserIds.length > 0) {
            await tx.insert(groupMembers).values(
              input.memberUserIds.map((clerkUserId) => ({
                groupName: input.name,
                clerkUserId,
              })),
            )
          }

          return (await load(tx, [row!]))[0]!
        })
      } catch (error) {
        if (isUniqueViolation(error)) throw new AddressTakenError(input.address)
        throw error
      }
    },

    async forTenant(tenantId) {
      const rows = await db
        .select()
        .from(groups)
        .where(owned(tenantId))
        .orderBy(asc(groups.createdAt), asc(groups.name))
      return load(db, rows)
    },

    async forMember(tenantId, userId) {
      const rows = await db
        .select({ group: groups })
        .from(groups)
        .innerJoin(groupMembers, eq(groupMembers.groupName, groups.name))
        .where(and(owned(tenantId), eq(groupMembers.clerkUserId, userId)))
        .orderBy(asc(groups.createdAt), asc(groups.name))
      return load(
        db,
        rows.map((r) => r.group),
      )
    },

    async find(tenantId, address) {
      const rows = await db
        .select()
        .from(groups)
        .where(and(owned(tenantId), eq(groups.email, address)))
        .limit(1)
      return (await load(db, rows))[0] ?? null
    },

    async setMembers(tenantId, address, memberUserIds) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(groups)
          .where(and(owned(tenantId), eq(groups.email, address)))
          .limit(1)
        if (!row) return null

        // Replaced wholesale, like the projection's aliases: the set is small and
        // a diff still has to get removal right.
        await tx
          .delete(groupMembers)
          .where(
            and(
              eq(groupMembers.groupName, row.name),
              memberUserIds.length > 0
                ? not(inArray(groupMembers.clerkUserId, memberUserIds))
                : undefined,
            ),
          )
        if (memberUserIds.length > 0) {
          await tx
            .insert(groupMembers)
            .values(
              memberUserIds.map((clerkUserId) => ({
                groupName: row.name,
                clerkUserId,
              })),
            )
            .onConflictDoNothing()
        }

        return (await load(tx, [row]))[0]!
      })
    },

    async remove(tenantId, address) {
      const gone = await db
        .delete(groups)
        .where(and(owned(tenantId), eq(groups.email, address)))
        .returning({ name: groups.name })
      return gone.length > 0
    },

    async dropMember(tenantId, userId) {
      const dropped = await db
        .delete(groupMembers)
        .where(
          and(
            eq(groupMembers.clerkUserId, userId),
            inArray(
              groupMembers.groupName,
              db.select({ name: groups.name }).from(groups).where(owned(tenantId)),
            ),
          ),
        )
        .returning({ groupName: groupMembers.groupName })

      if (dropped.length === 0) return []
      const touched = await db
        .select({ email: groups.email })
        .from(groups)
        .where(
          inArray(
            groups.name,
            dropped.map((d) => d.groupName),
          ),
        )
      return touched.flatMap((t) => (t.email ? [t.email] : []))
    },
  }
}

/** The Sent-copy pass's view of the same rows. */
export function sentCopyStore(db: Database): SentCopyStore {
  return {
    async teams() {
      const rows = await db
        .select({
          name: groups.name,
          address: groups.email,
          member: accounts.email,
        })
        .from(groups)
        .innerJoin(groupMembers, eq(groupMembers.groupName, groups.name))
        .innerJoin(accounts, eq(accounts.clerkUserId, groupMembers.clerkUserId))
        // Only a team inbox, and only a member the directory still serves: a
        // suspended mailbox is not read.
        .where(
          and(
            isNotNull(groups.tenantId),
            isNotNull(groups.email),
            eq(accounts.active, true),
          ),
        )
        .orderBy(asc(groups.name), asc(accounts.email))

      const byName = new Map<
        string,
        { name: string; address: string; members: { address: string }[] }
      >()
      for (const row of rows) {
        const team = byName.get(row.name) ?? {
          name: row.name,
          address: row.address!,
          members: [],
        }
        team.members.push({ address: row.member })
        byName.set(row.name, team)
      }
      return [...byName.values()]
    },

    async copied(name, messageIds) {
      if (messageIds.length === 0) return new Set()
      const rows = await db
        .select({ messageId: groupSentCopies.messageId })
        .from(groupSentCopies)
        .where(
          and(
            eq(groupSentCopies.groupName, name),
            inArray(groupSentCopies.messageId, messageIds),
          ),
        )
      return new Set(rows.map((r) => r.messageId))
    },

    async record(name, messageIds) {
      if (messageIds.length === 0) return
      await db
        .insert(groupSentCopies)
        .values(messageIds.map((messageId) => ({ groupName: name, messageId })))
        .onConflictDoNothing()
    },
  }
}
