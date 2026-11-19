import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import { aliasNotes, type MailboxAliasList } from "@/lib/mailbox-aliases"
import {
  exportView,
  importView,
  type ExportView,
  type ImportView,
  type TransferSnapshot,
} from "@/lib/mailbox-transfer"
import {
  availableActions,
  statusInfo,
  statusNote,
  type ConsoleMailbox,
  type StoragePool,
} from "@/lib/mailbox-view"

/** What a mailbox's page loads. */
export interface MailboxDetailData {
  mailbox: ConsoleMailbox
  /** The workspace's other mailboxes, for a deleted one to forward to. Admins only. */
  others: readonly ConsoleMailbox[]
  /** The storage pool, for the storage dialog. Admins only. */
  pool: StoragePool | null
  /** The addresses that deliver here. Null where they could not be read. */
  aliases: MailboxAliasList | null
  /** The domains the workspace hosts mailboxes on, for Add alias. Admins only. */
  domains: readonly string[]
  transfer: TransferSnapshot
  isAdmin: boolean
  /** From the server, so the render and its hydration agree on the clock. */
  renderedAt: string
}

export type TransferShapeState = "hidden" | "unavailable" | "unreadable" | "ok"

export interface MailboxDetailShape {
  admin: boolean
  /** The hero's button: suspend or resume, for an admin of a live mailbox. */
  action: "none" | "suspend" | "resume"
  /** The deletion banner shows. */
  deleting: boolean
  /** The note under the banner: a status that stops sign-in, and how it reads. */
  note: "none" | "warning" | "danger"
  /** Change storage is offered. */
  storageAction: boolean
  /** The storage card is a meter rather than a line. */
  meter: boolean
  /** The aliases section: the list, its empty card, or the error. */
  aliases: "list" | "empty" | "error"
  /** Alias rows to draw, capped. */
  aliasRows: number
  /** Add alias is offered. */
  aliasAdd: boolean
  /** A reason or a count sits under the aliases. */
  aliasNote: boolean
  transfer: TransferShapeState
  exportKind: ExportView["kind"]
  importKind: ImportView["kind"]
  /** The danger zone shows. */
  danger: boolean
}

const EXPORT_KINDS: ExportView["kind"][] = [
  "none",
  "running",
  "ready",
  "expired",
  "failed",
]
const IMPORT_KINDS: ImportView["kind"][] = [
  "none",
  "unfinished",
  "running",
  "done",
  "failed",
]
const TRANSFER_STATES: TransferShapeState[] = [
  "hidden",
  "unavailable",
  "unreadable",
  "ok",
]

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

/** What the mailbox row alone decides: the part of the shape a list can seed. */
function fromMailbox(
  mailbox: ConsoleMailbox,
  isAdmin: boolean,
  now: Date,
): Pick<
  MailboxDetailShape,
  "admin" | "action" | "deleting" | "note" | "storageAction" | "meter" | "danger"
> {
  const offered = isAdmin ? availableActions(mailbox, now) : []
  const status = statusInfo(mailbox.status)
  const { allocatedBytes, usedBytes } = mailbox.storage
  return {
    admin: isAdmin,
    action: offered.includes("suspend")
      ? "suspend"
      : offered.includes("resume")
        ? "resume"
        : "none",
    deleting: mailbox.deletion !== null,
    note:
      statusNote(mailbox.status, mailbox.domain) === null
        ? "none"
        : status.tone === "danger"
          ? "danger"
          : "warning",
    storageAction: offered.includes("storage"),
    meter: allocatedBytes !== null && usedBytes !== null,
    danger: offered.includes("delete"),
  }
}

function transferState(snapshot: TransferSnapshot): TransferShapeState {
  switch (snapshot.state) {
    case "forbidden":
      return "hidden"
    case "ok":
      return "ok"
    default:
      return snapshot.state
  }
}

const mailboxDetailFallback: MailboxDetailShape = {
  admin: true,
  action: "suspend",
  deleting: false,
  note: "none",
  storageAction: true,
  meter: true,
  aliases: "list",
  aliasRows: 2,
  aliasAdd: true,
  aliasNote: false,
  transfer: "ok",
  exportKind: "none",
  importKind: "none",
  danger: true,
}

export const mailboxDetailShape = defineShape<MailboxDetailShape, MailboxDetailData>({
  page: "mailbox-detail",
  fallback: mailboxDetailFallback,
  of: ({ mailbox, aliases, domains, transfer, isAdmin, renderedAt }) => {
    const notes = aliasNotes({ mailbox, list: aliases, domains, isAdmin })
    const ok = transfer.state === "ok"
    return {
      ...fromMailbox(mailbox, isAdmin, new Date(renderedAt)),
      aliases:
        aliases === null ? "error" : aliases.data.length === 0 ? "empty" : "list",
      aliasRows: Math.min(aliases?.data.length ?? 0, MAX_SKELETON_ROWS),
      aliasAdd: isAdmin && aliases !== null,
      aliasNote: notes.block !== null || notes.countLine !== null,
      transfer: transferState(transfer),
      exportKind: exportView(ok ? transfer.export : null).kind,
      importKind: importView(ok ? transfer.import : null).kind,
    }
  },
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const aliasRows = count(r.aliasRows, MAX_SKELETON_ROWS)
    if (aliasRows === null) return null
    const pick = <T extends string>(v: unknown, all: readonly T[]): T | null =>
      all.find((x) => x === v) ?? null
    const action = pick(r.action, ["none", "suspend", "resume"] as const)
    const note = pick(r.note, ["none", "warning", "danger"] as const)
    const aliases = pick(r.aliases, ["list", "empty", "error"] as const)
    const transfer = pick(r.transfer, TRANSFER_STATES)
    const exportKind = pick(r.exportKind, EXPORT_KINDS)
    const importKind = pick(r.importKind, IMPORT_KINDS)
    if (!action || !note || !aliases || !transfer || !exportKind || !importKind) {
      return null
    }
    return {
      admin: r.admin === true,
      action,
      deleting: r.deleting === true,
      note,
      storageAction: r.storageAction === true,
      meter: r.meter === true,
      aliases,
      aliasRows,
      aliasAdd: r.aliasAdd === true,
      aliasNote: r.aliasNote === true,
      transfer,
      exportKind,
      importKind,
      danger: r.danger === true,
    }
  },
})

/**
 * Plausible shape stashed before navigating from a mailbox row to its page: what
 * the row says, and the common case for what only the page reads (a few aliases,
 * nothing exported yet).
 */
export function seedMailboxShape(
  mailbox: ConsoleMailbox,
  isAdmin: boolean,
): MailboxDetailShape {
  return {
    ...mailboxDetailFallback,
    ...fromMailbox(mailbox, isAdmin, new Date()),
    aliasAdd: isAdmin,
  }
}
