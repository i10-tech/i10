import { and, eq, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm"
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

/** The lowercased domain half of an address column. */
const domainOfEmail = sql`lower(split_part(${accounts.email}, '@', 2))`

/**
 * The accounts that belong to a workspace: the ones on a domain it hosts mail for
 * NOW, whatever `tenant_id` says, and the ones `tenant_id` names on a domain
 * nobody else hosts.
 *
 * ⚠ THE DOMAIN'S OWNER IS THE ANSWER, AND `tenant_id` IS ONLY THE FALLBACK. The
 * column is written from the domain's owner on every projection event, so it is
 * stale until a person's next Clerk event after a domain changes hands, and null
 * for a mailbox from before it was filled in. Going by the column alone has two
 * failures: a deprovision is told "no mailbox" for a person whose row was never
 * re-derived, and - worse - a workspace being deleted would suspend people on a
 * domain another workspace has since proved. So a name another workspace hosts
 * is never ours, whatever the column says; the column counts only where no one
 * else does (a domain already released in a redelivered termination, say).
 *
 * ⚠ BOTH SUBQUERIES ARE UNCORRELATED, so Postgres reads `core.mailbox_domains()`
 * once per statement and not once per account.
 */
const inWorkspace = (tenantId: string) =>
  or(
    sql`${domainOfEmail} in (
      select lower(name) from core.mailbox_domains() where tenant_id = ${tenantId}::uuid
    )`,
    and(
      eq(accounts.tenantId, tenantId),
      sql`${domainOfEmail} not in (
        select lower(name) from core.mailbox_domains()
         where tenant_id is not null and tenant_id <> ${tenantId}::uuid
      )`,
    ),
  )!

/**
 * Everything that turns a login off or on, other than a company's directory
 * (below), in ONE place: a workspace's, a domain's or a payment's.
 *
 * ⚠ EVERY FUNCTION ONLY EVER TOUCHES THE LOGIN. `active` stays true and no row is
 * deleted, so the mailbox keeps receiving and its mail is kept for an owner to
 * export, reassign or delete. authd refuses the bind from these columns before
 * its credential cache is read (services/authd ldapsrv/bind.go), which is what
 * makes each take effect on both pods on the next login.
 *
 * ⚠ NO RESUME HERE FOR A SUSPENSION. `suspended_at` is lifted only by the owner's
 * and the directory's path (`directoryMail.resume`), never by an event that merely
 * looks like the opposite of the one that set it: re-adding a removed member must
 * not quietly give back a login. A payment hold is the exception because payment
 * is its whole reason, and it is a column of its own.
 *
 * ⚠ THEY TAKE A WRITER, NOT A TRANSACTION, so a caller with one (the Clerk event
 * that changes membership, say) can make the revocation part of it.
 */
type Writer = Pick<Database, "update" | "delete" | "select">

export const mailAccess = {
  /** Every mailbox of the workspace. Returns who was newly suspended. */
  async suspendWorkspace(db: Writer, tenantId: string, at: Date): Promise<string[]> {
    const done = await db
      .update(accounts)
      .set({ suspendedAt: at, updatedAt: sql`now()` })
      .where(and(inWorkspace(tenantId), isNull(accounts.suspendedAt)))
      .returning({ id: accounts.clerkUserId })
    return done.map((r) => r.id)
  },

  /**
   * The mailboxes whose primary address is on a domain the workspace is giving
   * up, and the aliases on it.
   *
   * ⚠ THE ALIASES GO, THE ACCOUNTS BEHIND THEM STAY. An alias is a recipient, so
   * one on a domain the workspace gave up would go on receiving mail for a name
   * it no longer owns - and, as a login name, on opening it. A person whose
   * PRIMARY address is elsewhere keeps their mailbox and loses only that name;
   * one whose primary is on the domain is suspended outright (no address left).
   * The Clerk event that follows deletes such a row altogether (`projectUser`
   * finds no hosted address), which is the existing rule for somebody who gives
   * up their address; the suspension is what closes the login until then.
   *
   * ⚠ THE CALLER HAS ALREADY CHECKED THAT NO OTHER WORKSPACE HOSTS THE NAME
   * (`holdsName` says whether this one does), so this only reaches its own:
   * `tenant_id` is this workspace's, or null on a name this one hosts - a mailbox
   * from before the column was filled in can only have been theirs.
   */
  async suspendDomain(
    db: Writer,
    tenantId: string,
    domain: string,
    at: Date,
    holdsName: boolean,
  ): Promise<{ suspended: string[]; aliases: string[] }> {
    const name = domain.toLowerCase()
    const mine = holdsName
      ? or(eq(accounts.tenantId, tenantId), isNull(accounts.tenantId))
      : eq(accounts.tenantId, tenantId)
    const suspended = await db
      .update(accounts)
      .set({ suspendedAt: at, updatedAt: sql`now()` })
      .where(and(mine, isNull(accounts.suspendedAt), sql`${domainOfEmail} = ${name}`))
      .returning({ id: accounts.clerkUserId })
    const gone = await db
      .delete(aliases)
      .where(
        and(
          sql`lower(split_part(${aliases.address}, '@', 2)) = ${name}`,
          inArray(
            aliases.clerkUserId,
            db.select({ id: accounts.clerkUserId }).from(accounts).where(mine),
          ),
        ),
      )
      .returning({ address: aliases.address })
    return {
      suspended: suspended.map((r) => r.id),
      aliases: gone.map((r) => r.address),
    }
  },

  /**
   * Kills every cached password verification for the mailboxes on a domain that
   * stopped hosting mail, by raising their `credential_epoch` (#406).
   *
   * ⚠ IT SUSPENDS NOTHING. The login is refused by authd's DOMAIN gate
   * (`core.mailbox_domain_refused`, read in the same query as the account), not
   * by a per-mailbox stamp, so `suspended_at` stays exactly as an admin left it
   * and switching hosting back on needs no per-mailbox step. The epoch bump is
   * what makes the return honest: a password cached before the domain went off
   * is not honoured on the way back without asking the identity provider again.
   *
   * ⚠ THE SAME MEMBERSHIP RULE AS `suspendDomain`, and the caller has made the
   * same check that no other workspace hosts the name. Returns who it reached.
   */
  async invalidateDomain(
    db: Writer,
    tenantId: string,
    domain: string,
    holdsName: boolean,
  ): Promise<string[]> {
    const name = domain.toLowerCase()
    const mine = holdsName
      ? or(eq(accounts.tenantId, tenantId), isNull(accounts.tenantId))
      : eq(accounts.tenantId, tenantId)
    const done = await db
      .update(accounts)
      .set({
        credentialEpoch: sql`${accounts.credentialEpoch} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(mine, sql`${domainOfEmail} = ${name}`))
      .returning({ id: accounts.clerkUserId })
    return done.map((r) => r.id)
  },

  /**
   * The workspace's paid plan has lapsed: no login, mail keeps arriving. Idempotent.
   * Returns how many mailboxes it newly held.
   */
  async hold(db: Writer, tenantId: string, at: Date): Promise<number> {
    const done = await db
      .update(accounts)
      .set({ paymentHoldAt: at, updatedAt: sql`now()` })
      .where(and(inWorkspace(tenantId), isNull(accounts.paymentHoldAt)))
      .returning({ id: accounts.clerkUserId })
    return done.length
  },

  /** The workspace pays again. Lifts the hold and nothing else. Idempotent. */
  async release(db: Writer, tenantId: string): Promise<number> {
    const done = await db
      .update(accounts)
      .set({ paymentHoldAt: null, updatedAt: sql`now()` })
      .where(and(inWorkspace(tenantId), isNotNull(accounts.paymentHoldAt)))
      .returning({ id: accounts.clerkUserId })
    return done.length
  },
}

/**
 * `billing/grants.ts`'s `MailPaymentHold` over the projection: ONE wiring, used by
 * the API and by the reconciler CronJob that repairs a lost Polar webhook.
 *
 * ⚠ BOTH MUST HAVE IT. The reconciler is the backstop for a revocation whose event
 * never arrived, so a grant path built without this would leave exactly those
 * workspaces' logins open - the ones nobody was told about.
 */
export const paymentHold = (db: Writer) => ({
  hold: async (tenantId: string) => {
    await mailAccess.hold(db, tenantId, new Date())
  },
  release: async (tenantId: string) => {
    await mailAccess.release(db, tenantId)
  },
})

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
  /**
   * The account a workspace's domain gave this person, or null.
   *
   * ⚠ BY THE DOMAIN'S OWNER AS WELL AS `tenant_id` (`inWorkspace`), so a
   * deprovision cannot be told "no mailbox" for one whose column was never
   * re-derived.
   */
  async account(tx: Tx, tenantId: string, userId: string) {
    const [row] = await tx
      .select({
        email: accounts.email,
        active: accounts.active,
        suspendedAt: accounts.suspendedAt,
        // What else refuses the login, so a resume can say what it did not lift.
        paymentHoldAt: accounts.paymentHoldAt,
        banned: accounts.banned,
        // ⚠ LOCKED ONLY WHILE THE LOCKOUT HAS NOT RUN OUT, as authd reads it.
        locked: sql<boolean>`(${accounts.locked} and (${accounts.lockedUntil} is null or ${accounts.lockedUntil} > now()))`,
      })
      .from(accounts)
      .where(and(eq(accounts.clerkUserId, userId), inWorkspace(tenantId)))
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
      .where(and(eq(accounts.clerkUserId, userId), inWorkspace(tenantId)))
      .returning({ id: accounts.clerkUserId })
    return done.length > 0
  },

  async resume(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
    const done = await tx
      .update(accounts)
      .set({ suspendedAt: null, updatedAt: sql`now()` })
      .where(and(eq(accounts.clerkUserId, userId), inWorkspace(tenantId)))
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
