import { formatBytes } from "@/lib/format"

/**
 * What the Mailboxes list and a mailbox's own page both say about a mailbox:
 * the shape the API sends, the words for its status, and what each action on it
 * can be refused for.
 *
 * ⚠ MIRRORED, NOT IMPORTED, for the reason `CreatedMailbox` in lib/actions.ts
 * gives: the console never depends on `@repo/contracts`, whose schemas would put
 * zod in the browser bundle. The source is `ConsoleMailbox` in
 * apps/api/src/mailboxes/console.ts; the one value copied by hand is
 * `MAILBOX_DELETE_GRACE_DAYS`, below.
 */

/** How long a deleted mailbox can be restored. `MAILBOX_DELETE_GRACE_DAYS` in @repo/contracts. */
export const DELETE_GRACE_DAYS = 30

export interface ConsoleMailboxStorage {
  allocatedBytes: number | null
  usedBytes: number | null
  usedAt: string | null
}

export type DeletionOutcome = "delete" | "export_then_delete" | "forward"

/** A mailbox in its deletion grace: what was chosen and when it ends. */
export interface ConsoleMailboxDeletion {
  outcome: DeletionOutcome
  deletedAt: string
  /** The last moment it can be restored. An export can push the purge past it. */
  purgeAt: string
  /** Forward only: where the address's mail goes afterwards. */
  forwardTo: string | null
  /**
   * `export_then_delete` only: why the purge is held back, or null when it is not.
   * `readyAfter` is set for `export_ready_after`.
   */
  exportWait: {
    reason: "export_pending" | "export_failed" | "export_missing" | "export_ready_after"
    readyAfter: string | null
  } | null
}

export interface ConsoleMailbox {
  address: string
  displayName: string | null
  owner: { userId?: string | null; name: string | null; email: string | null }
  domain: string
  status: string
  /** Present exactly while `status` is `deleting`. */
  deletion: ConsoleMailboxDeletion | null
  signIn: "password" | "oidc" | "ldap" | "off"
  storage: ConsoleMailboxStorage
  createdAt: string
}

export interface StoragePool {
  kind: "pool" | "uncapped"
  total: number | null
  allocated: number
  used: number
  remaining: number | null
  unallocated: number
}

type Tone = "success" | "warning" | "danger" | "neutral"

const STATUS_WORDS: Record<string, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  inactive: { label: "Not set up yet", tone: "warning" },
  suspended: { label: "Suspended", tone: "danger" },
  payment_hold: { label: "Payment needed", tone: "warning" },
  domain_off: { label: "Domain not hosting", tone: "warning" },
  banned: { label: "Blocked", tone: "danger" },
  locked: { label: "Blocked", tone: "danger" },
  sso_required: { label: "Mail sign-in off", tone: "warning" },
  deleting: { label: "Deleting", tone: "danger" },
}

export function statusInfo(status: string): { label: string; tone: Tone } {
  return STATUS_WORDS[status] ?? { label: status, tone: "neutral" }
}

/**
 * Why a mailbox cannot be used right now, for the statuses that mean so. `null`
 * for an active mailbox, and for a deleting one, whose banner says its own story.
 *
 * ⚠ SAID ON THE PAGE, NOT ONLY IN THE BADGE. "Payment needed" or "Blocked" tells
 * an admin THAT somebody cannot sign in, and the next question is always what
 * to do about it; the answer differs per status, and for a ban or a lock it is
 * "nothing from here", which is worth saying rather than leaving them to look
 * for a button.
 */
export function statusNote(status: string, domain: string): string | null {
  switch (status) {
    case "suspended":
      return "Sign-in is paused. Mail keeps arriving and nothing is deleted. Resume the mailbox to let the person sign in again."
    case "payment_hold":
      return "Sign-in is off because the workspace's plan needs payment. It works again once the plan is paid."
    case "domain_off":
      return `Mailbox hosting is off for ${domain}, so this mailbox cannot be used. Turn it back on from the domain's page.`
    case "banned":
      return "This person's account is blocked, so they cannot sign in to the mailbox. That cannot be lifted from here."
    case "locked":
      return "This person's account is locked, so they cannot sign in right now. That cannot be lifted from here."
    case "sso_required":
      return "Mail sign-in is not turned on for this person's single sign-on connection, so they cannot sign in to the mailbox. Turn it on in the connection's settings."
    case "inactive":
      return "This mailbox is not set up yet, so nobody can sign in to it."
    default:
      return null
  }
}

/** What a mailbox's storage line says; unmeasured and unallocated are not zero and not unlimited. */
export function storageLine(storage: ConsoleMailboxStorage): string {
  if (storage.usedBytes == null) return "Not measured yet"
  const of =
    storage.allocatedBytes == null
      ? "the default quota"
      : formatBytes(storage.allocatedBytes)
  return `${formatBytes(storage.usedBytes)} of ${of}`
}

/**
 * The unit a storage bar counts in, so a 5 GB mailbox reads "1.2 of 5 GB" and a
 * 500 MB one "120.0 of 500 MB", not a ten digit number of bytes.
 */
export function meterScale(limitBytes: number): { divisor: number; unit: string } {
  if (limitBytes >= 1024 ** 4) return { divisor: 1024 ** 4, unit: "TB" }
  if (limitBytes >= 1024 ** 3) return { divisor: 1024 ** 3, unit: "GB" }
  return { divisor: 1024 ** 2, unit: "MB" }
}

export function signInLabel(lane: ConsoleMailbox["signIn"]): string {
  if (lane === "off") return "Off"
  if (lane === "password") return "Password"
  if (lane === "oidc") return "Provider password"
  if (lane === "ldap") return "Directory password"
  return lane
}

/**
 * Whether a deleted mailbox can still be brought back.
 *
 * ⚠ ONLY A HINT FOR WHICH BUTTON TO SHOW. The API decides (`restore_window_closed`)
 * and an export can hold the purge back after this moment, so a closed window
 * here means "do not offer it", never "it is gone".
 */
export function canRestore(deletion: ConsoleMailboxDeletion, now: Date): boolean {
  return now.getTime() < Date.parse(deletion.purgeAt)
}

/**
 * Which actions an owner or admin is offered on a mailbox, in the order the page
 * and the row menu list them.
 *
 * ⚠ A DELETING MAILBOX OFFERS ONLY RESTORE, and nothing once the window is over:
 * the API refuses every other change to it (`mailbox_deleting`), so the buttons
 * would be a way to read a refusal. A suspended one offers resume where an
 * active one offers suspend.
 *
 * ⚠ ONE EXCEPTION: A FAILED OR MISSING EXPORT OFFERS TO START IT AGAIN, and keeps
 * offering it after the window, because that is when it is the only way out: a
 * mailbox that can no longer be restored and cannot be erased without its copy.
 */
export function availableActions(
  mailbox: Pick<ConsoleMailbox, "status" | "deletion">,
  now: Date,
): MailboxAction[] {
  if (mailbox.status === "deleting") {
    const { deletion } = mailbox
    const actions: MailboxAction[] = []
    if (deletion && canRestore(deletion, now)) actions.push("restore")
    const reason = deletion?.exportWait?.reason
    if (reason === "export_failed" || reason === "export_missing")
      actions.push("retry_export")
    return actions
  }
  return mailbox.status === "suspended"
    ? ["storage", "resume", "delete"]
    : ["storage", "suspend", "delete"]
}

/**
 * The mailboxes a deleted one can forward to: another one that is live, so the
 * mail lands somewhere a person reads it.
 *
 * ⚠ ONLY `active`. The API's rule is "can sign in and receive mail", and the
 * status is that rule's answer: a suspended, held or deleting mailbox is
 * refused there, so offering it would be a choice that always fails.
 */
export function forwardTargets(
  mailboxes: readonly ConsoleMailbox[],
  address: string,
): ConsoleMailbox[] {
  return mailboxes.filter((m) => m.status === "active" && m.address !== address)
}

/** A refusal as the console receives it from a server action. */
export interface ActionRefusal {
  error: string
  name: string
  status: number
  body?: Record<string, unknown>
}

export type MailboxAction =
  "storage" | "suspend" | "resume" | "delete" | "restore" | "retry_export"

const DOING: Record<MailboxAction, string> = {
  storage: "change the storage",
  suspend: "suspend the mailbox",
  resume: "resume the mailbox",
  delete: "delete the mailbox",
  restore: "restore the mailbox",
  retry_export: "start the export",
}

/**
 * What a deletion that waits for its export says about the wait, or null when it
 * is not waiting. `date` is set where the sentence ends in one.
 *
 * ⚠ THE NEXT STEP IS NAMED, AND "RESTORE" ONLY WHILE IT IS STILL OFFERED: after the
 * window the one way out is another export, and saying "or restore it" there would
 * point at a button that is not on the page. (Choosing another outcome instead is
 * not offered: the API fixes the outcome when the deletion begins.)
 */
export function exportWaitWords(
  wait: ConsoleMailboxDeletion["exportWait"],
  who: { restorable: boolean; isAdmin: boolean },
): { text: string; date: string | null } | null {
  if (!wait) return null
  const or = who.restorable ? ", or restore the mailbox" : ""
  // A member has neither button: they are told whom to ask.
  const again = who.isAdmin
    ? `Start the export again${or}`
    : "Ask an owner or admin to start the export again"
  const first = who.isAdmin
    ? `Start the export${or}`
    : "Ask an owner or admin to start the export"
  switch (wait.reason) {
    case "export_pending":
      return {
        text: "The export is still running. The mailbox is erased once it has finished and its download window has passed.",
        date: null,
      }
    case "export_failed":
      return {
        text: `The export failed, so the mailbox is not erased yet. ${again}.`,
        date: null,
      }
    case "export_missing":
      return {
        text: `There is no export of this mailbox, so it is not erased yet. ${first}.`,
        date: null,
      }
    case "export_ready_after":
      return {
        text: "The export is ready to download. The mailbox is erased after its download window ends on",
        date: wait.readyAfter,
      }
  }
}

/** The heading of the alert a refused action puts in its dialog. */
export function refusalTitle(action: MailboxAction): string {
  return `Could not ${DOING[action]}`
}

const BYTES_PER_GB = 1024 ** 3

/** A stored allocation as the gigabytes field shows it, at most two decimals; empty for none. */
export function gigabytesText(bytes: number | null): string {
  if (bytes === null) return ""
  return String(Math.round((bytes / BYTES_PER_GB) * 100) / 100)
}

/** One sentence ends in exactly one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * A refusal in words for an admin who has never seen an HTTP status.
 *
 * ⚠ KEYED ON `name` FIRST. The API's own sentence is kept wherever it already
 * says what to do (the resume and restore ones were written for this person);
 * what is replaced is every sentence that names a request field or a byte
 * count, and the two delete refusals that arrive as a bare 501 and 503.
 */
export function mailboxActionRefusal(
  failure: ActionRefusal,
  action: MailboxAction,
  format: (bytes: number) => string = formatBytes,
): string {
  switch (failure.name) {
    case "already_deleting":
    case "mailbox_deleting":
      return "This mailbox is already being deleted. Restore it first if you want to change it."
    case "forward_exists":
    case "not_waiting_for_export":
    case "not_deleting":
    case "restore_window_closed":
    case "not_suspended":
    case "not_member":
    case "directory_deactivated":
    case "domain_not_hosted":
      return sentence(failure.error)
    case "deleting":
      return "This mailbox is being deleted. Restore it instead."
    case "forward_target_in_use":
      return "Other addresses forward their mail to this mailbox, so it cannot be deleted yet. Move those addresses to another mailbox first."
    case "plan_limit_exceeded": {
      const remaining = failure.body?.remaining
      const total = failure.body?.total
      if (typeof remaining === "number" && typeof total === "number") {
        return `That is more than is left in your storage pool: ${format(remaining)} of ${format(total)}. Give this mailbox less, or free some up from another mailbox first.`
      }
      return `${sentence(failure.error)} Upgrade your plan or free some storage first.`
    }
    case "validation_error":
      return action === "delete"
        ? "Pick another mailbox in this workspace that can sign in and receive mail."
        : sentence(failure.error)
    case "forbidden":
      return "Only an owner or admin can change or delete a mailbox."
    case "invalid_access":
      return failure.status === 401
        ? "Your session ended. Sign in again, then try again."
        : sentence(failure.error)
    case "not_found":
      return "This mailbox no longer exists in this workspace."
    default:
      break
  }

  if (action === "delete" && failure.status === 501) {
    return "Exporting mail is not available yet, so nothing was deleted. Choose another option."
  }
  if (action === "delete" && failure.status === 503) {
    return "The export could not be started, so nothing was deleted. Try again in a minute."
  }
  if (failure.status === 401)
    return "Your session ended. Sign in again, then try again."
  if (failure.status === 429) {
    return "You are doing that too fast. Wait a moment, then try again."
  }
  if (failure.status >= 500) {
    return `We could not ${DOING[action]} because of a problem on our side. Try again in a minute.`
  }
  return failure.error.trim()
    ? sentence(failure.error)
    : `We could not ${DOING[action]}. Try again.`
}
