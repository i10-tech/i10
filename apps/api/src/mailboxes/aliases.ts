import { and, asc, eq, sql } from "drizzle-orm"
import { MAILBOX_ALIAS_LIMIT, type MailboxAliasSource } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { accounts, aliases } from "../db/schema.js"
import { audit } from "./lifecycle-store.js"
import { addressHeld, inWorkspace } from "./store.js"

/**
 * An owner or admin giving a mailbox more addresses, on any domain the workspace
 * hosts mail on (B8).
 *
 * ⚠ AN ALIAS IS A ROW IN `authd.aliases` WITH `source = 'console'`, NOT A CLERK
 * ADDRESS. authd already serves every row of that table as the person's
 * `mailAlias`, and Stalwart's recipient filter matches `mailAlias`, so a row is
 * all it takes for mail to arrive; and Stalwart's `mustMatchSender` (left at its
 * default) lets a session send as any address of its own account, so the same row
 * is the right to send as it. Putting the address on the Clerk user instead would
 * make it a way to SIGN IN as the person, which an alias on a second domain should
 * not be, and would put a Clerk round trip between the admin's click and a mailbox
 * that can fail half-way. The projection replaces only `source = 'clerk'` and the
 * directory only `source = 'directory'`, so neither can touch these.
 *
 * ⚠ NOTHING HERE WRITES THE MAILBOX. `authd.accounts` has one writer (the
 * projection); this adds and removes only the alias rows that hang off it, and
 * every write takes the account row's lock, so two admins cannot both take the
 * last slot of the cap, and the purge (which deletes the account) and an add
 * cannot interleave into an alias with no mailbox.
 *
 * ⚠ REMOVAL TAKES EFFECT AT ONCE ON OUR SIDE: authd reads `authd.aliases` per
 * lookup and keeps no recipient cache, so the next RCPT TO for the address is
 * answered from the table. Whether Stalwart itself holds on to an address it has
 * already learned is not something this repo can show (see the report on B8).
 */

export interface AliasRow {
  address: string
  source: MailboxAliasSource
}

export type AliasListOutcome =
  | { status: "ok"; aliases: AliasRow[] }
  /** No such mailbox in this workspace, or one a member is not allowed to see. */
  | { status: "not_found" }

export type AliasAddOutcome =
  | { status: "added"; aliases: AliasRow[] }
  | { status: "not_found" }
  | {
      status:
        /** The mailbox is in its deletion grace: the purge would release the alias. */
        | "deleting"
        /** Not a domain THIS workspace hosts mail on. Other workspaces' read the same. */
        | "domain_not_hosted"
        /** Held by a mailbox, an alias or a list, anybody's. */
        | "taken"
        | "limit"
    }

export type AliasRemoveOutcome =
  | { status: "removed"; aliases: AliasRow[] }
  | { status: "not_found" }
  /** Clerk's or a directory's: not the console's to remove. */
  | { status: "not_removable" }

/** Who is asking to see a mailbox's aliases. */
export interface AliasViewer {
  tenantId: string
  userId: string
  isAdmin: boolean
}

export interface MailboxAliases {
  /** An owner or admin of the workspace. */
  isAdmin(tenantId: string, userId: string): Promise<boolean>
  /** An admin sees any mailbox's aliases; anybody else only their own. */
  list(viewer: AliasViewer, address: string): Promise<AliasListOutcome>
  add(input: {
    tenantId: string
    /** The mailbox. */
    address: string
    /** The new alias, already normalised by the contract. */
    alias: string
    actorId: string
  }): Promise<AliasAddOutcome>
  remove(input: {
    tenantId: string
    address: string
    alias: string
    actorId: string
  }): Promise<AliasRemoveOutcome>
}

export interface MailboxAliasDeps {
  db: Database
  isAdmin(tenantId: string, userId: string): Promise<boolean>
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

const domainOf = (address: string) =>
  address.slice(address.lastIndexOf("@") + 1).toLowerCase()

const toRow = (r: { address: string; source: string }): AliasRow => ({
  address: r.address,
  source:
    r.source === "console" || r.source === "directory" ? r.source : ("clerk" as const),
})

export function mailboxAliases(deps: MailboxAliasDeps): MailboxAliases {
  const { db } = deps

  const aliasesOf = async (tx: Pick<Database, "select">, clerkUserId: string) =>
    (
      await tx
        .select({ address: aliases.address, source: aliases.source })
        .from(aliases)
        .where(eq(aliases.clerkUserId, clerkUserId))
        .orderBy(asc(aliases.address))
    ).map(toRow)

  /**
   * The workspace's mailbox, locked for the rest of the transaction.
   *
   * ⚠ BY `inWorkspace`, THE SAME MEMBERSHIP THE LIFECYCLE USES: the domain's
   * owner decides, `tenant_id` only where nobody else hosts the name. `authd` has
   * no row level security, so this is the whole isolation between workspaces.
   */
  const lockedMailbox = (tx: Tx, tenantId: string, address: string) =>
    tx
      .select({
        clerkUserId: accounts.clerkUserId,
        deletingAt: accounts.deletingAt,
      })
      .from(accounts)
      .where(
        and(eq(accounts.email, address.trim().toLowerCase()), inWorkspace(tenantId)),
      )
      .for("update")
      .then((rows) => rows[0] ?? null)

  return {
    isAdmin: (tenantId, userId) => deps.isAdmin(tenantId, userId),

    async list(viewer, address) {
      const [row] = await db
        .select({ clerkUserId: accounts.clerkUserId })
        .from(accounts)
        .where(
          and(
            eq(accounts.email, address.trim().toLowerCase()),
            inWorkspace(viewer.tenantId),
            // ⚠ A MEMBER ASKING FOR SOMEBODY ELSE'S MAILBOX GETS THE ANSWER FOR ONE
            // THAT DOES NOT EXIST, so the route cannot be used to find out which
            // addresses are mailboxes.
            viewer.isAdmin ? undefined : eq(accounts.clerkUserId, viewer.userId),
          ),
        )
        .limit(1)
      if (!row) return { status: "not_found" }
      return { status: "ok", aliases: await aliasesOf(db, row.clerkUserId) }
    },

    async add({ tenantId, address, alias, actorId }) {
      const wanted = alias.trim().toLowerCase()
      return withTenant(db, tenantId, async (tx): Promise<AliasAddOutcome> => {
        const mailbox = await lockedMailbox(tx, tenantId, address)
        if (!mailbox) return { status: "not_found" }
        // ⚠ NOT ONE IN ITS DELETION GRACE. The purge releases every alias with the
        // account, so an alias added now would be given back within days - and a
        // mailbox that is going away is the wrong place to start receiving.
        if (mailbox.deletingAt !== null) return { status: "deleting" }

        // ⚠ THE WORKSPACE'S OWN HOSTED DOMAINS, through the function the projection
        // and the hosting switch use, inside this transaction. Not `core.domains`:
        // `core.mailbox_domains()` is where "verified and hosting mail" is decided,
        // and another workspace's domain reads exactly like one nobody hosts.
        const hosted = (await tx.execute(
          sql`select 1 from core.mailbox_domains()
               where tenant_id = ${tenantId}::uuid
                 and lower(name) = ${domainOf(wanted)}
               limit 1`,
        )) as unknown as unknown[]
        if (hosted.length === 0) return { status: "domain_not_hosted" }

        // ⚠ THE CAP COUNTS THE ONES THE CONSOLE ADDED, under the account's lock.
        const [{ held }] = (await tx
          .select({ held: sql<number>`count(*)::int` })
          .from(aliases)
          .where(
            and(
              eq(aliases.clerkUserId, mailbox.clerkUserId),
              eq(aliases.source, "console"),
            ),
          )) as [{ held: number }]
        if (held >= MAILBOX_ALIAS_LIMIT) return { status: "limit" }

        if (await addressHeld(tx, wanted)) return { status: "taken" }

        // ⚠ `onConflictDoNothing` IS THE SECOND LINE, NOT THE FIRST. Two admins adding
        // the same address to two mailboxes both pass the check above; the primary
        // key lets one win and this loses safely. (An account or list created in the
        // same instant is not guarded: no constraint spans the three tables, as for
        // a mailbox's own creation.)
        const made = await tx
          .insert(aliases)
          .values({
            address: wanted,
            clerkUserId: mailbox.clerkUserId,
            source: "console",
          })
          .onConflictDoNothing()
          .returning({ address: aliases.address })
        if (made.length === 0) return { status: "taken" }

        await audit(tx, tenantId, {
          type: "mailbox.alias_added",
          actorUserId: actorId,
          subjectUserId: mailbox.clerkUserId,
          data: { mailbox: address.trim().toLowerCase(), alias: wanted },
        })
        return { status: "added", aliases: await aliasesOf(tx, mailbox.clerkUserId) }
      })
    },

    async remove({ tenantId, address, alias, actorId }) {
      const target = alias.trim().toLowerCase()
      return withTenant(db, tenantId, async (tx): Promise<AliasRemoveOutcome> => {
        const mailbox = await lockedMailbox(tx, tenantId, address)
        if (!mailbox) return { status: "not_found" }

        // ⚠ ONLY THIS MAILBOX'S ALIAS: an address that is somebody else's alias reads
        // as not found, so removal cannot be pointed at another person's.
        const [row] = await tx
          .select({ source: aliases.source })
          .from(aliases)
          .where(
            and(
              eq(aliases.address, target),
              eq(aliases.clerkUserId, mailbox.clerkUserId),
            ),
          )
        if (!row) return { status: "not_found" }
        // ⚠ CLERK'S AND A DIRECTORY'S ARE NOT OURS TO DELETE. The next webhook or push
        // would put either straight back, so removing one would look done and
        // silently not be.
        if (row.source !== "console") return { status: "not_removable" }

        await tx
          .delete(aliases)
          .where(
            and(
              eq(aliases.address, target),
              eq(aliases.clerkUserId, mailbox.clerkUserId),
            ),
          )
        // ⚠ ALLOWED DURING A DELETION GRACE, unlike adding: letting go of an address
        // is never what an admin should have to wait for.
        await audit(tx, tenantId, {
          type: "mailbox.alias_removed",
          actorUserId: actorId,
          subjectUserId: mailbox.clerkUserId,
          data: { mailbox: address.trim().toLowerCase(), alias: target },
        })
        return { status: "removed", aliases: await aliasesOf(tx, mailbox.clerkUserId) }
      })
    },
  }
}
