import type { StreamingObjectStore } from "../content/object-store.js"
import {
  JmapAsError,
  type AuthorisedMailbox,
  type JmapAsClient,
} from "../mail/jmap-as.js"
import type { MailboxJobData } from "../queue/mailbox-queue.js"
import {
  LIMITS,
  manifestEntry,
  messagePaths,
  metaEntry,
  readArchive,
  type ArchiveLimits,
  type ImportMessage,
} from "./archive.js"
import { ArchiveError } from "./bytes.js"
import {
  sweepMailboxArchives,
  type MailboxJobPatch,
  type MailboxJobStore,
} from "./jobs.js"
import { tarStream, type TarEntry } from "./tar.js"

/**
 * Mailbox export and import, as they run in the worker (#385).
 *
 *   EXPORT  folders -> messages -> tar -> gzip -> a multipart write to R2
 *   IMPORT  R2 -> gunzip/unzip/untar -> messages -> Email/import, one at a time
 *
 * ⚠ BOTH ARE PIPES, AND THE MEMORY BOUND IS WHAT THEY ARE FOR. Export hands each
 * message to the archive as a stream, so what is held at any moment is a few
 * chunks and the upload's parts (about 3 x 8 MiB), however big the mailbox.
 * Import holds one message while it uploads it. A multi-gigabyte mailbox goes
 * through the same few tens of megabytes as a small one.
 *
 * ⚠ QUOTA IS RESPECTED BY ASKING STALWART, NOT BY COUNTING. A full account
 * answers an upload or an `Email/import` with an over-quota error, and that
 * fails the job with `over_quota` and no retry: retrying cannot make room.
 *
 * ⚠ IMPORTS ARE THROTTLED, because every imported message is queued for search
 * indexing and Stalwart runs two indexing tasks in a 1 GiB pod (E2). One
 * message at a time, and a pause every `batchSize`.
 */

export interface MigrationDeps {
  jobs: MailboxJobStore
  store: StreamingObjectStore
  jmap: JmapAsClient
  log?: {
    info: (o: object, m: string) => void
    warn: (o: object, m: string) => void
    error: (o: object, m: string) => void
  }
  limits?: ArchiveLimits
  /** Messages between progress writes and pauses. */
  batchSize?: number
  batchPauseMs?: number
}

/** An export is kept this long, then its object is swept. */
export const EXPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000

const PAGE = 100
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const exportKey = (tenantId: string, jobId: string) =>
  `${tenantId}/exports/${jobId}.tar.gz`
export const importKey = (tenantId: string, jobId: string) =>
  `${tenantId}/imports/${jobId}`

/**
 * What a failure is called on the job. The message is what the customer reads,
 * so only errors written for that are passed through; anything else is logged
 * in full and shown as a plain "failed".
 */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ArchiveError) return { code: error.code, message: error.message }
  if (error instanceof JmapAsError) {
    if (error.code === "over_quota")
      return { code: "over_quota", message: error.message }
    if (error.code === "too_large")
      return { code: "message_too_large", message: error.message }
    return {
      code: "stalwart",
      message: "The mail server could not complete the request.",
    }
  }
  return { code: "failed", message: "The job failed unexpectedly." }
}

async function fail(jobData: MailboxJobData, deps: MigrationDeps, error: unknown) {
  const { code, message } = describeFailure(error)
  deps.log?.error(
    { err: error, jobId: jobData.jobId, type: jobData.type, code },
    "mailbox job failed",
  )
  await deps.jobs.update(jobData.tenantId, jobData.jobId, {
    status: "failed",
    error: message,
    errorCode: code,
    completedAt: new Date(),
  })
}

/** Starts a job, or says it is not this worker's to start. */
async function begin(jobData: MailboxJobData, deps: MigrationDeps) {
  const job = await deps.jobs.get(jobData.tenantId, jobData.jobId)
  // ⚠ ONLY A PENDING JOB. A redelivery of one already finished must not run the
  // export or the import a second time.
  if (!job || job.status !== "pending") return null
  await deps.jobs.update(jobData.tenantId, jobData.jobId, { status: "running" })
  await sweepMailboxArchives(deps.jobs, deps.store, jobData.tenantId).catch((error) =>
    deps.log?.warn({ err: error }, "could not sweep expired mailbox archives"),
  )
  return job
}

/** One JMAP method, and its result. */
async function method(
  jmap: JmapAsClient,
  mailbox: AuthorisedMailbox,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [response] = await jmap.call(mailbox, [[name, args, "c"]])
  return response![1]
}

// ── Folders ─────────────────────────────────────────────────────────────────

interface Folder {
  id: string
  path: string[]
  role: string | null
  total: number
}

async function listFolders(
  jmap: JmapAsClient,
  mailbox: AuthorisedMailbox,
): Promise<Folder[]> {
  const result = await method(jmap, mailbox, "Mailbox/get", {})
  const list = (Array.isArray(result.list) ? result.list : []) as Record<
    string,
    unknown
  >[]
  const byId = new Map(list.map((f) => [String(f.id), f]))

  const pathOf = (folder: Record<string, unknown>): string[] => {
    const path: string[] = []
    // The depth guard is for a parent cycle, which a sane server never has.
    for (
      let at: Record<string, unknown> | undefined = folder;
      at && path.length < 32;
    ) {
      path.unshift(String(at.name))
      at = typeof at.parentId === "string" ? byId.get(at.parentId) : undefined
    }
    return path
  }

  return list.map((f) => ({
    id: String(f.id),
    path: pathOf(f),
    role: typeof f.role === "string" ? f.role : null,
    total: Number(f.totalEmails ?? 0),
  }))
}

/** What other providers call the standard folders, by the role Stalwart gives them. */
const ROLE_NAMES: Record<string, string> = {
  inbox: "inbox",
  sent: "sent",
  "sent items": "sent",
  "sent mail": "sent",
  drafts: "drafts",
  trash: "trash",
  bin: "trash",
  "deleted items": "trash",
  junk: "junk",
  spam: "junk",
  "junk email": "junk",
  "junk e-mail": "junk",
  archive: "archive",
}

// ── Export ──────────────────────────────────────────────────────────────────

async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function runMailboxExport(
  jobData: MailboxJobData,
  deps: MigrationDeps,
): Promise<void> {
  if (!(await begin(jobData, deps))) return
  const { jobs, store, jmap } = deps
  const mailbox = { address: jobData.mailboxAddress }
  const key = exportKey(jobData.tenantId, jobData.jobId)
  const patch = (p: MailboxJobPatch) => jobs.update(jobData.tenantId, jobData.jobId, p)

  try {
    const folders = await listFolders(jmap, mailbox)
    await patch({
      totalFolders: folders.length,
      totalMessages: folders.reduce((n, f) => n + f.total, 0),
    })

    let sequence = 0
    let processedFolders = 0
    let processedMessages = 0
    const done: { path: string[]; role: string | null; total: number }[] = []

    async function* entries(): AsyncGenerator<TarEntry> {
      for (const folder of folders) {
        let exported = 0
        for (let position = 0; ;) {
          const queried = await method(jmap, mailbox, "Email/query", {
            filter: { inMailbox: folder.id },
            sort: [{ property: "receivedAt", isAscending: true }],
            position,
            limit: PAGE,
          })
          const ids = (Array.isArray(queried.ids) ? queried.ids : []) as string[]
          if (ids.length === 0) break
          position += ids.length

          const got = await method(jmap, mailbox, "Email/get", {
            ids,
            properties: ["id", "blobId", "keywords", "receivedAt", "size"],
          })
          const emails = (Array.isArray(got.list) ? got.list : []) as Record<
            string,
            unknown
          >[]

          for (const email of emails) {
            let download
            try {
              download = await jmap.downloadBlob(mailbox, String(email.blobId))
            } catch (error) {
              // Deleted while the export ran: not in the mailbox any more.
              if (error instanceof JmapAsError && error.code === "not_found") continue
              throw error
            }

            // A tar header needs the length before the bytes. Stalwart's own
            // header is the truth, `Email.size` the fallback, and a message
            // with neither is read whole, which is bounded by one message.
            let size =
              download.size ?? (typeof email.size === "number" ? email.size : null)
            let body: AsyncIterable<Uint8Array> | Uint8Array
            if (size === null) {
              const parts: Uint8Array[] = []
              for await (const piece of chunksOf(download.body)) parts.push(piece)
              body = new Uint8Array(await new Blob(parts).arrayBuffer())
              size = body.byteLength
            } else {
              body = chunksOf(download.body)
            }

            sequence++
            const paths = messagePaths(folder.path, sequence)
            yield metaEntry(paths.meta, {
              folder: folder.path,
              role: folder.role,
              keywords: (email.keywords ?? {}) as Record<string, boolean>,
              received_at:
                typeof email.receivedAt === "string" ? email.receivedAt : null,
            })
            yield { path: paths.eml, size, body }

            exported++
            processedMessages++
            if (processedMessages % 50 === 0) await patch({ processedMessages })
          }
        }
        done.push({ path: folder.path, role: folder.role, total: exported })
        processedFolders++
        await patch({ processedFolders, processedMessages })
      }

      yield manifestEntry({
        version: 1,
        exported_at: new Date().toISOString(),
        mailbox: jobData.mailboxAddress,
        total_messages: processedMessages,
        folders: done,
      })
    }

    // ⚠ AN ABORTED PIPE LEAVES NO OBJECT. The multipart upload is only completed
    // by `end()`, which the sink calls on a clean close; an error anywhere in
    // the chain skips it, so a failed export never has a half-archive to
    // download. The orphaned parts are R2's to expire.
    const writer = store.open(key, "application/gzip")
    await tarStream(entries())
      .pipeThrough(new CompressionStream("gzip"))
      .pipeTo(
        new WritableStream<Uint8Array>({
          write: (chunk) => writer.write(chunk),
          close: () => writer.end(),
        }),
      )

    await patch({
      status: "completed",
      objectKey: key,
      processedFolders,
      processedMessages,
      totalMessages: processedMessages,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + EXPORT_KEEP_MS),
    })
  } catch (error) {
    await fail(jobData, deps, error)
    throw error
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

/** Finds the mailbox for a path and role, creating what is missing. */
class FolderResolver {
  private readonly byPath = new Map<string, string>()
  private readonly byRole = new Map<string, string>()
  readonly used = new Set<string>()

  constructor(
    private readonly jmap: JmapAsClient,
    private readonly mailbox: AuthorisedMailbox,
    existing: Folder[],
  ) {
    for (const f of existing) {
      this.byPath.set(key(f.path), f.id)
      if (f.role) this.byRole.set(f.role, f.id)
    }
  }

  async resolve(path: string[], role: string | null): Promise<string> {
    const named = path.length === 1 ? ROLE_NAMES[path[0]!.toLowerCase()] : undefined
    const wanted = role ?? named ?? (path.length === 0 ? "inbox" : null)
    const standard = wanted ? this.byRole.get(wanted) : undefined
    if (standard) return this.use(standard)

    let parent: string | undefined
    for (let depth = 1; depth <= path.length; depth++) {
      const prefix = path.slice(0, depth)
      let id = this.byPath.get(key(prefix))
      if (!id) {
        id = await this.create(prefix.at(-1)!, parent)
        this.byPath.set(key(prefix), id)
      }
      parent = id
    }
    if (!parent)
      throw new JmapAsError("stalwart", "the mailbox has no Inbox to import into")
    return this.use(parent)
  }

  private use(id: string) {
    this.used.add(id)
    return id
  }

  private async create(name: string, parentId: string | undefined): Promise<string> {
    const result = await method(this.jmap, this.mailbox, "Mailbox/set", {
      create: { f: parentId ? { name, parentId } : { name } },
    })
    const created = (result.created ?? {}) as Record<string, { id?: string }>
    const failed = (result.notCreated ?? {}) as Record<string, { type?: string }>
    if (!created.f?.id) {
      if (failed.f?.type === "overQuota")
        throw new JmapAsError("over_quota", "the mailbox is over its quota")
      throw new JmapAsError(
        "stalwart",
        `could not create the folder ${name}: ${failed.f?.type ?? "unknown"}`,
      )
    }
    return created.f.id
  }
}

const key = (path: string[]) => path.map((p) => p.toLowerCase()).join("\u0000")

/** RFC 8620's UTCDate drops the fraction when it is zero. */
const utcDate = (iso: string | undefined) => iso?.replace(/\.000Z$/, "Z")

export async function runMailboxImport(
  jobData: MailboxJobData,
  deps: MigrationDeps,
): Promise<void> {
  const job = await begin(jobData, deps)
  if (!job) return
  const { jobs, store, jmap } = deps
  const limits = deps.limits ?? LIMITS
  const batchSize = deps.batchSize ?? 25
  const pauseMs = deps.batchPauseMs ?? 100
  const mailbox = { address: jobData.mailboxAddress }
  const patch = (p: MailboxJobPatch) => jobs.update(jobData.tenantId, jobData.jobId, p)
  const archiveKey = job.objectKey

  try {
    if (!archiveKey)
      throw new ArchiveError("archive_invalid", "no archive was uploaded")
    // ⚠ THE UPLOAD WENT STRAIGHT TO R2, so its size was never ours to check on
    // the way in. Checked here, before a byte is read, and again as bytes
    // arrive (a reader enforces the cap on what it actually receives).
    const size = await store.size(archiveKey)
    if (size === null)
      throw new ArchiveError("archive_invalid", "the upload never arrived")
    if (size > limits.maxArchiveBytes) {
      throw new ArchiveError(
        "archive_too_large",
        `the archive is over ${limits.maxArchiveBytes / 1024 ** 3} GiB; split it and import the parts`,
      )
    }

    const resolver = new FolderResolver(jmap, mailbox, await listFolders(jmap, mailbox))
    let processed = 0
    let skipped = 0
    let manifestFolders: { path: string[]; role: string | null }[] = []

    const importOne = async (message: ImportMessage) => {
      const folderId = await resolver.resolve(message.folder, message.role)

      let blobId: string
      try {
        blobId = (await jmap.uploadBlob(mailbox, message.content)).blobId
      } catch (error) {
        if (error instanceof JmapAsError && error.code === "too_large") {
          throw new ArchiveError(
            "message_too_large",
            `${message.entry} was refused by the mail server as too large`,
          )
        }
        throw error
      }

      const keywords = Object.fromEntries(
        Object.entries(message.keywords).filter(([, on]) => on),
      )
      const result = await method(jmap, mailbox, "Email/import", {
        emails: {
          m: {
            blobId,
            mailboxIds: { [folderId]: true },
            keywords,
            receivedAt: utcDate(message.receivedAt),
          },
        },
      })

      const refused = ((result.notCreated ?? {}) as Record<string, { type?: string }>).m
      if (!refused) return
      // `alreadyExists` is a retry's footprint, not a failure.
      if (refused.type === "alreadyExists") return
      if (refused.type === "overQuota") {
        throw new JmapAsError("over_quota", "the mailbox is over its quota")
      }
      // One message the server will not take must not end hours of import.
      skipped++
      deps.log?.warn(
        { jobId: jobData.jobId, entry: message.entry, type: refused.type },
        "mailbox import skipped a message",
      )
    }

    for await (const item of readArchive(store.read(archiveKey), limits)) {
      if (item.type === "manifest") {
        manifestFolders = item.manifest.folders
        continue
      }
      await importOne(item.message)
      processed++

      if (processed % batchSize === 0) {
        await patch({
          processedMessages: processed,
          processedFolders: resolver.used.size,
        })
        if (pauseMs > 0) await sleep(pauseMs)
      }
    }

    // Folders the export had but no message went to: still part of the mailbox.
    for (const folder of manifestFolders)
      await resolver.resolve(folder.path, folder.role)

    await patch({
      status: "completed",
      totalMessages: processed,
      processedMessages: processed,
      totalFolders: resolver.used.size,
      processedFolders: resolver.used.size,
      objectKey: null,
      completedAt: new Date(),
      ...(skipped > 0
        ? {
            error: `${skipped} message${skipped === 1 ? " was" : "s were"} skipped because the mail server would not take them.`,
            errorCode: "skipped_messages",
          }
        : {}),
    })
    await store.delete(archiveKey)
  } catch (error) {
    await fail(jobData, deps, error)
    // Customer mail does not sit in the bucket after a job that cannot use it.
    if (archiveKey) {
      await store.delete(archiveKey).catch(() => {})
      await patch({ objectKey: null }).catch(() => {})
    }
    throw error
  }
}
