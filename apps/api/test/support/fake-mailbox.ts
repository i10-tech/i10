import {
  JmapAsError,
  type JmapMethod,
  type JmapResponse,
} from "../../src/mail/jmap-as.js"
import { fakeJmapClient } from "./jmap-client.js"

/**
 * A Stalwart account, enough of it for an export and an import to run against:
 * mailboxes (folders), emails with keywords and dates, blobs, and the three ways
 * the real one says no (full, too large, nothing to find).
 */

export interface FakeEmail {
  id: string
  folderId: string
  keywords: Record<string, boolean>
  receivedAt: string
  /** The message, or how to produce it a piece at a time. */
  bytes: Uint8Array | { size: number; chunk: (i: number) => Uint8Array; chunks: number }
}

export interface FakeFolder {
  id: string
  name: string
  parentId?: string
  role?: string
}

export const DEFAULT_FOLDERS: FakeFolder[] = [
  { id: "f-inbox", name: "Inbox", role: "inbox" },
  { id: "f-sent", name: "Sent Items", role: "sent" },
  { id: "f-drafts", name: "Drafts", role: "drafts" },
  { id: "f-trash", name: "Deleted Items", role: "trash" },
]

export function fakeMailbox(
  options: {
    folders?: FakeFolder[]
    emails?: FakeEmail[]
    /** Total bytes the account will hold before it answers over quota. */
    quotaBytes?: number
    /** The server's per-message ceiling. */
    maxMessageBytes?: number
    /** Blob ids that vanished since they were listed. */
    missingBlobs?: Set<string>
    /** Email/import answers a message with this notCreated type. */
    refuse?: (bytes: Uint8Array) => string | null
  } = {},
) {
  const folders = [...(options.folders ?? DEFAULT_FOLDERS)]
  const emails = [...(options.emails ?? [])]
  const uploads = new Map<string, Uint8Array>()
  const sizeOf = (e: FakeEmail) =>
    e.bytes instanceof Uint8Array ? e.bytes.byteLength : e.bytes.size
  let counter = 0
  let used = emails.reduce((n, e) => n + sizeOf(e), 0)
  const log = { methods: [] as string[], uploads: 0, downloads: 0 }

  const answer = (
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> => {
    switch (name) {
      case "Mailbox/get":
        return {
          list: folders.map((f) => ({
            ...f,
            totalEmails: emails.filter((e) => e.folderId === f.id).length,
          })),
        }
      case "Mailbox/set": {
        const create = args.create as Record<
          string,
          { name: string; parentId?: string }
        >
        const created: Record<string, { id: string }> = {}
        for (const [key, value] of Object.entries(create)) {
          const id = `f-new-${++counter}`
          folders.push({ id, name: value.name, parentId: value.parentId })
          created[key] = { id }
        }
        return { created }
      }
      case "Email/query": {
        const filter = args.filter as { inMailbox: string }
        const position = Number(args.position ?? 0)
        const limit = Number(args.limit ?? 100)
        const inFolder = emails
          .filter((e) => e.folderId === filter.inMailbox)
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
        return { ids: inFolder.slice(position, position + limit).map((e) => e.id) }
      }
      case "Email/get": {
        const ids = args.ids as string[]
        return {
          list: emails
            .filter((e) => ids.includes(e.id))
            .map((e) => ({
              id: e.id,
              blobId: `blob-${e.id}`,
              keywords: e.keywords,
              receivedAt: e.receivedAt,
              size: sizeOf(e),
            })),
        }
      }
      case "Email/import": {
        const spec = (args.emails as Record<string, Record<string, unknown>>).m!
        const bytes = uploads.get(String(spec.blobId))!
        const refused = options.refuse?.(bytes)
        if (refused) return { notCreated: { m: { type: refused } } }
        if (
          options.quotaBytes !== undefined &&
          used + bytes.byteLength > options.quotaBytes
        ) {
          return { notCreated: { m: { type: "overQuota" } } }
        }
        used += bytes.byteLength
        const folderId = Object.keys(spec.mailboxIds as object)[0]!
        emails.push({
          id: `e-new-${++counter}`,
          folderId,
          keywords: spec.keywords as Record<string, boolean>,
          receivedAt: String(spec.receivedAt),
          bytes,
        })
        return { created: { m: { id: `e-new-${counter}` } } }
      }
      default:
        throw new Error(`the fake mailbox does not know ${name}`)
    }
  }

  const client = fakeJmapClient({
    async call(_mailbox, methods: readonly JmapMethod[]): Promise<JmapResponse[]> {
      return methods.map(([name, args, id]) => {
        log.methods.push(name)
        return [name, answer(name, args), id]
      })
    },

    async downloadBlob(_mailbox, blobId) {
      log.downloads++
      if (options.missingBlobs?.has(blobId)) throw new JmapAsError("not_found", "gone")
      const email = emails.find((e) => `blob-${e.id}` === blobId)!
      const { bytes } = email
      if (bytes instanceof Uint8Array) {
        return {
          body: new Response(bytes as Uint8Array<ArrayBuffer>).body!,
          size: bytes.byteLength,
        }
      }
      let i = 0
      return {
        size: bytes.size,
        // Pulled one piece at a time, so a test can see how far ahead it is read.
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (i >= bytes.chunks) return controller.close()
              controller.enqueue(bytes.chunk(i++))
            },
          },
          { highWaterMark: 0 },
        ),
      }
    },

    async uploadBlob(_mailbox, bytes) {
      log.uploads++
      if (
        options.maxMessageBytes !== undefined &&
        bytes.byteLength > options.maxMessageBytes
      ) {
        throw new JmapAsError("too_large", "too large")
      }
      if (
        options.quotaBytes !== undefined &&
        used + bytes.byteLength > options.quotaBytes
      ) {
        throw new JmapAsError("over_quota", "the mailbox is over its quota")
      }
      const blobId = `up-${++counter}`
      uploads.set(blobId, bytes.slice())
      return { blobId, size: bytes.byteLength }
    },
  })

  /** Every folder as `Parent/Child`, with its emails. */
  const tree = () => {
    const path = (f: FakeFolder): string[] => {
      const parent = folders.find((p) => p.id === f.parentId)
      return [...(parent ? path(parent) : []), f.name]
    }
    return folders.map((f) => ({
      path: path(f).join("/"),
      role: f.role ?? null,
      emails: emails.filter((e) => e.folderId === f.id),
    }))
  }

  return { client, folders, emails, tree, log }
}
