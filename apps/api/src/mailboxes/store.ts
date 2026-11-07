import { and, eq, inArray, not, sql } from "drizzle-orm"
import { union } from "drizzle-orm/pg-core"
import type { Mailbox } from "@repo/contracts"
import type { Database } from "../db/client.js"
import { accounts, aliases, groupMembers, groups } from "../db/schema.js"
import { directoryGroups } from "../db/identity.js"
import type { MailboxDirectory } from "./provision.js"

/**
 * The projection's rows, read and gated for provisioning.
 *
 * ⚠ NO `withTenant` ANYWHERE IN THIS FILE, AND THAT IS NOT AN OVERSIGHT. The
 * `authd` schema has no row level security - no migration ever enabled it,
 * unlike every table in `core` - so wrapping these in a tenant context would
 * set a variable no policy reads and buy nothing but the appearance of safety.
 * Isolation here is `domainOwner`: a caller may only ever reach an address on a
 * domain some tenant has verified, and the seat is charged to that tenant. The
 * same reasoning is written out at `metering/levels.ts`.
 */
export function mailboxDirectory(db: Database): MailboxDirectory {
  return {
    /**
     * ⚠ THROUGH THE FUNCTION, NEVER THE TABLE. `core.mailbox_domains()` is
     * `SECURITY DEFINER` and carries the two predicates that make a domain safe
     * to host mail on - verified, and marked as hosting mailboxes. Querying
     * `core.domains` here would be a second copy of a security boundary, free
     * to drift from the one the projection uses.
     *
     * ⚠ AND IT IS THE ONE STATEMENT IN THIS FILE THAT IS NOT DRIZZLE, because
     * a set-returning function is not a table and there is nothing in the
     * schema to type it against. `projection/writer.ts` reaches for the same
     * function the same way; the typed alternative would be declaring a fake
     * table over it, which types the columns by asserting them and hides that
     * the shape is unchecked. Everything with a real table behind it -
     * `accounts`, `aliases` - goes through the query builder.
     */
    async domainOwner(domain) {
      const rows = (await db.execute(
        sql`select tenant_id::text as tenant_id
              from core.mailbox_domains()
             where lower(name) = ${domain.toLowerCase()}
             limit 1`,
      )) as unknown as { tenant_id: string | null }[]

      return rows[0]?.tenant_id ?? null
    },

    /**
     * ⚠ ACCOUNTS *AND* ALIASES. An address free in one table and taken in the
     * other is already receiving somebody's mail; checking only `accounts`
     * would hand a stranger an address that currently delivers to a real
     * person. The unique constraints would catch the first case and not the
     * second, and only after we had written to Clerk.
     */
    async addressTaken(address) {
      // ⚠ ONE ROUND TRIP, NOT TWO SELECTS. The two halves have to be answered
      // against the same snapshot: asking sequentially leaves a window where an
      // address is free in the first query and claimed as an alias before the
      // second, which is exactly the race this check exists to lose safely.
      const rows = await union(
        db
          .select({ address: accounts.email })
          .from(accounts)
          .where(eq(accounts.email, address)),
        db
          .select({ address: aliases.address })
          .from(aliases)
          .where(eq(aliases.address, address)),
      ).limit(1)

      return rows.length > 0
    },

    async current(userId) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.clerkUserId, userId))
        .limit(1)

      return row ? toMailbox(row) : null
    },

    /**
     * ⚠ THE ONE PLACE `active` IS EVER SET TRUE. It is the subscription gate:
     * authd's every query filters on it, so a mailbox is invisible - no bind,
     * no delivery - until this runs. It is deliberately not part of the
     * projection's upsert, which must never touch it.
     */
    async activate(userId) {
      const [row] = await db
        .update(accounts)
        .set({ active: true, updatedAt: sql`now()` })
        .where(eq(accounts.clerkUserId, userId))
        .returning()

      return row ? toMailbox(row) : null
    },
  }
}

type AccountRow = typeof accounts.$inferSelect

function toMailbox(row: AccountRow): Mailbox {
  return {
    object: "mailbox",
    address: row.email,
    display_name: row.displayName,
    active: row.active,
    created_at: row.createdAt.toISOString(),
    storage_allocated: row.storageAllocation,
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/**
 * Everything a company's directory (#344) writes to the projection, in ONE
 * place beside `activate`: suspension, directory aliases, directory lists.
 *
 * ⚠ EVERY FUNCTION TAKES A TRANSACTION, because each is one half of a change
 * whose other half is a row in `identity.directory_mailboxes` (or the group's
 * opt-in), and the two must agree after a crash. None of them touches
 * `active`: a mailbox becomes visible only through `MailboxDirectory.activate`.
 *
 * ⚠ NONE OF THEM ACTS ON AN ACCOUNT OF ANOTHER WORKSPACE. Each takes the
 * tenant and matches `authd.accounts.tenant_id`, which the projection derives
 * from the domain's owner. `authd` has no row level security, so this WHERE
 * clause is the whole isolation, as in `metering/levels.ts`.
 */
export const directoryMail = {
  /** The account a workspace's domain gave this person, or null. */
  async account(tx: Tx, tenantId: string, userId: string) {
    const [row] = await tx
      .select({
        email: accounts.email,
        active: accounts.active,
        suspendedAt: accounts.suspendedAt,
      })
      .from(accounts)
      .where(and(eq(accounts.clerkUserId, userId), eq(accounts.tenantId, tenantId)))
      .limit(1)
    return row ?? null
  },

  /**
   * Refuses the login and keeps delivering: authd's bind turns a set
   * `suspended_at` away, and its searches do not look at it. Idempotent.
   */
  async suspend(tx: Tx, tenantId: string, userId: string, at: Date): Promise<boolean> {
    const done = await tx
      .update(accounts)
      .set({
        suspendedAt: sql`coalesce(${accounts.suspendedAt}, ${at.toISOString()}::timestamptz)`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(accounts.clerkUserId, userId), eq(accounts.tenantId, tenantId)))
      .returning({ id: accounts.clerkUserId })
    return done.length > 0
  },

  async resume(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
    const done = await tx
      .update(accounts)
      .set({ suspendedAt: null, updatedAt: sql`now()` })
      .where(and(eq(accounts.clerkUserId, userId), eq(accounts.tenantId, tenantId)))
      .returning({ id: accounts.clerkUserId })
    return done.length > 0
  },

  /** The mailbox is gone: no recipient, no login. Aliases and list seats cascade. */
  async drop(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
    const done = await tx
      .delete(accounts)
      .where(and(eq(accounts.clerkUserId, userId), eq(accounts.tenantId, tenantId)))
      .returning({ id: accounts.clerkUserId })
    return done.length > 0
  },

  /**
   * Makes `wanted` the person's directory aliases. An address that is anybody
   * else's mailbox or alias is left out and returned in `taken`.
   *
   * ⚠ `onConflictDoNothing`, NEVER AN UPDATE. An alias belonging to another
   * person (or a Clerk-sourced one of this person) is not the directory's to
   * take; the insert simply loses, and the loss is counted by the caller.
   */
  async setAliases(
    tx: Tx,
    userId: string,
    wanted: readonly string[],
  ): Promise<{ taken: string[] }> {
    await tx
      .delete(aliases)
      .where(
        and(
          eq(aliases.clerkUserId, userId),
          eq(aliases.source, "directory"),
          wanted.length > 0 ? not(inArray(aliases.address, [...wanted])) : undefined,
        ),
      )
    if (wanted.length === 0) return { taken: [] }
    // An address that is some account's primary is not an alias of another.
    const primaries = await tx
      .select({ email: accounts.email })
      .from(accounts)
      .where(
        and(
          inArray(accounts.email, [...wanted]),
          not(eq(accounts.clerkUserId, userId)),
        ),
      )
    const blocked = new Set(primaries.map((r) => r.email))
    const free = wanted.filter((a) => !blocked.has(a))
    if (free.length > 0)
      await tx
        .insert(aliases)
        .values(
          free.map((address) => ({
            address,
            clerkUserId: userId,
            source: "directory",
          })),
        )
        .onConflictDoNothing()
    const mine = await tx
      .select({ address: aliases.address })
      .from(aliases)
      .where(
        and(eq(aliases.clerkUserId, userId), inArray(aliases.address, [...wanted])),
      )
    const held = new Set(mine.map((r) => r.address))
    return { taken: wanted.filter((a) => !held.has(a)) }
  },

  /** `taken`: the address is some account's, alias or another list. */
  async mirrorGroup(
    tx: Tx,
    input: {
      name: string
      email: string
      description: string | null
      directoryGroupId: string
    },
  ): Promise<"mirrored" | "taken"> {
    const [primary] = await tx
      .select({ id: accounts.clerkUserId })
      .from(accounts)
      .where(eq(accounts.email, input.email))
      .limit(1)
    const [alias] = await tx
      .select({ id: aliases.address })
      .from(aliases)
      .where(eq(aliases.address, input.email))
      .limit(1)
    if (primary || alias) return "taken"
    const done = await tx
      .insert(groups)
      .values({
        name: input.name,
        email: input.email,
        description: input.description,
        directoryGroupId: input.directoryGroupId,
      })
      .onConflictDoUpdate({
        target: groups.name,
        set: { email: input.email, description: input.description },
        setWhere: eq(groups.directoryGroupId, input.directoryGroupId),
      })
      .returning({ name: groups.name })
    return done.length > 0 ? "mirrored" : "taken"
  },

  /**
   * Where a suspended mailbox's mail also goes (forward) or who may open it
   * (delegate): a list named after the leaver, with the target as its only
   * member, which authd serves through `filterMemberOf` like any list.
   *
   * ⚠ NOT A DIRECTORY LIST (`directory_group_id` stays null): its address is
   * the leaver's own, which `mirrorGroup` would refuse as taken, and it is
   * removed with the plan (`dropRoutes`), not with a group.
   */
  async setRoute(
    tx: Tx,
    input: {
      kind: "fwd" | "dlg"
      leaverId: string
      email: string | null
      targetId: string
    },
  ): Promise<void> {
    const name = `${input.kind}-${input.leaverId}`
    await tx
      .insert(groups)
      .values({ name, email: input.email, description: input.kind })
      .onConflictDoUpdate({
        target: groups.name,
        set: { email: input.email, description: input.kind },
      })
    await tx.delete(groupMembers).where(eq(groupMembers.groupName, name))
    await tx
      .insert(groupMembers)
      .values({ groupName: name, clerkUserId: input.targetId })
      .onConflictDoNothing()
  },

  async dropRoutes(tx: Tx, leaverId: string): Promise<void> {
    await tx
      .delete(groups)
      .where(inArray(groups.name, [`fwd-${leaverId}`, `dlg-${leaverId}`]))
  },

  async dropGroup(tx: Tx, directoryGroupId: string): Promise<void> {
    await tx.delete(groups).where(eq(groups.directoryGroupId, directoryGroupId))
  },

  /**
   * Makes `names` the directory lists of THIS workspace that the person is on,
   * and no others of theirs. Lists that do not come from this workspace's
   * directories are not touched.
   */
  async setMemberships(
    tx: Tx,
    tenantId: string,
    userId: string,
    names: readonly string[],
  ): Promise<void> {
    const ours = tx
      .select({ name: groups.name })
      .from(groups)
      .innerJoin(directoryGroups, eq(directoryGroups.id, groups.directoryGroupId))
      .where(eq(directoryGroups.tenantId, tenantId))
    await tx
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.clerkUserId, userId),
          inArray(groupMembers.groupName, ours),
          names.length > 0
            ? not(inArray(groupMembers.groupName, [...names]))
            : undefined,
        ),
      )
    if (names.length === 0) return
    await tx
      .insert(groupMembers)
      .values(names.map((groupName) => ({ groupName, clerkUserId: userId })))
      .onConflictDoNothing()
  },
}
