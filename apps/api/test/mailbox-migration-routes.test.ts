import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import { memoryStore } from "../src/content/object-store.js"
import { LIMITS } from "../src/mailboxes/archive.js"
import {
  decideAccess,
  signDownloadToken,
  verifyDownloadToken,
  type AdminChecker,
  type MailboxAccessFacts,
} from "../src/mailboxes/jobs.js"
import { exportKey, importKey } from "../src/mailboxes/migration.js"
import type { SessionVerifier } from "../src/middleware/session.js"
import type { MailboxMigrationDeps } from "../src/routes/mailbox-migration.js"
import type { MailboxJobData } from "../src/queue/mailbox-queue.js"
import { memoryJobStore } from "./support/job-store.js"

const TENANT = "00000000-0000-4000-8000-000000000001"
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002"
const SECRET = "test-secret-at-least-32-chars-long-123456"
const ADDRESS = "alice@acme.test"

const OWNER = "user_owner"
const WORKSPACE_OWNER = "user_ws_owner"
const ADMIN = "user_admin"
const MEMBER = "user_member"

const facts: MailboxAccessFacts = {
  mailboxOwner: OWNER,
  tenantId: TENANT,
  tenantOwner: WORKSPACE_OWNER,
  clerkOrgId: "org_1",
}
const adminChecker: AdminChecker = {
  isAdmin: async (userId, tenantId) => userId === ADMIN && tenantId === TENANT,
}

function build(over: Partial<MailboxMigrationDeps> = {}) {
  const jobs = memoryJobStore()
  const store = memoryStore()
  const queued: MailboxJobData[] = []
  const deps: MailboxMigrationDeps = {
    jobs,
    store,
    enqueue: async (data) => void queued.push(data),
    access: (userId, address) =>
      decideAccess(address === ADDRESS ? facts : null, userId, adminChecker),
    tokenSecret: SECRET,
    ...over,
  }
  // The signed-in user is named by a header, which is all a session fake needs.
  const sessions: SessionVerifier = {
    verify: async (request) => {
      const user = request.headers.get("x-user")
      return user ? { status: "signed-in", userId: user } : { status: "signed-out" }
    },
  }
  const app = createApp({ sessionAuth: sessions, mailboxMigration: deps })
  const call = (method: string, path: string, user?: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(user ? { "x-user": user } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  return { jobs, store, queued, deps, call }
}

const completedExport = async (t: ReturnType<typeof build>, patch = {}) => {
  const row = await t.jobs.insert({
    tenantId: TENANT,
    mailboxAddress: ADDRESS,
    type: "export",
    requestedBy: OWNER,
    status: "completed",
  })
  const key = exportKey(TENANT, row.id)
  t.store.objects.set(key, new Uint8Array([1, 2, 3, 4, 5]))
  await t.jobs.update(TENANT, row.id, {
    objectKey: key,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...patch,
  })
  return row
}

const linkOf = async (t: ReturnType<typeof build>) => {
  const res = await t.call("GET", `/mailboxes/${ADDRESS}/export`, OWNER)
  return ((await res.json()) as { download_url: string | null }).download_url
}

describe("who may move a mailbox's mail", () => {
  it("allows the mailbox's owner, the workspace's owner and an admin, and no other member", async () => {
    const decide = (user: string) => decideAccess(facts, user, adminChecker)
    expect(await decide(OWNER)).toEqual({ allowed: true, tenantId: TENANT })
    expect(await decide(WORKSPACE_OWNER)).toEqual({ allowed: true, tenantId: TENANT })
    expect(await decide(ADMIN)).toEqual({ allowed: true, tenantId: TENANT })
    expect(await decide(MEMBER)).toEqual({
      allowed: false,
      reason: "forbidden",
      tenantId: TENANT,
    })
    expect((await decideAccess(null, OWNER, adminChecker)).reason).toBe("not_found")
    // Without an admin check wired, being in the workspace is not enough either.
    expect((await decideAccess(facts, ADMIN)).allowed).toBe(false)
  })

  it("refuses a member on every route, an admin and the owner pass", async () => {
    const t = build()
    const requests = [
      ["POST", `/mailboxes/${ADDRESS}/export`],
      ["GET", `/mailboxes/${ADDRESS}/export`],
      ["POST", `/mailboxes/${ADDRESS}/import`, { size: 10 }],
      ["POST", `/mailboxes/${ADDRESS}/import/${crypto.randomUUID()}/start`],
      ["GET", `/mailboxes/${ADDRESS}/import`],
      ["GET", `/mailboxes/${ADDRESS}/export/download`],
    ] as const

    for (const [method, path, body] of requests) {
      const res = await t.call(method, path, MEMBER, body)
      expect(res.status).toBe(403)
    }
    expect(t.queued).toEqual([])
    expect(t.jobs.rows.size).toBe(0)

    expect((await t.call("POST", `/mailboxes/${ADDRESS}/export`, ADMIN)).status).toBe(
      202,
    )
    expect(
      (await t.call("POST", `/mailboxes/${ADDRESS}/import`, OWNER, { size: 10 }))
        .status,
    ).toBe(201)
    expect(
      (await t.call("POST", "/mailboxes/nobody@acme.test/export", OWNER)).status,
    ).toBe(404)
    expect((await t.call("POST", `/mailboxes/${ADDRESS}/export`)).status).toBe(401)
  })
})

describe("export", () => {
  it("queues one job under the mailbox's group, and a second request is the same job", async () => {
    const t = build()
    const first = (await (
      await t.call("POST", `/mailboxes/${ADDRESS}/export`, OWNER)
    ).json()) as {
      id: string
      status: string
    }
    const second = (await (
      await t.call("POST", `/mailboxes/${ADDRESS}/export`, OWNER)
    ).json()) as {
      id: string
    }
    expect(first.status).toBe("pending")
    expect(second.id).toBe(first.id)
    expect(t.queued).toEqual([
      { jobId: first.id, tenantId: TENANT, mailboxAddress: ADDRESS, type: "export" },
    ])
  })

  it("gives a download link only for a finished, unexpired export", async () => {
    const t = build()
    const row = await completedExport(t)
    expect(await linkOf(t)).toMatch(
      /^\/mailboxes\/alice%40acme\.test\/export\/download\?token=/,
    )

    await t.jobs.update(TENANT, row.id, { expiresAt: new Date(Date.now() - 1000) })
    expect(await linkOf(t)).toBeNull()

    await t.jobs.update(TENANT, row.id, {
      status: "running",
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    expect(await linkOf(t)).toBeNull()
  })
})

describe("the download link", () => {
  const download = (t: ReturnType<typeof build>, link: string) =>
    t.call("GET", link.replace("alice%40acme.test", ADDRESS))

  it("streams the archive to whoever holds a good link, with no session", async () => {
    const t = build()
    await completedExport(t)
    const res = await download(t, (await linkOf(t))!)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/gzip")
    expect(res.headers.get("content-length")).toBe("5")
    expect(res.headers.get("content-disposition")).toContain(
      "alice@acme.test-export.tar.gz",
    )
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5])
  })

  it("serves the owner by session too, and nobody else", async () => {
    const t = build()
    await completedExport(t)
    expect(
      (await t.call("GET", `/mailboxes/${ADDRESS}/export/download`, OWNER)).status,
    ).toBe(200)
    expect((await t.call("GET", `/mailboxes/${ADDRESS}/export/download`)).status).toBe(
      401,
    )
  })

  it("is bound to the tenant and the job: a token cannot be pointed at anyone else's", async () => {
    const t = build()
    const row = await completedExport(t)
    const soon = Date.now() + 60_000

    // The job is the right one, the tenant is not: row-level security finds nothing.
    const wrongTenant = signDownloadToken(
      { tenantId: OTHER_TENANT, jobId: row.id },
      soon,
      SECRET,
    )
    expect(
      (
        await t.call(
          "GET",
          `/mailboxes/${ADDRESS}/export/download?token=${wrongTenant}`,
        )
      ).status,
    ).toBe(404)

    // A real tenant's token for a job that is not theirs.
    const wrongJob = signDownloadToken(
      { tenantId: TENANT, jobId: crypto.randomUUID() },
      soon,
      SECRET,
    )
    expect(
      (await t.call("GET", `/mailboxes/${ADDRESS}/export/download?token=${wrongJob}`))
        .status,
    ).toBe(404)

    // The right token under another mailbox's URL.
    const good = signDownloadToken({ tenantId: TENANT, jobId: row.id }, soon, SECRET)
    expect(
      (await t.call("GET", `/mailboxes/bob@acme.test/export/download?token=${good}`))
        .status,
    ).toBe(404)
    expect(
      (await t.call("GET", `/mailboxes/${ADDRESS}/export/download?token=${good}`))
        .status,
    ).toBe(200)
  })

  it("refuses an expired, forged or foreign token", async () => {
    const t = build()
    const row = await completedExport(t)
    const link = { tenantId: TENANT, jobId: row.id }
    const get = (token: string) =>
      t.call("GET", `/mailboxes/${ADDRESS}/export/download?token=${token}`)

    expect((await get(signDownloadToken(link, Date.now() - 1, SECRET))).status).toBe(
      401,
    )
    expect(
      (
        await get(
          signDownloadToken(
            link,
            Date.now() + 60_000,
            "another-secret-that-is-long-enough!!",
          ),
        )
      ).status,
    ).toBe(401)
    const good = signDownloadToken(link, Date.now() + 60_000, SECRET)
    expect((await get(`${good.slice(0, -3)}AAA`)).status).toBe(401)
    // Extending the expiry invalidates the signature.
    const [tenant, job, , signature] = good.split(".")
    expect(
      (await get([tenant, job, Date.now() + 9e9, signature].join("."))).status,
    ).toBe(401)
    expect((await get("not-a-token")).status).toBe(401)
  })

  it("refuses a job that is not finished, and an export past its expiry", async () => {
    const t = build()
    const row = await completedExport(t)
    const token = () =>
      signDownloadToken(
        { tenantId: TENANT, jobId: row.id },
        Date.now() + 60_000,
        SECRET,
      )
    const get = () =>
      t.call("GET", `/mailboxes/${ADDRESS}/export/download?token=${token()}`)

    await t.jobs.update(TENANT, row.id, { status: "running" })
    expect((await get()).status).toBe(404)

    await t.jobs.update(TENANT, row.id, {
      status: "completed",
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await get()).status).toBe(410)

    // The object itself swept away before the row was updated.
    await t.jobs.update(TENANT, row.id, { expiresAt: new Date(Date.now() + 60_000) })
    t.store.objects.delete(exportKey(TENANT, row.id))
    expect((await get()).status).toBe(410)
  })

  it("verifies in constant time: the comparison is on the digest, not the text", () => {
    const link = { tenantId: TENANT, jobId: "job-1" }
    const token = signDownloadToken(link, 2_000_000_000_000, SECRET)
    expect(verifyDownloadToken(token, SECRET, 1)).toEqual(link)
    // A token of the wrong length is refused without being compared at all.
    expect(verifyDownloadToken(`${token}A`, SECRET, 1)).toBeNull()
    expect(verifyDownloadToken(token.slice(0, -1), SECRET, 1)).toBeNull()
  })
})

describe("import", () => {
  const reserve = async (t: ReturnType<typeof build>, size = 1000) =>
    (await (
      await t.call("POST", `/mailboxes/${ADDRESS}/import`, OWNER, { size })
    ).json()) as {
      id: string
      status: string
      upload: { url: string; method: string; expires_at: string }
    }

  it("reserves an upload straight to storage, under a key the server chose", async () => {
    const t = build()
    const job = await reserve(t)
    expect(job.status).toBe("awaiting_upload")
    expect(job.upload.method).toBe("PUT")
    expect(job.upload.url).toContain(importKey(TENANT, job.id))
    expect(new Date(job.upload.expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(t.queued).toEqual([])
    // Nothing from the client names the key: the body has only a size.
    expect(t.jobs.rows.get(job.id)!.objectKey).toBe(importKey(TENANT, job.id))
  })

  it("refuses an archive over the cap before anything is reserved", async () => {
    const t = build()
    const res = await t.call("POST", `/mailboxes/${ADDRESS}/import`, OWNER, {
      size: LIMITS.maxArchiveBytes + 1,
    })
    expect(res.status).toBe(413)
    expect(t.jobs.rows.size).toBe(0)
    expect(
      (await t.call("POST", `/mailboxes/${ADDRESS}/import`, OWNER, { size: -1 }))
        .status,
    ).toBe(422)
  })

  it("does not start until the archive has arrived, then queues it once", async () => {
    const t = build()
    const job = await reserve(t)
    const start = () =>
      t.call("POST", `/mailboxes/${ADDRESS}/import/${job.id}/start`, OWNER)

    expect((await start()).status).toBe(409)
    expect(t.queued).toEqual([])

    t.store.objects.set(importKey(TENANT, job.id), new Uint8Array(10))
    const started = await start()
    expect(started.status).toBe(202)
    expect(((await started.json()) as { status: string }).status).toBe("pending")
    // Pressed again: the same job, not a second run.
    expect((await start()).status).toBe(202)
    expect(t.queued).toEqual([
      { jobId: job.id, tenantId: TENANT, mailboxAddress: ADDRESS, type: "import" },
    ])
  })

  it("checks the object's real size, because a presigned PUT cannot cap itself", async () => {
    const t = build()
    const job = await reserve(t, 10)
    const key = importKey(TENANT, job.id)
    // Declared 10 bytes; what arrived is over the cap.
    t.store.objects.set(key, new Uint8Array(1))
    t.store.size = async () => LIMITS.maxArchiveBytes + 1

    const res = await t.call(
      "POST",
      `/mailboxes/${ADDRESS}/import/${job.id}/start`,
      OWNER,
    )
    expect(res.status).toBe(413)
    expect(t.queued).toEqual([])
    expect(t.store.objects.has(key)).toBe(false)
    expect(t.jobs.rows.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "archive_too_large",
    })
  })

  it("will not start another mailbox's import or a job that is not an import", async () => {
    const t = build()
    const job = await reserve(t)
    t.store.objects.set(importKey(TENANT, job.id), new Uint8Array(10))
    const exportJob = await completedExport(t)

    expect(
      (
        await t.call(
          "POST",
          `/mailboxes/${ADDRESS}/import/${crypto.randomUUID()}/start`,
          OWNER,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await t.call(
          "POST",
          `/mailboxes/${ADDRESS}/import/${exportJob.id}/start`,
          OWNER,
        )
      ).status,
    ).toBe(404)
    expect(t.queued).toEqual([])
  })
})
