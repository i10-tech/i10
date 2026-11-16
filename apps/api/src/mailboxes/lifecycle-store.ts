import { and, asc, eq, gt, isNotNull, like, sql } from "drizzle-orm"
import type { MailboxDeletionOutcome } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { mailboxDeletions, mailboxUsage } from "../db/core.js"
import { directoryMailboxes, events } from "../db/identity.js"
import { accounts, aliases, groupMembers, groups } from "../db/schema.js"
import type { AuditEvent } from "../identity/ports.js"
import { directoryMail, inWorkspace } from "./store.js"

/**
 * The database half of a mailbox's deletion (mailboxes/lifecycle.ts).
 *
 * ⚠ EVERY TRANSITION IS ONE TRANSACTION OF THE `authd` ROW, THE
 * `core.mailbox_deletions` ROW AND THE AUDIT EVENT, under a lock on the deletion
 * row (or, to begin, on the account), so a restore and the purge can never both
 * win: whichever takes the lock first decides, and the other reads what it left.
 * Time-dependent decisions compare the clock the caller passes, inside the lock,
 * so a test can set it and a pod whose clock is wrong deletes nothing early.
 *
 * ⚠ THE ONLY WRITER OF `authd.accounts.deleting_at`. The gate must never be set
 * without its row or cleared without the restore that deletes it.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export interface DeletionRow {
  tenantId: string
  clerkUserId: string
  address: string
  outcome: MailboxDeletionOutcome
  forwardUserId: string | null
  forwardAddress: string | null
  requestedBy: string
  deletingAt: Date
  purgeAfter: Date
}

/** The mailbox of a workspace, as the lifecycle needs to see it. */
export interface MailboxRef {
  clerkUserId: string
  address: string
  active: boolean
  suspended: boolean
  deleting: boolean
}

export type BeginResult =
  | { status: "deleting"; row: DeletionRow }
  | { status: "already" }
  | { status: "gone" }
  /** The forward target is not a mailbox of this workspace that can take mail. */
  | { status: "forward_invalid" }
  /** A forward already stands for this address (a leaver policy's, say). */
  | { status: "forward_exists" }
  /** Other addresses are forwarded to this mailbox, which deleting would strand. */
  | { status: "forward_target_in_use" }

export type RestoreResult = "restored" | "not_deleting" | "window_closed"

/** What the purge reads before it starts: the intent and what is left to remove. */
export interface PurgeFacts {
  row: DeletionRow
  /** The account row, or null when the projection already removed it. */
  account: { address: string; active: boolean } | null
  /**
   * The addresses to take off the person's Clerk user: the mailbox's own and the
   * aliases Clerk gave it (a directory's are the directory's, and go with the row).
   */
  clerkAddresses: string[]
}

export interface MailboxLifecycleStore {
  find(tenantId: string, address: string): Promise<MailboxRef | null>
  deletion(tenantId: string, clerkUserId: string): Promise<DeletionRow | null>
  begin(input: {
    tenantId: string
    clerkUserId: string
    outcome: MailboxDeletionOutcome
    forward?: { userId: string; address: string } | undefined
    requestedBy: string
    at: Date
    graceDays: number
  }): Promise<BeginResult>
  restore(
    tenantId: string,
    clerkUserId: string,
    actorUserId: string,
    at: Date,
  ): Promise<RestoreResult>
  /** Deleting mailboxes of every workspace, in id order after `after`. */
  deleting(
    after: string | null,
    limit: number,
  ): Promise<{ tenantId: string; clerkUserId: string }[]>
  facts(tenantId: string, clerkUserId: string): Promise<PurgeFacts | null>
  /**
   * The purge's first step: the address stops receiving. `not_due` before the
   * date; `gone` when there is no deletion row (restored, or already purged).
   */
  close(
    tenantId: string,
    clerkUserId: string,
    at: Date,
  ): Promise<"closed" | "not_due" | "gone">
  /** The purge's last step: the rows. `gone` when there is no deletion row. */
  finish(
    tenantId: string,
    clerkUserId: string,
    note: { clerkKept: string[] },
  ): Promise<"purged" | "gone">
}

const fwdName = (userId: string) => `fwd-${userId}`

export const audit = (tx: Tx, tenantId: string, event: AuditEvent) =>
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

const toRow = (r: typeof mailboxDeletions.$inferSelect): DeletionRow => ({
  tenantId: r.tenantId,
  clerkUserId: r.clerkUserId,
  address: r.address,
  outcome: r.outcome as MailboxDeletionOutcome,
  forwardUserId: r.forwardUserId,
  forwardAddress: r.forwardAddress,
  requestedBy: r.requestedBy,
  deletingAt: r.deletingAt,
  purgeAfter: r.purgeAfter,
})

const DAY_MS = 24 * 60 * 60 * 1000

export function mailboxLifecycleStore(db: Database): MailboxLifecycleStore {
  const lockedRow = (tx: Tx, tenantId: string, clerkUserId: string) =>
    tx
      .select()
      .from(mailboxDeletions)
      .where(
        and(
          eq(mailboxDeletions.tenantId, tenantId),
          eq(mailboxDeletions.clerkUserId, clerkUserId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null)

  return {
    async find(tenantId, address) {
      const [row] = await db
        .select({
          clerkUserId: accounts.clerkUserId,
          address: accounts.email,
          active: accounts.active,
          suspendedAt: accounts.suspendedAt,
          deletingAt: accounts.deletingAt,
        })
        .from(accounts)
        .where(
          and(eq(accounts.email, address.trim().toLowerCase()), inWorkspace(tenantId)),
        )
        .limit(1)
      return row
        ? {
            clerkUserId: row.clerkUserId,
            address: row.address,
            active: row.active,
            suspended: row.suspendedAt !== null,
            deleting: row.deletingAt !== null,
          }
        : null
    },

    async deletion(tenantId, clerkUserId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(mailboxDeletions)
          .where(
            and(
              eq(mailboxDeletions.tenantId, tenantId),
              eq(mailboxDeletions.clerkUserId, clerkUserId),
            ),
          )
          .limit(1),
      )
      return row ? toRow(row) : null
    },

    async begin(input) {
      const { tenantId, clerkUserId } = input
      return withTenant(db, tenantId, async (tx): Promise<BeginResult> => {
        const [account] = await tx
          .select({
            address: accounts.email,
            deletingAt: accounts.deletingAt,
          })
          .from(accounts)
          .where(and(eq(accounts.clerkUserId, clerkUserId), inWorkspace(tenantId)))
          .for("update")
        if (!account) return { status: "gone" }
        if (account.deletingAt !== null) return { status: "already" }

        // ⚠ NOBODY MAY BE LEFT FORWARDING TO A MAILBOX THAT IS ABOUT TO GO. A
        // forward's list has its target as its only member, and the member's row
        // cascades away with the mailbox, which would leave a list that accepts
        // mail for nobody. Refused rather than rewired: where those addresses go
        // instead is somebody's decision.
        const [inUse] = await tx
          .select({ name: groupMembers.groupName })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.clerkUserId, clerkUserId),
              like(groupMembers.groupName, "fwd-%"),
            ),
          )
          .limit(1)
        if (inUse) return { status: "forward_target_in_use" }

        if (input.outcome === "forward") {
          const target = input.forward
          if (!target || target.userId === clerkUserId)
            return { status: "forward_invalid" }
          const [taker] = await tx
            .select({
              active: accounts.active,
              suspendedAt: accounts.suspendedAt,
              deletingAt: accounts.deletingAt,
            })
            .from(accounts)
            .where(and(eq(accounts.clerkUserId, target.userId), inWorkspace(tenantId)))
            .for("share")
          if (!taker || !taker.active || taker.suspendedAt || taker.deletingAt)
            return { status: "forward_invalid" }
          const [existing] = await tx
            .select({ name: groups.name })
            .from(groups)
            .where(eq(groups.name, fwdName(clerkUserId)))
          if (existing) return { status: "forward_exists" }
        }

        const purgeAfter = new Date(input.at.getTime() + input.graceDays * DAY_MS)
        await tx
          .update(accounts)
          .set({
            deletingAt: input.at,
            // ⚠ THE EPOCH TOO: nothing cached from before the deletion is honoured
            // if the mailbox is restored, so the person asks the identity provider
            // again. The gate itself is `deleting_at`; this is for the way back.
            credentialEpoch: sql`${accounts.credentialEpoch} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(accounts.clerkUserId, clerkUserId))

        const [row] = await tx
          .insert(mailboxDeletions)
          .values({
            tenantId,
            clerkUserId,
            address: account.address,
            outcome: input.outcome,
            forwardUserId: input.forward?.userId ?? null,
            forwardAddress: input.forward?.address ?? null,
            requestedBy: input.requestedBy,
            deletingAt: input.at,
            purgeAfter,
          })
          .returning()

        // The route is the existing one: a list named after the person, at their
        // own address, with the target as its only member (`directoryMail.setRoute`).
        // From now on the target gets a copy; at the purge it is all that is left.
        if (input.outcome === "forward" && input.forward)
          await directoryMail.setRoute(tx, {
            kind: "fwd",
            leaverId: clerkUserId,
            email: account.address,
            targetId: input.forward.userId,
          })

        await audit(tx, tenantId, {
          type: "mailbox.deleting",
          actorUserId: input.requestedBy,
          subjectUserId: clerkUserId,
          data: {
            outcome: input.outcome,
            purgeAfter: purgeAfter.toISOString(),
            ...(input.forward ? { forwardTo: input.forward.address } : {}),
          },
        })
        return { status: "deleting", row: toRow(row!) }
      })
    },

    async restore(tenantId, clerkUserId, actorUserId, at) {
      return withTenant(db, tenantId, async (tx): Promise<RestoreResult> => {
        const row = await lockedRow(tx, tenantId, clerkUserId)
        if (!row) return "not_deleting"
        // ⚠ THE DEADLINE IS THE PURGE'S DATE, read under the lock the purge's own
        // first step takes: after it the mailbox may already have stopped receiving,
        // and a restore would hand back a login on an address that is being taken
        // apart.
        if (at.getTime() >= row.purgeAfter.getTime()) return "window_closed"

        await tx
          .update(accounts)
          .set({ deletingAt: null, updatedAt: sql`now()` })
          .where(and(eq(accounts.clerkUserId, clerkUserId), inWorkspace(tenantId)))
        if (row.outcome === "forward")
          await tx.delete(groups).where(eq(groups.name, fwdName(clerkUserId)))
        await tx
          .delete(mailboxDeletions)
          .where(
            and(
              eq(mailboxDeletions.tenantId, tenantId),
              eq(mailboxDeletions.clerkUserId, clerkUserId),
            ),
          )
        await audit(tx, tenantId, {
          type: "mailbox.restored",
          actorUserId,
          subjectUserId: clerkUserId,
          data: { outcome: row.outcome },
        })
        return "restored"
      })
    },

    async deleting(after, limit) {
      const rows = await db
        .select({ tenantId: accounts.tenantId, clerkUserId: accounts.clerkUserId })
        .from(accounts)
        .where(
          and(
            isNotNull(accounts.deletingAt),
            isNotNull(accounts.tenantId),
            after ? gt(accounts.clerkUserId, after) : undefined,
          ),
        )
        .orderBy(asc(accounts.clerkUserId))
        .limit(limit)
      return rows.flatMap((r) =>
        r.tenantId ? [{ tenantId: r.tenantId, clerkUserId: r.clerkUserId }] : [],
      )
    },

    async facts(tenantId, clerkUserId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(mailboxDeletions)
          .where(
            and(
              eq(mailboxDeletions.tenantId, tenantId),
              eq(mailboxDeletions.clerkUserId, clerkUserId),
            ),
          )
          .limit(1)
        if (!row) return null
        const [account] = await tx
          .select({ address: accounts.email, active: accounts.active })
          .from(accounts)
          .where(and(eq(accounts.clerkUserId, clerkUserId), inWorkspace(tenantId)))
          .limit(1)
        const given = await tx
          .select({ address: aliases.address })
          .from(aliases)
          .where(and(eq(aliases.clerkUserId, clerkUserId), eq(aliases.source, "clerk")))
        return {
          row: toRow(row),
          account: account ?? null,
          // The row's address, copied when the deletion began, as well as the
          // account's current one: a rename in between must not leave the old one.
          clerkAddresses: [
            ...new Set([
              row.address,
              ...(account ? [account.address] : []),
              ...given.map((a) => a.address),
            ]),
          ],
        }
      })
    },

    async close(tenantId, clerkUserId, at) {
      return withTenant(db, tenantId, async (tx) => {
        const row = await lockedRow(tx, tenantId, clerkUserId)
        if (!row) return "gone" as const
        if (at.getTime() < row.purgeAfter.getTime()) return "not_due" as const

        // ⚠ `active = false` IS THE ONE WRITE THAT STOPS THE ADDRESS RECEIVING:
        // authd's recipient lookups read `WHERE a.active`, so from the next
        // delivery Stalwart refuses the address (550) instead of creating a fresh,
        // empty account for it once the real one is destroyed. It comes BEFORE the
        // destroy for that reason. For a forward the list still answers, so mail
        // goes on reaching the target.
        const closed = await tx
          .update(accounts)
          .set({ active: false, updatedAt: sql`now()` })
          .where(
            and(
              eq(accounts.clerkUserId, clerkUserId),
              inWorkspace(tenantId),
              eq(accounts.active, true),
            ),
          )
          .returning({ id: accounts.clerkUserId })
        if (closed.length > 0)
          await audit(tx, tenantId, {
            type: "mailbox.purge_started",
            subjectUserId: clerkUserId,
            data: { outcome: row.outcome },
          })

        // ⚠ A FORWARD WHOSE TARGET IS GONE FORWARDS TO NOBODY: its only member's row
        // cascaded away. The address then goes the way of a plain delete (refused)
        // rather than staying a list that accepts mail and keeps it for no one.
        if (row.outcome === "forward") {
          const [member] = await tx
            .select({ id: groupMembers.clerkUserId })
            .from(groupMembers)
            .where(eq(groupMembers.groupName, fwdName(clerkUserId)))
            .limit(1)
          if (!member) {
            await tx.delete(groups).where(eq(groups.name, fwdName(clerkUserId)))
            await audit(tx, tenantId, {
              type: "mailbox.forward_lost",
              subjectUserId: clerkUserId,
              data: { forwardTo: row.forwardAddress },
            })
          }
        }
        return "closed" as const
      })
    },

    async finish(tenantId, clerkUserId, note) {
      return withTenant(db, tenantId, async (tx) => {
        const row = await lockedRow(tx, tenantId, clerkUserId)
        if (!row) return "gone" as const

        // ⚠ A FORWARD KEEPS ITS LIST: from here it is what the address is. Every
        // other outcome drops the person's routes, as the directory's own delete does.
        if (row.outcome !== "forward") await directoryMail.dropRoutes(tx, clerkUserId)
        await tx
          .delete(directoryMailboxes)
          .where(
            and(
              eq(directoryMailboxes.tenantId, tenantId),
              eq(directoryMailboxes.clerkUserId, clerkUserId),
            ),
          )
        // ⚠ ONLY AN ACCOUNT STILL MARKED DELETING. The row lock above means a
        // restore either committed first (no deletion row, so we returned) or waits
        // for this; the predicate is the second line, so a mailbox somebody gave
        // the same person back is never what this removes. Aliases, list seats and
        // the storage allocation go with it.
        await tx
          .delete(accounts)
          .where(
            and(
              eq(accounts.clerkUserId, clerkUserId),
              inWorkspace(tenantId),
              isNotNull(accounts.deletingAt),
            ),
          )
        await tx
          .delete(mailboxUsage)
          .where(
            and(
              eq(mailboxUsage.tenantId, tenantId),
              eq(mailboxUsage.address, row.address),
            ),
          )
        await tx
          .delete(mailboxDeletions)
          .where(
            and(
              eq(mailboxDeletions.tenantId, tenantId),
              eq(mailboxDeletions.clerkUserId, clerkUserId),
            ),
          )
        await audit(tx, tenantId, {
          type: "mailbox.purged",
          subjectUserId: clerkUserId,
          data: {
            outcome: row.outcome,
            address: row.address,
            ...(note.clerkKept.length > 0 ? { clerkAddressKept: note.clerkKept } : {}),
          },
        })
        return "purged" as const
      })
    },
  }
}
