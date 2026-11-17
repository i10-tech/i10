import { formatBytes } from "@/lib/format"
import type { ActionRefusal } from "@/lib/mailbox-view"

/**
 * Moving a mailbox's mail out and in (U7): what the API answers, what an archive
 * must look like before it is sent, and every decision the screen makes from a
 * job, kept apart from the components so each can be tested alone.
 *
 * The routes are apps/api/src/routes/mailbox-migration.ts; the wording below is
 * for an admin who has never heard of a presigned URL.
 */

export type JobStatus =
  "awaiting_upload" | "pending" | "running" | "completed" | "failed"

/** `MailboxJob` of @repo/contracts, which the console does not depend on. */
export interface MailboxJob {
  object: "mailbox_job"
  id: string
  mailbox_address: string
  type: "export" | "import"
  status: JobStatus
  progress: {
    total_messages: number
    processed_messages: number
    total_folders: number
    processed_folders: number
  }
  download_url?: string | null
  upload?: { url: string; method: "PUT"; expires_at: string } | null
  error?: string | null
  error_code?: string | null
  created_at: string
  completed_at?: string | null
}

/**
 * What the mailbox page read on the server, so a run that is already going (or
 * finished) is there when the page opens, and an import can be seen again after
 * the person left the page.
 *
 * ⚠ THREE ANSWERS THAT ARE NOT "NO JOB": `forbidden` hides the section (the API
 * says this person may not move this mailbox's mail), `unavailable` says the
 * deployment has no storage for it, `unreadable` keeps the buttons and says the
 * status could not be read.
 */
export type TransferSnapshot =
  | { state: "ok"; export: MailboxJob | null; import: MailboxJob | null }
  | { state: "forbidden" }
  | { state: "unavailable" }
  | { state: "unreadable" }

/** One status read as the page makes it (`tryApi`). A 404 is "never run", not a failure. */
export type JobRead =
  { ok: true; data: MailboxJob } | { ok: false; error: { statusCode: number } }

/** The two status reads, as what the section needs to know. */
export function transferSnapshot(
  exported: JobRead,
  imported: JobRead,
): TransferSnapshot {
  const reads = [exported, imported]
  const failed = (status: number) =>
    reads.some((read) => !read.ok && read.error.statusCode === status)
  if (failed(403)) return { state: "forbidden" }
  if (failed(501)) return { state: "unavailable" }
  if (reads.some((read) => !read.ok && read.error.statusCode !== 404)) {
    return { state: "unreadable" }
  }
  return {
    state: "ok",
    export: exported.ok ? exported.data : null,
    import: imported.ok ? imported.data : null,
  }
}

/**
 * ⚠ THESE THREE MIRROR THE API AND CANNOT BE IMPORTED: `LIMITS.maxArchiveBytes`
 * (apps/api/src/mailboxes/archive.ts) and `EXPORT_KEEP_MS`
 * (apps/api/src/mailboxes/migration.ts). The API enforces them; these only say
 * so before a gigabyte is sent. The job carries no expiry, so a finished export's
 * "available until" is its completion plus the retention.
 */
export const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3
export const MAX_MESSAGE_MB = 50
export const EXPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** A reserved upload link with less than this left is not worth sending a file to. */
const UPLOAD_MIN_LEFT_MS = 60_000

const nf = new Intl.NumberFormat("en-US")
const count = (n: number, one: string, many = `${one}s`) =>
  `${nf.format(n)} ${n === 1 ? one : many}`

/** One sentence ends in exactly one full stop. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

// ── Archive checks, before anything is sent ─────────────────────────────────

export type ArchiveKind = "zip" | "gzip" | "tar" | "mbox"

/**
 * What the first 512 bytes say the file is: the same test the API's reader makes
 * (`openEntries`, apps/api/src/mailboxes/archive.ts), so a file refused here is
 * one the import would fail on after hours of upload.
 */
export function sniffArchive(head: Uint8Array): ArchiveKind | null {
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)
    return "zip"
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip"
  if (
    head.byteLength >= 512 &&
    new TextDecoder().decode(head.subarray(257, 262)) === "ustar"
  )
    return "tar"
  if (new TextDecoder().decode(head.subarray(0, 5)) === "From ") return "mbox"
  return null
}

/** What a file with this name is, for the cases people actually try. */
function wrongKindWords(name: string): string {
  const lower = name.toLowerCase()
  if (/\.(pst|ost)$/.test(lower)) {
    return "That is an Outlook data file, which we cannot read. Convert it to mbox or .eml files first, then import the result."
  }
  if (/\.(eml|emlx|msg)$/.test(lower)) {
    return "That is a single message, not an archive. Put the .eml files in a zip and import the zip."
  }
  if (/\.(rar|7z)$/.test(lower)) {
    return "We cannot open that kind of archive. Save the mail as a zip instead."
  }
  return "That does not look like a zip, tar, tar.gz or mbox file. Choose the file your old mail app made."
}

/**
 * Why a file cannot be imported, or null when it can be tried.
 *
 * ⚠ THE CONTENT DECIDES, NOT THE NAME. Thunderbird's own folder files have no
 * extension and are valid mbox files, so an extension allow-list would refuse
 * them; the name only chooses the sentence for the file that is refused.
 */
export function archiveProblem(
  file: { name: string; size: number },
  head: Uint8Array,
): string | null {
  if (file.size === 0) return "That file is empty."
  if (file.size > MAX_ARCHIVE_BYTES) {
    return `That file is ${formatBytes(file.size)}. The most one import takes is ${formatBytes(MAX_ARCHIVE_BYTES)}. Split it into parts and import them one at a time.`
  }
  return sniffArchive(head) === null ? wrongKindWords(file.name) : null
}

// ── The import steps, and what survives a failed one ────────────────────────

export interface Reservation {
  job: MailboxJob
  /** The bytes reached storage: only the start is left. */
  uploaded: boolean
}

export type ImportStep = "reserve" | "upload" | "start"

/**
 * Where a retry picks up, so it repeats as little as the API allows.
 *
 * ⚠ A FAILED JOB CANNOT BE STARTED AGAIN (`start` answers 409 for it), so there
 * is no "reuse" after the API has failed one. What can be reused is a reservation
 * whose link is still good (send the file again, no second step-up) and one whose
 * file already arrived (only the start is left). Anything else reserves anew.
 */
export function nextImportStep(
  reservation: Reservation | undefined,
  nowMs: number,
): ImportStep {
  if (!reservation) return "reserve"
  if (reservation.uploaded) return "start"
  const expires = reservation.job.upload
    ? Date.parse(reservation.job.upload.expires_at)
    : Number.NaN
  return expires - nowMs > UPLOAD_MIN_LEFT_MS ? "upload" : "reserve"
}

export type UploadFailure = "network" | "refused" | "aborted"

/** A failed send, in words. `status` is storage's answer for `refused`. */
export function uploadFailureWords(kind: UploadFailure, status: number): string {
  if (kind === "aborted") return "The upload was cancelled."
  if (kind === "network") {
    return "The connection dropped before the whole file was sent. Retry to send it again."
  }
  if (status === 403) {
    return "The upload link has expired. Retry and we will make a new one."
  }
  return "Storage did not accept the file. Retry, and if it keeps failing, choose the file again."
}

/** The browser's side of an import, from reserving to the API's answer to "start". */
export type ImportFlow =
  | { phase: "idle" }
  | { phase: "reserving" }
  | { phase: "uploading"; name: string; sent: number; total: number }
  | { phase: "starting" }
  | { phase: "failed"; step: ImportStep; message: string }

export const isBusy = (flow: ImportFlow): boolean =>
  flow.phase === "reserving" || flow.phase === "uploading" || flow.phase === "starting"

/** Whole percent of the file sent, never 100 until the last byte has gone. */
export function uploadPercent(sent: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.floor((sent / total) * 100)))
}

/** "1.2 GB of 3.4 GB". */
export function uploadLine(sent: number, total: number): string {
  return `${formatBytes(Math.min(sent, total))} of ${formatBytes(total)}`
}

/** The heading over a failed step's sentence. */
export function flowFailureTitle(step: ImportStep): string {
  switch (step) {
    case "reserve":
      return transferRefusalTitle("reserve")
    case "upload":
      return "The upload did not finish"
    case "start":
      return transferRefusalTitle("start")
  }
}

// ── What a job looks like on the page ───────────────────────────────────────

export const isActive = (job: MailboxJob | null): boolean =>
  job !== null && (job.status === "pending" || job.status === "running")

export function progressPercent(job: MailboxJob): number | null {
  const { total_messages: total, processed_messages: done } = job.progress
  if (total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

/** "1,200 of 5,000 messages", or the count so far where the total is not known. */
export function countLine(job: MailboxJob): string {
  const { total_messages: total, processed_messages: done } = job.progress
  if (total > 0) return `${nf.format(done)} of ${count(total, "message")}`
  if (done > 0) return `${count(done, "message")} so far`
  return "Starting"
}

export type ExportView =
  | { kind: "none" }
  | { kind: "running"; percent: number | null; line: string }
  | { kind: "ready"; expiresAt: string | null }
  | { kind: "expired" }
  | { kind: "failed"; message: string }

/** When a finished export stops being downloadable. */
export function exportExpiresAt(job: MailboxJob): string | null {
  if (!job.completed_at) return null
  const done = Date.parse(job.completed_at)
  return Number.isNaN(done) ? null : new Date(done + EXPORT_KEEP_MS).toISOString()
}

export function exportFailureWords(code: string | null | undefined): string {
  return code === "stalwart"
    ? "The mail server could not finish the export. Try again in a few minutes."
    : "The export did not finish. Try again."
}

export function exportView(job: MailboxJob | null): ExportView {
  if (!job) return { kind: "none" }
  switch (job.status) {
    case "pending":
    case "running":
      return { kind: "running", percent: progressPercent(job), line: countLine(job) }
    case "completed":
      // ⚠ NO LINK ON A FINISHED EXPORT MEANS ITS WINDOW IS OVER: the API mints one
      // on every read while the file is still kept.
      return job.download_url
        ? { kind: "ready", expiresAt: exportExpiresAt(job) }
        : { kind: "expired" }
    case "failed":
      return { kind: "failed", message: exportFailureWords(job.error_code) }
    case "awaiting_upload":
      return { kind: "none" }
  }
}

export type ImportView =
  | { kind: "none" }
  | { kind: "unfinished" }
  | { kind: "running"; percent: number | null; line: string; folders: string | null }
  | { kind: "done"; headline: string; note: string | null }
  | { kind: "failed"; title: string; advice: string; detail: string | null }

/**
 * ⚠ NOT "NOT ADDED TWICE": nothing in the API de-duplicates (migration.ts hands
 * every message to `Email/import`), so the honest sentence is the warning.
 */
const REIMPORT_NOTE =
  "Messages that were already imported stay in the mailbox, and importing the same file again can add them a second time."

/** A failed import's title and what to do, by the code the worker set. */
export function importFailureWords(job: MailboxJob): {
  title: string
  advice: string
  detail: string | null
} {
  const done = job.progress.processed_messages
  const before =
    done > 0 ? `${count(done, "message")} were imported before it stopped. ` : ""
  const detail = job.error?.trim() || null

  switch (job.error_code) {
    case "archive_invalid":
      return {
        title: "We could not read that file",
        advice:
          "It is not a zip, tar, tar.gz or mbox file, or it is damaged. Check that you chose the file your old mail app made, then choose it again.",
        detail: null,
      }
    case "archive_too_large":
      return {
        title: "That file is too big",
        advice: `One import takes up to ${formatBytes(MAX_ARCHIVE_BYTES)}, and the archive may not unpack to far more than that. Split it into parts and import them one at a time.`,
        detail: null,
      }
    case "archive_incomplete":
      return {
        title: "The file ended too early",
        advice:
          "The upload may have been cut short, or the file is damaged. Choose the file again.",
        detail,
      }
    case "message_too_large":
      return {
        title: "A message is too large",
        advice: `${before}The mail server takes messages up to ${MAX_MESSAGE_MB} MB. Take the large message out of the archive and import it again. ${REIMPORT_NOTE}`,
        detail,
      }
    case "over_quota":
      return {
        title: "The mailbox ran out of space",
        advice: `${before}Free up space or give the mailbox more storage, then choose the file again. ${REIMPORT_NOTE}`,
        detail: null,
      }
    case "stalwart":
      return {
        title: "The mail server stopped the import",
        advice: `${before}Try again in a few minutes by choosing the file again. ${REIMPORT_NOTE}`,
        detail: null,
      }
    default:
      return {
        title: "The import did not finish",
        advice: `${before}Something went wrong on our side. Choose the file again to try once more. ${REIMPORT_NOTE}`,
        detail: null,
      }
  }
}

export function importView(job: MailboxJob | null): ImportView {
  if (!job) return { kind: "none" }
  switch (job.status) {
    case "awaiting_upload":
      return { kind: "unfinished" }
    case "pending":
    case "running": {
      const folders = job.progress.processed_folders
      return {
        kind: "running",
        percent: progressPercent(job),
        line: countLine(job),
        folders: folders > 0 ? `${count(folders, "folder")} so far` : null,
      }
    }
    case "completed": {
      const { processed_messages: messages, processed_folders: folders } = job.progress
      const into = folders > 0 ? ` into ${count(folders, "folder")}` : ""
      return {
        kind: "done",
        headline: `Imported ${count(messages, "message")}${into}.`,
        note: job.error_code === "skipped_messages" ? (job.error ?? null) : null,
      }
    }
    case "failed":
      return { kind: "failed", ...importFailureWords(job) }
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────

const POLL_MS = 3000
const POLL_MAX_MS = 30_000

/**
 * How long to wait before asking again, or null to stop until the tab is shown.
 *
 * ⚠ HIDDEN MEANS NOTHING IS ASKED, NOT ASKED SLOWLY: a tab in the background
 * for an hour of import would otherwise hold a server action open every few
 * seconds for nobody. The caller asks at once when the tab comes back.
 * ⚠ FAILURES BACK OFF, doubling to thirty seconds, so an API that is down is not
 * hammered by every open page, and the poll does not give up either: the run it
 * watches is still going.
 */
export function nextPollDelay(state: {
  visible: boolean
  failures: number
}): number | null {
  if (!state.visible) return null
  if (state.failures <= 0) return POLL_MS
  return Math.min(POLL_MAX_MS, POLL_MS * 2 ** state.failures)
}

// ── Refusals ────────────────────────────────────────────────────────────────

export type TransferStep = "export" | "reserve" | "start"

/** What a 501 means to somebody who never heard of storage buckets. */
export const UNAVAILABLE_WORDS =
  "Exporting and importing mail is not available right now. Contact support if you need it."

const DOING: Record<TransferStep, string> = {
  export: "start the export",
  reserve: "prepare the upload",
  start: "start the import",
}

export function transferRefusalTitle(step: TransferStep): string {
  return `Could not ${DOING[step]}`
}

/** A refusal in words for an admin who has never seen an HTTP status. */
export function transferRefusal(failure: ActionRefusal, step: TransferStep): string {
  // ⚠ CLERK'S HINT, NOT OUR ERROR: the session needed a fresh sign-in and the
  // step-up did not run or did not stick. Said as the thing to do, not as a code.
  if (failure.body && "clerk_error" in failure.body) {
    return "Confirm it is you, then try again."
  }
  const own = failure.error.trim() ? sentence(failure.error) : null
  const fallback = `We could not ${DOING[step]}. Try again.`
  switch (failure.status) {
    case 401:
      return "Your session ended. Sign in again, then try again."
    case 403:
      return "Only the mailbox's owner or a workspace admin can move its mail."
    case 404:
      return step === "start"
        ? "That import is no longer there. Choose the file again."
        : "This mailbox no longer exists in this workspace."
    case 409:
      return step === "start"
        ? "The file did not finish uploading. Choose it again."
        : (own ?? fallback)
    case 413:
      return `That file is over ${formatBytes(MAX_ARCHIVE_BYTES)}. Split it into parts and import them one at a time.`
    case 429:
      return "You are doing that too fast. Wait a moment, then try again."
    case 501:
      return UNAVAILABLE_WORDS
    default:
      break
  }
  if (failure.status >= 500) {
    return `We could not ${DOING[step]} because of a problem on our side. Try again in a minute.`
  }
  return own ?? fallback
}

// ── What the import dialog tells people ─────────────────────────────────────

/**
 * Where to get an archive from, one line each, only for what the import reads.
 * ⚠ OUTLOOK IS HERE AS A "NOT DIRECTLY": its .pst files are not read, and saying
 * nothing would send somebody to upload one and wait for it to fail.
 */
export const IMPORT_SOURCES: readonly { app: string; how: string }[] = [
  {
    app: "Gmail",
    how: "In Google Takeout choose only Mail, then import the .zip or .tgz it gives you.",
  },
  {
    app: "Apple Mail",
    how: "Choose Mailbox, then Export Mailbox, and import the file named mbox inside the folder it makes.",
  },
  {
    app: "Thunderbird",
    how: "Choose a folder's file from your profile's Mail folder, or export folders as .mbox with the ImportExportTools NG add-on.",
  },
  {
    app: "Outlook",
    how: "Outlook's .pst files cannot be imported. Convert them to mbox or .eml files first.",
  },
]

export const IMPORT_FORMATS = "zip, tar, tar.gz or mbox"
