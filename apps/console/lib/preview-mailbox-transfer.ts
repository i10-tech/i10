import { ApiRequestError, type ApiError } from "./api-error"
import type { MailboxJob } from "./mailbox-transfer"
import { PREVIEW_UPLOAD_PREFIX } from "./mailbox-upload"

type Query = Record<string, string | number | undefined | null> | undefined
type Route = [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string, body?: unknown) => unknown,
]

/**
 * Preview fixtures for a mailbox's export and import (U7).
 *
 * ⚠ STATEFUL, UNLIKE MOST FIXTURES, BECAUSE THE POINT IS THE JOURNEY: a job is
 * pending, then running, then done or failed, and each read of it moves it one
 * step on. The state lives in this module, so a reload of the page keeps it and
 * a restart of the preview resets it.
 *
 * ⚠ EVERY STATE IS REACHED FROM THE KEYBOARD BY WHICH MAILBOX IS OPEN:
 *
 *   alice  nothing yet; an export and an import both run cleanly
 *   bob    reserving an import is refused (403)
 *   carol  the export runs and then fails; the import fails: not a mail archive
 *   dan    export and import are not configured (501)
 *   noah   an expired export on arrival; the first "start" is refused (409: the
 *          file did not arrive), the second works, and the import skips 3 messages
 *   gwen   a finished export ready to download, and a finished import, on arrival
 *   ivan   a failed export, and an import whose upload never finished, on arrival;
 *          a new import stops partway: the mailbox is out of space
 *   hank, lena (being deleted)  as alice
 *
 * The browser's "upload" is a timer here (`PREVIEW_UPLOAD_PREFIX`), so nothing
 * leaves the page.
 */

const apiError = (statusCode: number, name: string, message: string) =>
  new ApiRequestError(statusCode, { statusCode, name, message } as ApiError)

const DAY = 86_400_000

interface Plan {
  total: number
  folders: number
  /** Where a failing job stops, as a fraction of the total. */
  failAt?: number
  code?: string
  error?: string
  skipped?: number
}

interface Sim {
  job: MailboxJob
  plan: Plan
  /** Reads since it started running, which is how the preview tells time. */
  ticks: number
  startRefusedOnce?: boolean
}

const zero = {
  total_messages: 0,
  processed_messages: 0,
  total_folders: 0,
  processed_folders: 0,
}

let ids = 0
const nextId = () => `job_preview_${++ids}`

function job(
  address: string,
  type: "export" | "import",
  fields: Partial<MailboxJob>,
): MailboxJob {
  return {
    object: "mailbox_job",
    id: nextId(),
    mailbox_address: address,
    type,
    status: "pending",
    progress: zero,
    created_at: new Date().toISOString(),
    ...fields,
  }
}

const local = (address: string) => address.split("@")[0] ?? ""

function exportPlan(address: string): Plan {
  return local(address) === "carol"
    ? {
        total: 5200,
        folders: 9,
        failAt: 0.6,
        code: "stalwart",
        error: "The mail server could not complete the request.",
      }
    : { total: 5200, folders: 9 }
}

function importPlan(address: string): Plan {
  switch (local(address)) {
    case "carol":
      return {
        total: 0,
        folders: 0,
        failAt: 0,
        code: "archive_invalid",
        error: "that is not a zip, tar, tar.gz or mbox file",
      }
    case "ivan":
      return {
        total: 8000,
        folders: 4,
        failAt: 0.15,
        code: "over_quota",
        error: "the mailbox is over its quota",
      }
    case "noah":
      return { total: 2400, folders: 5, skipped: 3 }
    default:
      return { total: 3000, folders: 6 }
  }
}

/** Moves a running job one step on, and finishes it when its plan says so. */
function advance(sim: Sim): MailboxJob {
  const { job: current, plan } = sim
  if (current.status === "pending") {
    sim.job = { ...current, status: "running" }
    return sim.job
  }
  if (current.status !== "running") return current

  sim.ticks += 1
  const total = plan.total
  const processed = Math.min(total, Math.round((total * sim.ticks) / 4))
  const folders = Math.min(plan.folders, Math.ceil((plan.folders * sim.ticks) / 4))
  const progress = {
    total_messages: current.type === "export" ? total : 0,
    processed_messages: processed,
    total_folders: current.type === "export" ? plan.folders : 0,
    processed_folders: folders,
  }

  if (plan.failAt !== undefined && processed >= Math.round(total * plan.failAt)) {
    sim.job = {
      ...current,
      status: "failed",
      progress: { ...progress, processed_messages: Math.round(total * plan.failAt) },
      error: plan.error ?? null,
      error_code: plan.code ?? "failed",
      completed_at: new Date().toISOString(),
    }
    return sim.job
  }
  if (processed >= total) {
    sim.job = {
      ...current,
      status: "completed",
      progress: { ...progress, total_messages: total, total_folders: plan.folders },
      ...(plan.skipped
        ? {
            error: `${plan.skipped} messages were skipped because the mail server would not take them.`,
            error_code: "skipped_messages",
          }
        : {}),
      completed_at: new Date().toISOString(),
    }
    return sim.job
  }
  sim.job = { ...current, progress }
  return sim.job
}

export function transferRoutes(): Route[] {
  const exports = new Map<string, Sim>()
  const imports = new Map<string, Sim>()

  const finished = (
    address: string,
    type: "export" | "import",
    daysAgo: number,
    f: Partial<MailboxJob>,
  ) =>
    job(address, type, {
      status: "completed",
      completed_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
      ...f,
    })

  /** The state a mailbox is in before anybody has done anything this session. */
  function seed(address: string) {
    if (exports.has(address) || imports.has(address)) return
    const plan = (type: "export" | "import") =>
      type === "export" ? exportPlan(address) : importPlan(address)
    const put = (map: Map<string, Sim>, j: MailboxJob) =>
      map.set(address, { job: j, plan: plan(j.type), ticks: 0 })

    switch (local(address)) {
      case "gwen":
        put(
          exports,
          finished(address, "export", 2, {
            progress: {
              total_messages: 4210,
              processed_messages: 4210,
              total_folders: 6,
              processed_folders: 6,
            },
            download_url: `/mailboxes/${encodeURIComponent(address)}/export/download?token=preview`,
          }),
        )
        put(
          imports,
          finished(address, "import", 5, {
            progress: {
              total_messages: 0,
              processed_messages: 4210,
              total_folders: 0,
              processed_folders: 6,
            },
          }),
        )
        break
      case "noah":
        put(
          exports,
          finished(address, "export", 9, {
            progress: {
              total_messages: 900,
              processed_messages: 900,
              total_folders: 4,
              processed_folders: 4,
            },
          }),
        )
        break
      case "ivan":
        put(
          exports,
          job(address, "export", {
            status: "failed",
            error: "The mail server could not complete the request.",
            error_code: "stalwart",
            completed_at: new Date(Date.now() - DAY).toISOString(),
          }),
        )
        put(imports, job(address, "import", { status: "awaiting_upload" }))
        break
    }
  }

  function exportRoute(address: string, method: string): MailboxJob {
    if (local(address) === "dan") {
      throw apiError(501, "internal_server_error", "Mailbox export is not configured.")
    }
    seed(address)
    const existing = exports.get(address)

    if (method === "POST") {
      if (
        existing &&
        (existing.job.status === "pending" || existing.job.status === "running")
      ) {
        return existing.job
      }
      const sim: Sim = {
        job: job(address, "export", {}),
        plan: exportPlan(address),
        ticks: 0,
      }
      exports.set(address, sim)
      return sim.job
    }

    if (!existing)
      throw apiError(404, "not_found", "This mailbox has not been exported.")
    const next = advance(existing)
    // ⚠ THE LINK APPEARS WITH THE FINISH, as the API's does: it is minted on read.
    if (next.status === "completed" && !next.download_url) {
      existing.job = {
        ...next,
        download_url: `/mailboxes/${encodeURIComponent(address)}/export/download?token=preview`,
      }
      return existing.job
    }
    return next
  }

  function importRoute(address: string, method: string, body: unknown): MailboxJob {
    if (local(address) === "dan") {
      throw apiError(501, "internal_server_error", "Mailbox import is not configured.")
    }
    seed(address)

    if (method === "POST") {
      if (local(address) === "bob") {
        throw apiError(
          403,
          "invalid_access",
          "Only the mailbox's owner or a workspace admin may do that.",
        )
      }
      const size = (body as { size?: number } | null)?.size ?? 0
      const reserved = job(address, "import", {
        status: "awaiting_upload",
        upload: {
          url: `${PREVIEW_UPLOAD_PREFIX}upload/${size}`,
          method: "PUT",
          expires_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        },
      })
      imports.set(address, { job: reserved, plan: importPlan(address), ticks: 0 })
      return reserved
    }

    const existing = imports.get(address)
    if (!existing)
      throw apiError(404, "not_found", "Nothing has been imported into this mailbox.")
    return advance(existing)
  }

  function startRoute(address: string, jobId: string): MailboxJob {
    const existing = imports.get(address)
    if (!existing || existing.job.id !== jobId || existing.job.type !== "import") {
      throw apiError(404, "not_found", "No such import.")
    }
    if (existing.job.status !== "awaiting_upload") return existing.job
    // ⚠ NOAH'S FIRST START IS REFUSED: the file "did not arrive", so the retry
    // path (send again, no new step-up) can be reviewed.
    if (local(address) === "noah" && !existing.startRefusedOnce) {
      existing.startRefusedOnce = true
      throw apiError(
        409,
        "validation_error",
        "The archive has not arrived. Upload it, then start.",
      )
    }
    existing.job = { ...existing.job, status: "pending", upload: null }
    return existing.job
  }

  const address = "([^/]*(?:%40|@)[^/]*)"
  return [
    [
      new RegExp(`^/mailboxes/${address}/export$`),
      (m, _q, method) => exportRoute(decodeURIComponent(m[1]!), method),
    ],
    [
      new RegExp(`^/mailboxes/${address}/import$`),
      (m, _q, method, body) => importRoute(decodeURIComponent(m[1]!), method, body),
    ],
    [
      new RegExp(`^/mailboxes/${address}/import/([^/]+)/start$`),
      (m) => startRoute(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)),
    ],
  ]
}
