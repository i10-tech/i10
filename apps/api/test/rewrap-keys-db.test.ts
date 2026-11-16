import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { rewrapTarget, TARGETS, type RewrapReport } from "../scripts/rewrap-keys.js"
import { memoryStore, packKey } from "../src/content/object-store.js"
import { restorePacked } from "../src/content/packs.js"
import { sealBody } from "../src/content/seal.js"
import { keyUnder as bodyKeyUnder } from "../src/crypto/envelope.js"
import { keyringFromEnv, type Keyring } from "../src/crypto/keyring.js"
import { newDataKey, wrapKey } from "../src/crypto/envelope.js"
import { EXPORT_KEY } from "../src/mailboxes/sealed-stream.js"

/**
 * The key re-wrap job against a real database: after a rotation, body keys
 * under the old key move to the new one, packed bodies then open through the
 * application's own read path without the old key, a rerun changes nothing,
 * and a key under a kid that is gone is reported rather than rewritten. The
 * same job moves export keys on `mailbox_jobs`; stored files are in
 * test/content-objects-db.test.ts.
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/pack_scratch bun test test/rewrap-keys-db.test.ts
 *
 * ⚠ THE JOB WALKS EVERY ROW IN THE DATABASE, other test files' included, so
 * these assert on this file's own rows and never on whole-table counts.
 */
const URL = process.env.STORAGE_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const key = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64")}`
const ring = (value: string) => keyringFromEnv("CONTENT_KEYS", value)
const k1 = ring(key("k1", 11))
/** After a rotation: k2 is current, k1 still opens. */
const k2 = ring(`${key("k2", 12)},${key("k1", 11)}`)
/** After k1 was removed. */
const k2Only = ring(key("k2", 12))
/** A key that was dropped before its bodies moved. */
const k0 = ring(key("k0", 10))

const bodiesTarget = TARGETS.find((t) => t.table === "core.message_bodies")!
const jobsTarget = TARGETS.find((t) => t.table === "core.mailbox_jobs")!
const rewrapBodyKeys = (
  sql: ReturnType<typeof postgres>,
  keys: Keyring,
  opts: { apply: boolean; batchSize?: number },
) => rewrapTarget(sql, bodiesTarget, keys, opts)

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
const tenants: string[] = []
const store = memoryStore()

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`r-${id.slice(0, 8)}`}, 'T', ${`rewrap-test-${id}`})`
  tenants.push(id)
  return id
}

interface Seeded {
  messageId: string
  packId: string
  body: { html: string; text: string }
}

/** Packed bodies, each in a pack of its own in `store`, sealed under `sealing`. */
async function packedBodies(tenantId: string, n: number, sealing = k1) {
  const seeded: Seeded[] = []
  for (let i = 0; i < n; i++) {
    const messageId = crypto.randomUUID()
    const body = { html: `<p>body ${i}</p>`, text: `body ${i}` }
    const sealed = sealBody(sealing, { tenantId, messageId }, body)
    const packId = crypto.randomUUID()
    await store.put(packKey(tenantId, packId), new Uint8Array(sealed.record))
    // ⚠ `created_at` STAYS IN SQL, with its microseconds: through a JS Date it
    // would lose them, and the cursor bug this file guards would not show.
    await owner`
      with m as (
        insert into core.messages (id, tenant_id, created_at, from_address, to_addresses, subject, status, queue, sent_at)
        values (${messageId}, ${tenantId}, now() - make_interval(secs => ${i} + 0.123456), 'shop@acme.com',
                '{a@example.com}', 's', 'sent', 'transactional', now())
        returning id, created_at, tenant_id
      )
      insert into core.message_bodies (message_id, created_at, tenant_id, pack_id, pack_offset, pack_length, body_key, packed_at)
      select id, created_at, tenant_id, ${packId}, 0, ${sealed.record.byteLength}, ${sealed.wrappedKey}, now() from m`
    seeded.push({ messageId, packId, body })
  }
  return seeded
}

async function storedKeys(tenantId: string) {
  const rows = await owner<{ body_key: string }[]>`
    select body_key from core.message_bodies where tenant_id = ${tenantId} order by message_id`
  return rows.map((r) => r.body_key)
}

/** What the application opens for these rows, through its own read path. */
async function appView(keys: typeof k1, tenantId: string) {
  const rows = await owner<
    {
      message_id: string
      pack_id: string
      pack_offset: string
      pack_length: number
      body_key: string
    }[]
  >`select message_id, pack_id, pack_offset, pack_length, body_key
      from core.message_bodies where tenant_id = ${tenantId} order by message_id`
  const opened = await restorePacked(
    Object.assign(store, { keys }),
    tenantId,
    rows.map((r) => ({
      messageId: r.message_id,
      html: null as string | null,
      text: null as string | null,
      packId: r.pack_id,
      packOffset: r.pack_offset,
      packLength: r.pack_length,
      bodyKey: r.body_key,
    })),
  )
  return opened.map((r) => ({
    messageId: r.messageId,
    body: { html: r.html, text: r.text },
  }))
}

const byMessage = (seeded: Seeded[]) =>
  seeded
    .map(({ messageId, body }) => ({ messageId, body }))
    .sort((a, b) => (a.messageId < b.messageId ? -1 : 1))

const failedIn = (report: RewrapReport, tenantId: string) =>
  report.failedRows.filter((f) => f.tenantId === tenantId).map((f) => f.messageId)

suite("re-wrapping every body key", () => {
  beforeAll(() => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 2, onnotice: () => {} })
  })
  afterAll(async () => {
    if (tenants.length) {
      await owner`delete from core.mailbox_jobs where tenant_id = any(${tenants})`
      await owner`delete from core.message_bodies where tenant_id = any(${tenants})`
      await owner`delete from core.messages where tenant_id = any(${tenants})`
      await owner`delete from core.tenants where id = any(${tenants})`
    }
    await owner.end()
    await app.end()
  })

  it("dry run counts and writes nothing", async () => {
    const t = await workspace()
    await packedBodies(t, 2)
    const before = await storedKeys(t)

    const report = await rewrapBodyKeys(owner, k2, { apply: false })

    expect(await storedKeys(t)).toEqual(before)
    expect(report.kids.k1).toBeGreaterThanOrEqual(2)
    expect(report.rewrapped).toBe(0)
    expect(failedIn(report, t)).toEqual([])
  })

  it("moves every key onto a new first key across many batches, and the bodies open without the old one", async () => {
    const t = await workspace()
    const seeded = await packedBodies(t, 5)

    const report = await rewrapBodyKeys(owner, k2, { apply: true, batchSize: 2 })

    expect(report.rewrapped).toBeGreaterThanOrEqual(5)
    expect(failedIn(report, t)).toEqual([])
    for (const value of await storedKeys(t)) expect(bodyKeyUnder(value)).toBe("k2")
    expect(await appView(k2Only, t)).toEqual(byMessage(seeded))

    // A second run finds nothing stale and rewrites nothing.
    const after = await storedKeys(t)
    await rewrapBodyKeys(owner, k2, { apply: true, batchSize: 2 })
    expect(await storedKeys(t)).toEqual(after)
  })

  it("reads each row exactly once across batches, on keys with microseconds", async () => {
    const t = await workspace()
    await packedBodies(t, 3)
    // ⚠ THE ONE WHOLE-TABLE NUMBER HERE, compared with itself: the cursor once
    // lost the microseconds, read the last row of each batch twice and never
    // passed the last row of the table.
    const [total] = await owner<{ n: number }[]>`
      select count(*)::int as n from core.message_bodies`

    const report = await rewrapBodyKeys(owner, k2, { apply: false, batchSize: 2 })

    expect(report.scanned).toBe(total!.n)
  })

  it("reports keys under a kid that is no longer in the ring, and leaves them", async () => {
    const t = await workspace()
    const seeded = await packedBodies(t, 2, k0)
    const before = await storedKeys(t)

    const report = await rewrapBodyKeys(owner, k2, { apply: true })

    expect(failedIn(report, t).sort()).toEqual(seeded.map((s) => s.messageId).sort())
    expect(await storedKeys(t)).toEqual(before)
  })

  it("moves export keys on mailbox_jobs too, and leaves imports, which have none", async () => {
    const t = await workspace()
    const o1 = keyringFromEnv("OBJECT_KEYS", key("o1", 31))
    const o2 = keyringFromEnv("OBJECT_KEYS", `${key("o2", 32)},${key("o1", 31)}`)
    const [exp] = await owner<{ id: string }[]>`
      insert into core.mailbox_jobs (tenant_id, mailbox_address, type, status, requested_by)
      values (${t}, 'a@x.test', 'export', 'completed', 'u'), (${t}, 'a@x.test', 'import', 'completed', 'u')
      returning id`
    const dataKey = newDataKey()
    const ids = { tenantId: t, jobId: exp!.id }
    await owner`update core.mailbox_jobs set sealed_key = ${wrapKey(EXPORT_KEY, o1, ids, dataKey)} where id = ${exp!.id}`

    const report = await rewrapTarget(owner, jobsTarget, o2, {
      apply: true,
      batchSize: 1,
    })

    expect(report.failedRows.filter((f) => f.tenantId === t)).toEqual([])
    expect(report.nulls).toBeGreaterThanOrEqual(1)
    const [row] = await owner<{ sealed_key: string }[]>`
      select sealed_key from core.mailbox_jobs where id = ${exp!.id}`
    expect(bodyKeyUnder(row!.sealed_key)).toBe("o2")
  })

  it("refuses to run as a role that row level security filters", async () => {
    await rewrapBodyKeys(app, k2, { apply: false }).then(
      () => {
        throw new Error("expected a refusal")
      },
      (error: Error) => expect(error.message).toContain("cannot see every row"),
    )
  })
})
