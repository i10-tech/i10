import { MAILBOX_DELETE_GRACE_DAYS, type DeleteMailbox } from "@repo/contracts"
import {
  KEEP,
  resumeMailbox,
  type DirectoryMailDeps,
  type DirectoryMailStore,
  type LoginBlock,
} from "../identity/directory-mail.js"
import type { Logger } from "../identity/ports.js"
import type { MailboxJobRow, MailboxJobStore } from "./jobs.js"
import type { MailboxAddressRemoval } from "./clerk.js"
import type { DeletionRow, MailboxLifecycleStore } from "./lifecycle-store.js"

/**
 * An owner or admin's say over a mailbox that already exists: suspend it, give it
 * back, delete it (with a way back for 30 days) and restore it. The purge that ends
 * a deletion is at the bottom, run hourly by the retention CronJob.
 *
 * ⚠ ONE GATE PER REASON, SO THAT NOTHING LIFTS A REASON IT DID NOT SET.
 *   - SUSPENDED (`suspended_at`): an owner's suspension, a leaver, a directory.
 *     The owner's resume is `resumeMailbox` and so refuses what the existing rule
 *     refuses: a person who is not a member, one a directory still says is
 *     deactivated, a domain the workspace does not host. It clears this column
 *     and no other, so a payment hold, a ban or a lock stays, and says so.
 *   - DELETING (`deleting_at`): a column of its own, read by authd ahead of its
 *     credential cache. No resume path can clear it; only `restore`, which
 *     deletes the intent row in the same transaction.
 *
 * ⚠ A DELETING MAILBOX KEEPS RECEIVING UNTIL THE PURGE, so restoring loses no
 * mail and nobody is bounced for a mailbox that may come back. The purge stops
 * delivery first of all (`close`), then destroys, then lets go of the address.
 */

export const GRACE_DAYS = MAILBOX_DELETE_GRACE_DAYS

export type SuspendResult = "suspended" | "already" | "not_found" | "deleting"

export type ResumeResult =
  | { status: "resumed"; stillBlocked: LoginBlock[] }
  | {
      status:
        | "not_found"
        | "not_suspended"
        | "deleting"
        | "not_member"
        | "directory_deactivated"
        | "domain_not_hosted"
    }

export type DeleteResult =
  | { status: "deleting"; row: DeletionRow }
  | {
      status:
        | "not_found"
        | "already"
        | "forward_invalid"
        | "forward_exists"
        | "forward_target_in_use"
        /** `export_then_delete` on a deployment that cannot export. */
        | "export_unavailable"
        /** The export could not be queued; the deletion was undone. */
        | "export_failed"
    }

export type RestoreOutcome = "restored" | "not_found" | "not_deleting" | "window_closed"

export type RetryExportOutcome =
  | "started"
  | "not_found"
  | "not_deleting"
  /** The deletion chose another outcome, so nothing waits for an export. */
  | "not_waiting_for_export"
  | "export_unavailable"
  | "export_failed"

/** What the console's routes use. */
export interface MailboxAdminLifecycle {
  /** An owner or admin of the workspace. */
  isAdmin(tenantId: string, userId: string): Promise<boolean>
  suspend(input: {
    tenantId: string
    address: string
    actorId: string
  }): Promise<SuspendResult>
  resume(input: {
    tenantId: string
    address: string
    actorId: string
  }): Promise<ResumeResult>
  remove(input: {
    tenantId: string
    address: string
    actorId: string
    request: DeleteMailbox
  }): Promise<DeleteResult>
  restore(input: {
    tenantId: string
    address: string
    actorId: string
  }): Promise<RestoreOutcome>
  /** Starts the export a deleting mailbox is waiting for again (admin; a failed one never counts). */
  retryExport(input: {
    tenantId: string
    address: string
    actorId: string
  }): Promise<RetryExportOutcome>
}

export interface MailboxLifecycleDeps {
  store: MailboxLifecycleStore
  /** `directoryMailStore`: the suspension's row, its audit event, in one transaction. */
  mail: Pick<DirectoryMailStore, "suspend">
  /** What `resumeMailbox` reads: membership, the directory, the hosted domain. */
  resume: DirectoryMailDeps
  isAdmin(tenantId: string, userId: string): Promise<boolean>
  /** Starts the export `export_then_delete` waits for. Null where nothing can export. */
  startExport:
    | ((input: {
        tenantId: string
        address: string
        requestedBy: string
      }) => Promise<unknown>)
    | null
  log: Logger
  now?: () => Date
}

export function mailboxAdminLifecycle(d: MailboxLifecycleDeps): MailboxAdminLifecycle {
  const now = () => (d.now ?? (() => new Date()))()

  return {
    isAdmin: (tenantId, userId) => d.isAdmin(tenantId, userId),

    async suspend({ tenantId, address, actorId }) {
      const ref = await d.store.find(tenantId, address)
      if (!ref) return "not_found"
      if (ref.deleting) return "deleting"
      // ⚠ KEEP, NOT THE LEAVER POLICY. `suspendMailbox` applies the workspace's
      // default for leavers (forward to a manager, delete after N days); an owner who
      // suspends one mailbox asked for the login to stop and for nothing else.
      // Devices are held (`endDevices: false`) so resume restores them.
      const done = await d.mail.suspend(
        tenantId,
        ref.clerkUserId,
        KEEP,
        now(),
        {
          type: "mailbox.suspended",
          actorUserId: actorId,
          subjectUserId: ref.clerkUserId,
          reason: "owner",
          data: { next: KEEP.next },
        },
        { endDevices: false },
      )
      return done === "no_mailbox" ? "not_found" : done
    },

    async resume({ tenantId, address, actorId }) {
      const ref = await d.store.find(tenantId, address)
      if (!ref) return { status: "not_found" }
      // ⚠ A DELETION IS NOT A SUSPENSION, and resuming must not look like it undid
      // one: the person would think they were back while authd still refused them.
      if (ref.deleting) return { status: "deleting" }
      const done = await resumeMailbox(d.resume, {
        tenantId,
        clerkUserId: ref.clerkUserId,
        actorUserId: actorId,
      })
      return done.outcome === "resumed"
        ? { status: "resumed", stillBlocked: done.stillBlocked }
        : { status: done.outcome }
    },

    async remove({ tenantId, address, actorId, request }) {
      const ref = await d.store.find(tenantId, address)
      if (!ref) return { status: "not_found" }
      if (ref.deleting) return { status: "already" }
      if (request.outcome === "export_then_delete" && !d.startExport)
        return { status: "export_unavailable" }

      let forward: { userId: string; address: string } | undefined
      if (request.outcome === "forward") {
        const target = request.forward_to
          ? await d.store.find(tenantId, request.forward_to)
          : null
        if (!target) return { status: "forward_invalid" }
        forward = { userId: target.clerkUserId, address: target.address }
      }

      const begun = await d.store.begin({
        tenantId,
        clerkUserId: ref.clerkUserId,
        outcome: request.outcome,
        forward,
        requestedBy: actorId,
        at: now(),
        graceDays: GRACE_DAYS,
      })
      if (begun.status !== "deleting")
        return begun.status === "gone"
          ? { status: "not_found" }
          : { status: begun.status }

      // ⚠ THE EXPORT IS STARTED AFTER SIGN-IN HAS STOPPED, NOT BEFORE: the purge
      // accepts only an export begun at or after `deleting_at`, and an export that
      // had to be queued first would be one the deletion could not count. If it
      // cannot be queued the deletion is undone, so a mailbox is never left waiting
      // for an export nobody asked for.
      if (request.outcome === "export_then_delete") {
        try {
          await d.startExport!({ tenantId, address: ref.address, requestedBy: actorId })
        } catch (error) {
          d.log.error(
            { tenantId, err: error instanceof Error ? error.name : "error" },
            "could not start the export of a mailbox being deleted; undoing the deletion",
          )
          await d.store.restore(tenantId, ref.clerkUserId, actorId, now())
          return { status: "export_failed" }
        }
      }
      return { status: "deleting", row: begun.row }
    },

    async restore({ tenantId, address, actorId }) {
      const ref = await d.store.find(tenantId, address)
      if (!ref) return "not_found"
      return d.store.restore(tenantId, ref.clerkUserId, actorId, now())
    },

    async retryExport({ tenantId, address, actorId }) {
      if (!d.startExport) return "export_unavailable"
      const ref = await d.store.find(tenantId, address)
      if (!ref) return "not_found"
      if (!ref.deleting) return "not_deleting"
      const row = await d.store.deletion(tenantId, ref.clerkUserId)
      if (!row) return "not_deleting"
      if (row.outcome !== "export_then_delete") return "not_waiting_for_export"
      // ⚠ THE SAME START AS THE DELETION'S OWN (`startMailboxExport`): a running one
      // is returned rather than doubled, and a new one is begun after `deleting_at`,
      // so it is the one the purge's rule (`exportWait`) will count.
      try {
        await d.startExport({ tenantId, address: ref.address, requestedBy: actorId })
      } catch (error) {
        d.log.error(
          { tenantId, err: error instanceof Error ? error.name : "error" },
          "could not start the export of a mailbox being deleted",
        )
        return "export_failed"
      }
      return "started"
    },
  }
}

// ── The purge ───────────────────────────────────────────────────────────────

/** Stalwart's side of a purge: the account, with its mail and blobs. */
export interface MailboxAccounts {
  /** Destroys the person's account. `false` when the server has none. */
  destroy(address: string): Promise<boolean>
}

export interface PurgeDeps {
  store: MailboxLifecycleStore
  accounts: MailboxAccounts
  clerk: MailboxAddressRemoval
  exports: { latest: MailboxJobStore["latest"] }
  log: Logger
  now?: () => Date
}

export type PurgeOutcome =
  | "purged"
  /** Restored, or already purged: no deletion row. */
  | "gone"
  | "not_due"
  /** `export_then_delete`: the export has not finished, or its download has not run its course. */
  | "waiting_export"

/** One more destroy than the account is ever seen twice, so a re-created one is caught. */
const DESTROY_ATTEMPTS = 3

/**
 * Why a deleting mailbox is still waiting for its export, or null when it is not.
 *
 *   - `export_pending`: one is queued or running (or finished with no end date yet).
 *   - `export_failed`: the latest one, begun after the deletion, failed.
 *   - `export_missing`: none was begun after the deletion (the one the deletion
 *     queued was lost, or an older one was reused); an admin starts one.
 *   - `export_ready_after`: it finished, and its download has not yet been on offer
 *     for as long as an export ever is; `readyAfter` is when it has.
 *
 * ⚠ THE LATEST EXPORT OF THE MAILBOX, BEGUN AT OR AFTER THE DELETION, FINISHED, AND
 * PAST ITS OWN RETENTION (`expires_at`, set to `EXPORT_KEEP_MS` after it finished).
 * Past, not merely finished: "available for download" has to have been true for as
 * long as an export ever is, so an admin who is away for the first week is not
 * handed a purge before the archive was ever offered for long enough. With 30 days
 * of grace this costs nothing in the usual case (the export ends in minutes and
 * expires on day 7) and waits for as long as it needs when the export was late,
 * failed, or was re-run. A failed one never counts: the mail would be gone with no
 * copy. THE EXPORT IS A SNAPSHOT: mail delivered after it began is not in it, and
 * an admin who wants those messages runs another export before the date (the
 * latest one counts).
 *
 * ⚠ ONE FUNCTION FOR THE PURGE AND THE CONSOLE, so the banner can never say "ready"
 * about a mailbox the purge is still holding, or the other way round.
 */
export type ExportWait =
  | { reason: "export_pending" | "export_failed" | "export_missing" }
  | { reason: "export_ready_after"; readyAfter: Date }

export function exportWait(
  job: Pick<MailboxJobRow, "status" | "createdAt" | "expiresAt"> | null,
  row: Pick<DeletionRow, "deletingAt">,
  at: Date,
): ExportWait | null {
  if (job && (job.status === "pending" || job.status === "running"))
    return { reason: "export_pending" }
  if (!job || job.createdAt.getTime() < row.deletingAt.getTime())
    return { reason: "export_missing" }
  if (job.status === "failed") return { reason: "export_failed" }
  if (job.status !== "completed" || job.expiresAt === null)
    return { reason: "export_pending" }
  return at.getTime() >= job.expiresAt.getTime()
    ? null
    : { reason: "export_ready_after", readyAfter: job.expiresAt }
}

async function destroyUntilGone(accounts: MailboxAccounts, address: string) {
  for (let attempt = 0; attempt < DESTROY_ATTEMPTS; attempt++) {
    // `false` is the registry saying it has none: the only answer that ends this.
    if (!(await accounts.destroy(address))) return
  }
  throw new Error("stalwart still holds an account for a mailbox that was destroyed")
}

/**
 * Takes one deleting mailbox apart, if it is due. Safe to run again after a crash
 * at any point: every step does nothing when it is already done, and the intent
 * (`core.mailbox_deletions`) is the last thing to go.
 *
 * ⚠ THE ORDER IS THE POINT, AND EACH STEP IS WHY THE NEXT IS SAFE:
 *   1. CLOSE: `active = false`. From the next delivery the address is refused
 *      (550) instead of being re-created as an empty Stalwart account once the real
 *      one is gone. A forward's list still answers, so its mail keeps arriving.
 *   2. DESTROY the Stalwart account (mail, blobs), repeated until the registry
 *      says there is none, so a delivery that slipped in is caught.
 *   3. REMOVE the address from the person's Clerk user, so a webhook cannot
 *      re-derive the mailbox and the address is not theirs to sign in with.
 *   4. DESTROY again: Clerk's event and step 2 can race with a late delivery.
 *   5. THE ROWS, in one transaction, the intent last. Only now is the address free
 *      to anybody else, and nothing of the old mail is left to inherit. For a
 *      `forward` the same transaction turns every alias the mailbox holds (Clerk's,
 *      a directory's, the console's) into a list `aliasListName`, `fwd-<id>-a<hash>` with the same
 *      target, so an alias is a row in `authd.aliases` or a list and never neither.
 *      From step 1 until then the aliases are refused like the primary (their
 *      account is inactive); only the primary's list answers meanwhile.
 * A crash after 1 leaves a refused address and a deleting mailbox; after 2, the
 * same with nothing to destroy; after 3, the projection may already have removed the
 * account row, which step 5 allows. At no point does the address accept mail for
 * nobody, and at no point can anyone else take it while old mail remains.
 */
export async function purgeMailbox(
  d: PurgeDeps,
  ref: { tenantId: string; clerkUserId: string },
): Promise<PurgeOutcome> {
  const at = (d.now ?? (() => new Date()))()
  const facts = await d.store.facts(ref.tenantId, ref.clerkUserId)
  if (!facts) return "gone"
  const { row } = facts
  if (at.getTime() < row.purgeAfter.getTime()) return "not_due"

  if (row.outcome === "export_then_delete") {
    const job = await d.exports.latest(ref.tenantId, row.address, "export")
    const wait = exportWait(job, row, at)
    if (wait) {
      // ⚠ A FAILED OR MISSING EXPORT NEVER RESOLVES ON ITS OWN, and this runs every
      // hour: said once a day per mailbox (`claimExportAlert`) at error level, which
      // Sentry picks up. Tenant id only; the address is the customer's.
      if (
        (wait.reason === "export_failed" || wait.reason === "export_missing") &&
        (await d.store.claimExportAlert(ref.tenantId, ref.clerkUserId, at))
      )
        d.log.error(
          { tenantId: ref.tenantId, reason: wait.reason },
          "a mailbox is past its deletion date and cannot be purged: its export did not finish",
        )
      return "waiting_export"
    }
  }

  const closed = await d.store.close(ref.tenantId, ref.clerkUserId, at)
  if (closed !== "closed") return closed

  const address = facts.account?.address ?? row.address
  await destroyUntilGone(d.accounts, address)
  const { kept } = await d.clerk.remove(ref.clerkUserId, facts.clerkAddresses)
  await destroyUntilGone(d.accounts, address)

  const done = await d.store.finish(ref.tenantId, ref.clerkUserId, { clerkKept: kept })
  if (done === "gone") return "gone"
  if (kept.length > 0)
    d.log.warn(
      { tenantId: ref.tenantId },
      "a purged mailbox's address is the person's only sign-in address and stays on their account",
    )
  return "purged"
}

export interface PurgeCounts {
  purged: number
  notDue: number
  waiting: number
  gone: number
  failed: number
}

const PAGE = 100

/**
 * Every deleting mailbox of every workspace, one at a time. One failing mailbox
 * (Clerk down, Stalwart refusing) must not stop the rest; the next run tries it
 * again, from wherever it stopped.
 */
export async function purgeDueMailboxes(d: PurgeDeps): Promise<PurgeCounts> {
  const counts: PurgeCounts = { purged: 0, notDue: 0, waiting: 0, gone: 0, failed: 0 }
  for (let after: string | null = null; ;) {
    const page = await d.store.deleting(after, PAGE)
    for (const item of page) {
      try {
        const outcome = await purgeMailbox(d, item)
        if (outcome === "purged") counts.purged++
        else if (outcome === "not_due") counts.notDue++
        else if (outcome === "waiting_export") counts.waiting++
        else counts.gone++
      } catch (error) {
        counts.failed++
        d.log.error(
          { err: error, tenantId: item.tenantId },
          "could not purge a deleted mailbox",
        )
      }
    }
    if (page.length < PAGE) return counts
    after = page.at(-1)!.clerkUserId
  }
}
