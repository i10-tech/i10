import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import {
  createMailboxImportSchema,
  mailboxJobSchema,
  type MailboxJob,
} from "@repo/contracts"
import type { StreamingObjectStore } from "../content/object-store.js"
import {
  signDownloadToken,
  verifyDownloadToken,
  type MailboxAccessResult,
  type MailboxJobRow,
  type MailboxJobStore,
} from "../mailboxes/jobs.js"
import { LIMITS } from "../mailboxes/archive.js"
import { importKey } from "../mailboxes/migration.js"
import type { MailboxJobData } from "../queue/mailbox-queue.js"
import { requireUser } from "../middleware/session.js"
import { errorResponse, notWired as notWiredFor } from "./shared.js"

/**
 * Moving a mailbox's mail out and in (#385).
 *
 *   POST /mailboxes/:address/export                 queue an export
 *   GET  /mailboxes/:address/export                 its progress, and a link
 *   GET  /mailboxes/:address/export/download        the archive (signed link)
 *   POST /mailboxes/:address/import                 reserve an upload
 *   POST /mailboxes/:address/import/{jobId}/start    the upload is done; run it
 *   GET  /mailboxes/:address/import                 its progress
 *
 * ⚠ WHO MAY: the mailbox's owner, the workspace's owner, or a workspace admin
 * (jobs.ts). A route that names a mailbox is a route that can read it, so every
 * one of these asks first, and a colleague who is none of those gets a 403.
 *
 * ⚠ THE ARCHIVE NEVER PASSES THROUGH THIS PROCESS. An import is a presigned
 * `PUT` straight to R2, then a second call to say it is there; an export is read
 * from R2 as a stream. Anything that read the archive here would hold it in an
 * API pod's memory - and Bun's own request limit (128 MB) would refuse it first.
 */

export interface MailboxMigrationDeps {
  jobs: MailboxJobStore
  store: StreamingObjectStore
  /** Queues the job under its mailbox's group. */
  enqueue: (data: MailboxJobData) => Promise<unknown>
  /** The decision of jobs.ts, bound to its database and admin check. */
  access: (userId: string, address: string) => Promise<MailboxAccessResult>
  /** Verifies the session on the download route, which has no `requireUser`. */
  tokenSecret: string
  now?: () => Date
}

declare module "hono" {
  interface ContextVariableMap {
    mailboxMigration?: MailboxMigrationDeps
  }
}

/** How long a download link works. The status route mints a fresh one each call. */
const LINK_TTL_MS = 15 * 60_000
/** How long the upload URL works: enough to send LIMITS.maxArchiveBytes on a slow line. */
const UPLOAD_TTL_S = 6 * 60 * 60

const MailboxJob = mailboxJobSchema.openapi("MailboxJob")
const CreateMailboxImport = createMailboxImportSchema.openapi("CreateMailboxImport")
const notWired = notWiredFor("Mailbox import and export")

const problem = <S extends number, N extends string>(
  statusCode: S,
  name: N,
  message: string,
) => ({ statusCode, name, message }) as const

const notFound = (message = "Mailbox not found.") => problem(404, "not_found", message)
const forbidden = () =>
  problem(
    403,
    "invalid_access",
    "Only the mailbox's owner or a workspace admin may do that.",
  )

const address = z.object({ address: z.string() })

function formatJob(
  job: MailboxJobRow,
  extra: Pick<MailboxJob, "download_url" | "upload"> = {},
): MailboxJob {
  return {
    object: "mailbox_job",
    id: job.id,
    mailbox_address: job.mailboxAddress,
    type: job.type as MailboxJob["type"],
    status: job.status as MailboxJob["status"],
    progress: {
      total_messages: job.totalMessages,
      processed_messages: job.processedMessages,
      total_folders: job.totalFolders,
      processed_folders: job.processedFolders,
    },
    download_url: extra.download_url ?? null,
    upload: extra.upload ?? null,
    error: job.error ?? null,
    error_code: job.errorCode ?? null,
    created_at: job.createdAt.toISOString(),
    completed_at: job.completedAt?.toISOString() ?? null,
  }
}

const normal = (a: string) => a.trim().toLowerCase()

export const mailboxMigration = new OpenAPIHono()

const migration = (c: {
  get: (k: "mailboxMigration") => MailboxMigrationDeps | undefined
}) => c.get("mailboxMigration")

const downloadUrl = (deps: MailboxMigrationDeps, job: MailboxJobRow, now: Date) => {
  const usable =
    job.type === "export" &&
    job.status === "completed" &&
    job.objectKey &&
    job.expiresAt &&
    job.expiresAt > now
  if (!usable) return null
  const token = signDownloadToken(
    { tenantId: job.tenantId, jobId: job.id },
    now.getTime() + LINK_TTL_MS,
    deps.tokenSecret,
  )
  return `/mailboxes/${encodeURIComponent(job.mailboxAddress)}/export/download?token=${token}`
}

// ── Export ──────────────────────────────────────────────────────────────────

const startExport = createRoute({
  method: "post",
  path: "/{address}/export",
  summary: "Export a mailbox",
  description:
    "Queues a full export of the mailbox: every folder, every message byte for byte, " +
    "with its flags and dates, as a `.tar.gz`. If an export is already running, that " +
    "one is returned. Poll `GET` for progress and the download link.",
  tags: ["Mailbox export"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: { params: address },
  responses: {
    202: {
      description: "Queued, or already running.",
      content: { "application/json": { schema: MailboxJob } },
    },
    401: errorResponse("Not signed in."),
    403: errorResponse("Not the mailbox's owner or a workspace admin."),
    404: errorResponse("No such mailbox."),
    501: errorResponse("Mailbox export is not configured."),
  },
})

mailboxMigration.openapi(startExport, async (c) => {
  const deps = migration(c)
  if (!deps) return c.json(notWired, 501)

  const mailbox = normal(c.req.valid("param").address)
  const { userId } = c.get("user")
  const access = await deps.access(userId, mailbox)
  if (!access.allowed) {
    return access.reason === "not_found"
      ? c.json(notFound(), 404)
      : c.json(forbidden(), 403)
  }
  const tenantId = access.tenantId!

  // One at a time: a second request while one runs is the same request.
  const current = await deps.jobs.latest(tenantId, mailbox, "export")
  if (current && (current.status === "pending" || current.status === "running")) {
    return c.json(formatJob(current), 202)
  }

  const job = await deps.jobs.insert({
    tenantId,
    mailboxAddress: mailbox,
    type: "export",
    requestedBy: userId,
    status: "pending",
  })
  await deps.enqueue({
    jobId: job.id,
    tenantId,
    mailboxAddress: mailbox,
    type: "export",
  })
  return c.json(formatJob(job), 202)
})

const exportStatus = createRoute({
  method: "get",
  path: "/{address}/export",
  summary: "Get a mailbox export's progress",
  tags: ["Mailbox export"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: { params: address },
  responses: {
    200: {
      description:
        "The latest export. Complete jobs carry a short-lived `download_url`.",
      content: { "application/json": { schema: MailboxJob } },
    },
    401: errorResponse("Not signed in."),
    403: errorResponse("Not the mailbox's owner or a workspace admin."),
    404: errorResponse("No such mailbox, or it has never been exported."),
    501: errorResponse("Mailbox export is not configured."),
  },
})

mailboxMigration.openapi(exportStatus, async (c) => {
  const deps = migration(c)
  if (!deps) return c.json(notWired, 501)

  const mailbox = normal(c.req.valid("param").address)
  const { userId } = c.get("user")
  const access = await deps.access(userId, mailbox)
  if (!access.allowed) {
    return access.reason === "not_found"
      ? c.json(notFound(), 404)
      : c.json(forbidden(), 403)
  }

  const job = await deps.jobs.latest(access.tenantId!, mailbox, "export")
  if (!job) return c.json(notFound("This mailbox has not been exported."), 404)
  return c.json(
    formatJob(job, {
      download_url: downloadUrl(deps, job, (deps.now ?? (() => new Date()))()),
    }),
    200,
  )
})

const download = createRoute({
  method: "get",
  path: "/{address}/export/download",
  summary: "Download a mailbox export",
  description:
    "Streams the archive. Authorised by the signed `token` of a status response " +
    "(good for fifteen minutes, for one export of one workspace), or by the " +
    "signed-in session of someone who may export the mailbox.",
  tags: ["Mailbox export"],
  request: { params: address, query: z.object({ token: z.string().optional() }) },
  responses: {
    200: {
      description: "The export, as a gzipped tar.",
      content: {
        "application/gzip": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    401: errorResponse(
      "The link is invalid or expired, or the caller is not signed in.",
    ),
    403: errorResponse("Not the mailbox's owner or a workspace admin."),
    404: errorResponse("No such mailbox, or no finished export."),
    410: errorResponse("The export has expired. Start a new one."),
    501: errorResponse("Mailbox export is not configured."),
  },
})

mailboxMigration.openapi(download, async (c) => {
  const deps = migration(c)
  if (!deps) return c.json(notWired, 501)

  const mailbox = normal(c.req.valid("param").address)
  const now = (deps.now ?? (() => new Date()))()
  const { token } = c.req.valid("query")

  let job: MailboxJobRow | null
  if (token) {
    const link = verifyDownloadToken(token, deps.tokenSecret, now.getTime())
    if (!link) {
      return c.json(
        problem(401, "invalid_access", "That download link is invalid or has expired."),
        401,
      )
    }
    // ⚠ LOOKED UP UNDER THE TOKEN'S TENANT, so row-level security answers for a
    // job id that belongs to anyone else.
    job = await deps.jobs.get(link.tenantId, link.jobId)
  } else {
    const verifier = c.get("sessionAuth")
    if (!verifier) return c.json(notWired, 501)
    const session = await verifier.verify(c.req.raw)
    if (session.status !== "signed-in") {
      return c.json(
        problem(401, "invalid_access", "Sign in to download this export."),
        401,
      )
    }
    const access = await deps.access(session.userId, mailbox)
    if (!access.allowed) {
      return access.reason === "not_found"
        ? c.json(notFound(), 404)
        : c.json(forbidden(), 403)
    }
    job = await deps.jobs.latest(access.tenantId!, mailbox, "export")
  }

  // ⚠ THE LINK NAMES A JOB, AND THE PATH NAMES A MAILBOX: they must agree, or a
  // link for one mailbox's export would open under another's URL.
  if (
    !job ||
    job.type !== "export" ||
    job.mailboxAddress !== mailbox ||
    job.status !== "completed" ||
    !job.objectKey
  ) {
    return c.json(notFound("There is no finished export for this mailbox."), 404)
  }
  if (!job.expiresAt || job.expiresAt <= now) {
    return c.json(
      problem(410, "not_found", "That export has expired. Start a new one."),
      410,
    )
  }

  const size = await deps.store.size(job.objectKey)
  if (size === null) {
    return c.json(
      problem(410, "not_found", "That export has expired. Start a new one."),
      410,
    )
  }

  return c.body(deps.store.read(job.objectKey), 200, {
    "content-type": "application/gzip",
    "content-length": String(size),
    "content-disposition": `attachment; filename="${mailbox.replace(/[^a-z0-9@._-]/g, "_")}-export.tar.gz"`,
    "cache-control": "no-store",
  })
})

// ── Import ──────────────────────────────────────────────────────────────────

const startUpload = createRoute({
  method: "post",
  path: "/{address}/import",
  summary: "Import into a mailbox: reserve the upload",
  description:
    "Reserves an upload of a zip, tar, tar.gz or mbox archive (a Google Takeout works) " +
    "and returns a URL to `PUT` the file to. The file goes straight to storage and not " +
    "through this API. When it has been sent, call `POST .../import/{id}/start`. " +
    `Archives over ${LIMITS.maxArchiveBytes / 1024 ** 3} GiB, and single messages over ` +
    `${LIMITS.maxMessageBytes / 1024 ** 2} MB, are refused.`,
  tags: ["Mailbox import"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: {
    params: address,
    body: {
      required: true,
      content: { "application/json": { schema: CreateMailboxImport } },
    },
  },
  responses: {
    201: {
      description: "Reserved. `PUT` the archive to `upload.url`.",
      content: { "application/json": { schema: MailboxJob } },
    },
    401: errorResponse("Not signed in."),
    403: errorResponse("Not the mailbox's owner or a workspace admin."),
    404: errorResponse("No such mailbox."),
    413: errorResponse("The archive is over the size limit."),
    422: errorResponse("The request is malformed."),
    501: errorResponse("Mailbox import is not configured."),
  },
})

mailboxMigration.openapi(
  startUpload,
  async (c) => {
    const deps = migration(c)
    if (!deps) return c.json(notWired, 501)

    const mailbox = normal(c.req.valid("param").address)
    const { size } = c.req.valid("json")
    const { userId } = c.get("user")
    const access = await deps.access(userId, mailbox)
    if (!access.allowed) {
      return access.reason === "not_found"
        ? c.json(notFound(), 404)
        : c.json(forbidden(), 403)
    }
    if (size > LIMITS.maxArchiveBytes) {
      return c.json(
        problem(
          413,
          "validation_error",
          `The archive is over ${LIMITS.maxArchiveBytes / 1024 ** 3} GiB. Split it and import the parts.`,
        ),
        413,
      )
    }
    const tenantId = access.tenantId!

    const reserved = await deps.jobs.insert({
      tenantId,
      mailboxAddress: mailbox,
      type: "import",
      requestedBy: userId,
      status: "awaiting_upload",
    })
    // The key is ours, derived from the job: the client never names it.
    const key = importKey(tenantId, reserved.id)
    const job =
      (await deps.jobs.update(tenantId, reserved.id, { objectKey: key })) ?? reserved

    const now = (deps.now ?? (() => new Date()))()
    return c.json(
      formatJob(job, {
        upload: {
          url: deps.store.presignPut(key, UPLOAD_TTL_S),
          method: "PUT",
          expires_at: new Date(now.getTime() + UPLOAD_TTL_S * 1000).toISOString(),
        },
      }),
      201,
    )
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        problem(
          422,
          "validation_error",
          result.error.issues[0]?.message ?? "Invalid request body.",
        ),
        422,
      )
    }
  },
)

const startImport = createRoute({
  method: "post",
  path: "/{address}/import/{jobId}/start",
  summary: "Import into a mailbox: run it",
  description: "Call once the archive has been uploaded. Queues the import.",
  tags: ["Mailbox import"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: { params: address.extend({ jobId: z.string() }) },
  responses: {
    202: {
      description: "Queued.",
      content: { "application/json": { schema: MailboxJob } },
    },
    401: errorResponse("Not signed in."),
    403: errorResponse("Not the mailbox's owner or a workspace admin."),
    404: errorResponse("No such mailbox or import."),
    409: errorResponse("The archive has not arrived, or the import already started."),
    413: errorResponse("The uploaded archive is over the size limit."),
    501: errorResponse("Mailbox import is not configured."),
  },
})

mailboxMigration.openapi(startImport, async (c) => {
  const deps = migration(c)
  if (!deps) return c.json(notWired, 501)

  const { jobId, ...params } = c.req.valid("param")
  const mailbox = normal(params.address)
  const { userId } = c.get("user")
  const access = await deps.access(userId, mailbox)
  if (!access.allowed) {
    return access.reason === "not_found"
      ? c.json(notFound(), 404)
      : c.json(forbidden(), 403)
  }
  const tenantId = access.tenantId!

  const job = await deps.jobs.get(tenantId, jobId)
  if (!job || job.type !== "import" || job.mailboxAddress !== mailbox) {
    return c.json(notFound("No such import."), 404)
  }
  // Pressed twice, or a client retrying: the same job, not a second run.
  if (job.status !== "awaiting_upload") {
    return job.status === "pending" || job.status === "running"
      ? c.json(formatJob(job), 202)
      : c.json(
          problem(409, "validation_error", "That import has already finished."),
          409,
        )
  }

  const size = job.objectKey ? await deps.store.size(job.objectKey) : null
  if (size === null) {
    return c.json(
      problem(
        409,
        "validation_error",
        "The archive has not arrived. Upload it, then start.",
      ),
      409,
    )
  }
  // ⚠ THE SIZE THE CLIENT DECLARED WAS ONLY A CLAIM; this is the object. A
  // presigned `PUT` cannot cap its own length, so the cap is enforced here and
  // again by the reader in the worker.
  if (size > LIMITS.maxArchiveBytes) {
    await deps.store.delete(job.objectKey!)
    await deps.jobs.update(tenantId, job.id, {
      status: "failed",
      error: `The archive is over ${LIMITS.maxArchiveBytes / 1024 ** 3} GiB.`,
      errorCode: "archive_too_large",
      objectKey: null,
      completedAt: new Date(),
    })
    return c.json(
      problem(413, "validation_error", "The uploaded archive is over the size limit."),
      413,
    )
  }

  const queued =
    (await deps.jobs.update(tenantId, job.id, { status: "pending" })) ?? job
  await deps.enqueue({
    jobId: job.id,
    tenantId,
    mailboxAddress: mailbox,
    type: "import",
  })
  return c.json(formatJob(queued), 202)
})

const importStatus = createRoute({
  method: "get",
  path: "/{address}/import",
  summary: "Get a mailbox import's progress",
  tags: ["Mailbox import"],
  security: [{ sessionAuth: [] }],
  middleware: [requireUser] as const,
  request: { params: address },
  responses: {
    200: {
      description:
        "The latest import. `total_messages` is 0 until known: an i10 export only says " +
        "how many it holds at its end.",
      content: { "application/json": { schema: MailboxJob } },
    },
    401: errorResponse("Not signed in."),
    403: errorResponse("Not the mailbox's owner or a workspace admin."),
    404: errorResponse("No such mailbox, or nothing has been imported."),
    501: errorResponse("Mailbox import is not configured."),
  },
})

mailboxMigration.openapi(importStatus, async (c) => {
  const deps = migration(c)
  if (!deps) return c.json(notWired, 501)

  const mailbox = normal(c.req.valid("param").address)
  const { userId } = c.get("user")
  const access = await deps.access(userId, mailbox)
  if (!access.allowed) {
    return access.reason === "not_found"
      ? c.json(notFound(), 404)
      : c.json(forbidden(), 403)
  }

  const job = await deps.jobs.latest(access.tenantId!, mailbox, "import")
  if (!job) return c.json(notFound("Nothing has been imported into this mailbox."), 404)
  return c.json(formatJob(job), 200)
})
