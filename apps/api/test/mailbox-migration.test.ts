import { describe, expect, it } from "bun:test"
import { zipSync } from "fflate"
import { memoryStore, type StreamingObjectStore } from "../src/content/object-store.js"
import { LIMITS } from "../src/mailboxes/archive.js"
import { sweepMailboxArchives } from "../src/mailboxes/jobs.js"
import {
  exportKey,
  importKey,
  runMailboxExport,
  runMailboxImport,
  type MigrationDeps,
} from "../src/mailboxes/migration.js"
import { enqueueMailboxJob, type MailboxJobData } from "../src/queue/mailbox-queue.js"
import { DEFAULT_FOLDERS, fakeMailbox, type FakeEmail } from "./support/fake-mailbox.js"
import { memoryJobStore } from "./support/job-store.js"

const TENANT = "00000000-0000-4000-8000-000000000001"
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

const mail = (subject: string, body = "hello") =>
  enc(
    `From: a@x.test\r\nSubject: ${subject}\r\nDate: Fri, 01 May 2026 12:00:00 +0000\r\n\r\n${body}\r\n`,
  )

function setup(
  options: {
    source?: Parameters<typeof fakeMailbox>[0]
    target?: Parameters<typeof fakeMailbox>[0]
  } = {},
) {
  const jobs = memoryJobStore()
  const store = memoryStore()
  const source = fakeMailbox(options.source)
  const target = fakeMailbox(options.target)
  const deps = (
    jmap: MigrationDeps["jmap"],
    over: Partial<MigrationDeps> = {},
  ): MigrationDeps => ({
    jobs,
    store,
    jmap,
    batchPauseMs: 0,
    ...over,
  })

  const queue = async (
    type: "export" | "import",
    address: string,
    status = "pending" as const,
  ) => {
    const row = await jobs.insert({
      tenantId: TENANT,
      mailboxAddress: address,
      type,
      requestedBy: "user_1",
      status,
    })
    return {
      row,
      data: {
        jobId: row.id,
        tenantId: TENANT,
        mailboxAddress: address,
        type,
      } satisfies MailboxJobData,
    }
  }
  return { jobs, store, source, target, deps, queue }
}

const email = (
  id: string,
  folderId: string,
  subject: string,
  over: Partial<FakeEmail> = {},
): FakeEmail => ({
  id,
  folderId,
  keywords: { $seen: true },
  receivedAt: "2026-05-01T12:00:00Z",
  bytes: mail(subject),
  ...over,
})

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  )

describe("export, then import into another account", () => {
  const folders = [
    ...DEFAULT_FOLDERS,
    { id: "f-work", name: "Work" },
    { id: "f-2026", name: "2026", parentId: "f-work" },
    { id: "f-empty", name: "Empty" },
  ]
  const emails = [
    email("e1", "f-inbox", "one", {
      keywords: { $seen: true, $flagged: true },
      receivedAt: "2026-05-01T12:00:00Z",
    }),
    email("e2", "f-inbox", "two", { keywords: {}, receivedAt: "2026-05-03T08:30:15Z" }),
    email("e3", "f-sent", "three", { keywords: { $seen: true, $answered: true } }),
    email("e4", "f-2026", "four", {
      keywords: { $draft: true },
      receivedAt: "2026-04-01T00:00:00Z",
    }),
  ]

  it("keeps folders (nested and empty), counts, flags, dates and the bytes", async () => {
    const t = setup({ source: { folders, emails } })

    const out = await t.queue("export", "alice@acme.test")
    await runMailboxExport(out.data, t.deps(t.source.client))

    const exported = t.jobs.rows.get(out.row.id)!
    expect(exported.status).toBe("completed")
    expect(exported.objectKey).toBe(exportKey(TENANT, out.row.id))
    expect(exported.processedMessages).toBe(4)
    expect(exported.totalMessages).toBe(4)
    expect(exported.processedFolders).toBe(exported.totalFolders)
    expect(exported.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    expect(t.store.objects.has(exported.objectKey!)).toBe(true)

    // The archive travels to the other account the way a download and an upload do.
    const inn = await t.queue("import", "bob@acme.test")
    const key = importKey(TENANT, inn.row.id)
    t.store.objects.set(key, t.store.objects.get(exported.objectKey!)!)
    await t.jobs.update(TENANT, inn.row.id, { objectKey: key })
    await runMailboxImport(inn.data, t.deps(t.target.client))

    const imported = t.jobs.rows.get(inn.row.id)!
    expect(imported.status).toBe("completed")
    expect(imported.processedMessages).toBe(4)
    expect(imported.errorCode).toBeNull()
    // The uploaded archive does not outlive the job.
    expect(t.store.objects.has(key)).toBe(false)
    expect(imported.objectKey).toBeNull()

    const byPath = Object.fromEntries(t.target.tree().map((f) => [f.path, f]))
    // Standard folders are matched by role, not created again.
    expect(
      byPath["Inbox"]!.emails.map((e) => dec(e.bytes as Uint8Array).split("\r\n")[1]),
    ).toEqual(["Subject: one", "Subject: two"])
    expect(byPath["Sent Items"]!.emails).toHaveLength(1)
    // Folders that did not exist are created, nested ones under their parent.
    expect(byPath["Work/2026"]!.emails).toHaveLength(1)
    expect(Object.keys(byPath)).toContain("Empty")
    expect(t.target.tree().filter((f) => f.path === "Inbox")).toHaveLength(1)

    const flags = (path: string) => byPath[path]!.emails.map((e) => e.keywords)
    expect(flags("Inbox")).toEqual([{ $seen: true, $flagged: true }, {}])
    expect(flags("Sent Items")).toEqual([{ $seen: true, $answered: true }])
    expect(flags("Work/2026")).toEqual([{ $draft: true }])
    expect(byPath["Inbox"]!.emails.map((e) => e.receivedAt)).toEqual([
      "2026-05-01T12:00:00Z",
      "2026-05-03T08:30:15Z",
    ])
    expect(byPath["Work/2026"]!.emails[0]!.bytes).toEqual(mail("four"))
  })

  it("counts a message deleted during the export as gone, not as a failure", async () => {
    const t = setup({
      source: { folders, emails, missingBlobs: new Set(["blob-e2"]) },
    })
    const out = await t.queue("export", "alice@acme.test")
    await runMailboxExport(out.data, t.deps(t.source.client))
    const row = t.jobs.rows.get(out.row.id)!
    expect(row.status).toBe("completed")
    expect(row.processedMessages).toBe(3)

    // And the archive is still a complete one: its manifest agrees with its contents.
    const inn = await t.queue("import", "bob@acme.test")
    const key = importKey(TENANT, inn.row.id)
    t.store.objects.set(key, t.store.objects.get(row.objectKey!)!)
    await t.jobs.update(TENANT, inn.row.id, { objectKey: key })
    await runMailboxImport(inn.data, t.deps(t.target.client))
    expect(t.jobs.rows.get(inn.row.id)!.status).toBe("completed")
    expect(t.jobs.rows.get(inn.row.id)!.processedMessages).toBe(3)
  })
})

describe("export memory", () => {
  it("streams: the archive reaches the store in many chunks, and the mailbox is never held", async () => {
    const MESSAGES = 120
    const CHUNKS = 8
    const CHUNK = 64 * 1024
    const total = MESSAGES * CHUNKS * CHUNK // 60 MiB

    const base = memoryStore()
    const sink = { chunks: 0, bytes: 0 }
    const store: StreamingObjectStore = {
      ...base,
      // The store keeps nothing: what it received is the measure.
      open: () => ({
        async write(chunk) {
          sink.chunks++
          sink.bytes += chunk.byteLength
        },
        async end() {},
      }),
    }

    let produced = 0
    let peak = 0
    const note = () => (peak = Math.max(peak, produced - sink.bytes))
    // Random bytes do not compress, so what the store has received tracks what
    // was read from the mailbox to within the archive's own overhead.
    const piece = () => {
      const bytes = new Uint8Array(CHUNK)
      for (let at = 0; at < CHUNK; at += 65_536)
        crypto.getRandomValues(bytes.subarray(at, at + 65_536))
      return bytes
    }
    const emails: FakeEmail[] = Array.from({ length: MESSAGES }, (_, i) => ({
      id: `big-${i}`,
      folderId: "f-inbox",
      keywords: { $seen: true },
      receivedAt: `2026-05-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
      bytes: {
        size: CHUNKS * CHUNK,
        chunks: CHUNKS,
        chunk: () => {
          produced += CHUNK
          note()
          return piece()
        },
      },
    }))

    const jobs = memoryJobStore()
    const mailbox = fakeMailbox({ emails })
    const row = await jobs.insert({
      tenantId: TENANT,
      mailboxAddress: "alice@acme.test",
      type: "export",
      requestedBy: "u",
      status: "pending",
    })
    await runMailboxExport(
      {
        jobId: row.id,
        tenantId: TENANT,
        mailboxAddress: "alice@acme.test",
        type: "export",
      },
      { jobs, store, jmap: mailbox.client, batchPauseMs: 0 },
    )

    expect(jobs.rows.get(row.id)!.status).toBe("completed")
    expect(jobs.rows.get(row.id)!.processedMessages).toBe(MESSAGES)
    expect(produced).toBe(total)
    expect(sink.bytes).toBeGreaterThan(total)
    expect(sink.chunks).toBeGreaterThan(100)
    // The most that was in flight between Stalwart and the store at any moment.
    // The mailbox is 60 MiB; one message is 512 KiB.
    console.log(
      `peak in flight: ${(peak / 1024 / 1024).toFixed(2)} MiB of ${total / 1024 / 1024} MiB`,
    )
    expect(peak).toBeLessThan(4 * 1024 * 1024)
  })
})

describe("import", () => {
  async function importing(
    archive: Uint8Array,
    options: Parameters<typeof setup>[0] = {},
    deps: Partial<MigrationDeps> = {},
  ) {
    const t = setup(options)
    const job = await t.queue("import", "bob@acme.test")
    const key = importKey(TENANT, job.row.id)
    t.store.objects.set(key, archive)
    await t.jobs.update(TENANT, job.row.id, { objectKey: key })
    const error = await failureOf(
      runMailboxImport(job.data, t.deps(t.target.client, deps)),
    )
    return { ...t, job, key, error, row: () => t.jobs.rows.get(job.row.id)! }
  }

  const takeout = zipSync({
    "Takeout/Mail/Inbox.mbox": enc(
      "From a@x.test x\nSubject: one\n\nhi\n\nFrom b@x.test x\nSubject: two\n\nyo\n",
    ),
    "Takeout/Mail/Sent.mbox": enc("From c@x.test x\nSubject: three\n\nsent\n"),
    "Takeout/Mail/Receipts.mbox": enc("From d@x.test x\nSubject: four\n\nr\n"),
  })

  it("takes a Google Takeout: Inbox and Sent land in the standard folders, labels become folders", async () => {
    const r = await importing(takeout)
    expect(r.error).toBeNull()
    expect(r.row().status).toBe("completed")
    expect(r.row().processedMessages).toBe(4)
    const byPath = Object.fromEntries(
      r.target.tree().map((f) => [f.path, f.emails.length]),
    )
    expect(byPath).toMatchObject({ Inbox: 2, "Sent Items": 1, Receipts: 1 })
    expect(r.target.tree().some((f) => f.path === "Sent")).toBe(false)
  })

  it("writes progress at every batch, and pauses between them", async () => {
    const r = await importing(takeout, {}, { batchSize: 2, batchPauseMs: 25 })
    const progress = r.jobs.updates
      .filter(
        (u) => u.patch.processedMessages !== undefined && u.patch.status === undefined,
      )
      .map((u) => u.patch.processedMessages)
    expect(progress).toEqual([2, 4])
  })

  it("fails over quota as over_quota, keeps what was imported, and deletes the upload", async () => {
    const r = await importing(takeout, { target: { quotaBytes: 80 } })
    expect(r.row().status).toBe("failed")
    expect(r.row().errorCode).toBe("over_quota")
    expect(r.row().error).toContain("quota")
    expect(r.error).toBeDefined()
    // What fitted is in; nothing is rolled back, and nothing retried.
    expect(r.target.emails.length).toBeGreaterThan(0)
    expect(r.target.emails.length).toBeLessThan(4)
    expect(r.store.objects.has(r.key)).toBe(false)
  })

  it("fails a message over the cap naming it, from the archive's cap and from the server's", async () => {
    const big = zipSync({
      "Big/huge.eml": enc(`Subject: big\r\n\r\n${"x".repeat(3000)}\r\n`),
    })
    const ours = await importing(
      big,
      {},
      { limits: { ...LIMITS, maxMessageBytes: 1000 } },
    )
    expect(ours.row().status).toBe("failed")
    expect(ours.row().errorCode).toBe("message_too_large")
    expect(ours.row().error).toContain("Big/huge.eml")
    expect(ours.target.log.uploads).toBe(0)

    const theirs = await importing(big, { target: { maxMessageBytes: 1000 } })
    expect(theirs.row().errorCode).toBe("message_too_large")
    expect(theirs.row().error).toContain("Big/huge.eml")
  })

  it("fails an archive over the cap before reading it", async () => {
    const r = await importing(
      takeout,
      {},
      { limits: { ...LIMITS, maxArchiveBytes: 100 } },
    )
    expect(r.row().status).toBe("failed")
    expect(r.row().errorCode).toBe("archive_too_large")
    expect(r.target.log.uploads).toBe(0)
    expect(r.store.objects.has(r.key)).toBe(false)
  })

  it("fails an upload that never arrived", async () => {
    const t = setup()
    const job = await t.queue("import", "bob@acme.test")
    await t.jobs.update(TENANT, job.row.id, {
      objectKey: importKey(TENANT, job.row.id),
    })
    await failureOf(runMailboxImport(job.data, t.deps(t.target.client)))
    expect(t.jobs.rows.get(job.row.id)!.errorCode).toBe("archive_invalid")
  })

  it("finishes with a note when the server refuses single messages, instead of failing hours of work", async () => {
    const r = await importing(takeout, {
      target: {
        refuse: (bytes) => (dec(bytes).includes("three") ? "invalidEmail" : null),
      },
    })
    expect(r.row().status).toBe("completed")
    expect(r.row().processedMessages).toBe(4)
    expect(r.row().errorCode).toBe("skipped_messages")
    expect(r.row().error).toContain("1 message was skipped")
    expect(r.target.emails).toHaveLength(3)
  })

  it("does not run a job twice when the queue redelivers it", async () => {
    const r = await importing(takeout)
    const before = r.target.log.uploads
    await runMailboxImport(r.job.data, r.deps(r.target.client))
    expect(r.target.log.uploads).toBe(before)
  })
})

describe("the queue and the sweep", () => {
  it("queues every job under its mailbox, lowercased, so one mailbox runs one at a time", async () => {
    const added: unknown[] = []
    await enqueueMailboxJob(
      { add: async (options: unknown) => void added.push(options) } as never,
      {
        jobId: "j1",
        tenantId: TENANT,
        mailboxAddress: "Alice@Acme.Test",
        type: "export",
      },
    )
    expect(added).toEqual([
      expect.objectContaining({ groupId: "alice@acme.test", jobId: "mbx:j1" }),
    ])
  })

  it("deletes an expired export's archive and an abandoned upload, and nothing live", async () => {
    const jobs = memoryJobStore()
    const store = memoryStore()
    const row = async (type: "export" | "import", key: string, patch = {}) => {
      const r = await jobs.insert({
        tenantId: TENANT,
        mailboxAddress: "a@x.test",
        type,
        requestedBy: "u",
        status: "completed",
      })
      await jobs.update(TENANT, r.id, { objectKey: key, ...patch })
      store.objects.set(key, new Uint8Array([1]))
      return r
    }
    const now = new Date("2026-11-20T00:00:00Z")
    await row("export", "old-export", { expiresAt: new Date("2026-11-10T00:00:00Z") })
    await row("export", "live-export", { expiresAt: new Date("2026-11-25T00:00:00Z") })
    const abandoned = await row("import", "abandoned-upload")
    // The in-memory clock stamps rows "now"; the abandoned one is old.
    jobs.rows.set(abandoned.id, {
      ...jobs.rows.get(abandoned.id)!,
      updatedAt: new Date("2026-11-10T00:00:00Z"),
    })

    expect(await sweepMailboxArchives(jobs, store, TENANT, now)).toBe(2)
    expect([...store.objects.keys()].sort()).toEqual(["live-export"])
    expect([...jobs.rows.values()].filter((r) => r.objectKey !== null)).toHaveLength(1)
  })
})
