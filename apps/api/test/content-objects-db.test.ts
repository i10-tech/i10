import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { rewrapTarget, TARGETS } from "../scripts/rewrap-keys.js"
import { putObjects, restoreAttachments } from "../src/content/attachments.js"
import { memoryStore, objectKey } from "../src/content/object-store.js"
import { keyUnder } from "../src/crypto/envelope.js"
import { keyringFromEnv, type Keyring } from "../src/crypto/keyring.js"
import type { Database } from "../src/db/client.js"

/**
 * Sealed files through the real write (`putObjects`) and read
 * (`restoreAttachments`), as `i10_api`, with R2 in memory.
 *
 *   STORAGE_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/content-objects-db.test.ts
 */
const URL = process.env.STORAGE_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const key = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64")}`
const ring = (value: string) => keyringFromEnv("OBJECT_KEYS", value)
const o1 = ring(key("o1", 21))
const rotated = ring(`${key("o2", 22)},${key("o1", 21)}`)
const o2Only = ring(key("o2", 22))

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database
const tenants: string[] = []

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`o-${id.slice(0, 8)}`}, 'T', ${`objects-test-${id}`})`
  tenants.push(id)
  return id
}

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** A file the test has not used before, so each case starts with no object. */
const newFile = () => Buffer.from(`%PDF-1.7 invoice ${crypto.randomUUID()} `.repeat(40))

const store = (keys: Keyring) => Object.assign(memoryStore(), { objectKeys: keys })

const put = (t: string, s: ReturnType<typeof store>, bytes: Uint8Array) =>
  putObjects(t, new Map([[sha256(bytes), { bytes }]]), {
    db,
    store: s,
    keys: s.objectKeys!,
  })

/** What a retry would send: the file back through the worker's own read. */
const readBack = async (t: string, s: ReturnType<typeof store>, bytes: Uint8Array) => {
  const [back] = (await restoreAttachments(db, s, t, [
    { filename: "invoice.pdf", size: bytes.byteLength, sha256: sha256(bytes) },
  ]))!
  return Buffer.from(back!.content, "base64")
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "",
    (error: Error) => error.message,
  )

const sealedKeys = async (t: string) =>
  (
    await owner<{ sealed_key: string }[]>`
      select sealed_key from core.content_objects where tenant_id = ${t}`
  ).map((r) => r.sealed_key)

suite("sealed files in R2, as i10_api", () => {
  beforeAll(() => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle({ client: app }) as unknown as Database
  })
  afterAll(async () => {
    if (tenants.length) {
      await owner`delete from core.content_objects where tenant_id = any(${tenants})`
      await owner`delete from core.tenants where id = any(${tenants})`
    }
    await owner.end()
    await app.end()
  })

  it("round trips byte for byte, and what R2 holds is not the file", async () => {
    const t = await workspace()
    const s = store(o1)
    const bytes = newFile()
    expect(await put(t, s, bytes)).toEqual({ uploaded: 1, reused: 0 })

    const inR2 = Buffer.from(s.objects.get(objectKey(t, sha256(bytes)))!)
    expect(inR2.equals(bytes)).toBe(false)
    expect(inR2.includes(bytes.subarray(0, 32))).toBe(false)
    expect((await readBack(t, s, bytes)).equals(bytes)).toBe(true)
  })

  it("stores the same file once, with one key", async () => {
    const t = await workspace()
    const s = store(o1)
    const bytes = newFile()
    await put(t, s, bytes)
    const [first] = await sealedKeys(t)
    expect(await put(t, s, bytes)).toEqual({ uploaded: 0, reused: 1 })
    expect(s.puts).toBe(1)
    expect(await sealedKeys(t)).toEqual([first!])
  })

  it("two first uploads at once end with one row whose key opens the object", async () => {
    const t = await workspace()
    const s = store(o1)
    const bytes = newFile()
    const results = await Promise.all([put(t, s, bytes), put(t, s, bytes)])
    expect(results.map((r) => r.uploaded).sort()).toEqual([0, 1])
    expect(s.puts).toBe(1)
    expect(await sealedKeys(t)).toHaveLength(1)
    expect((await readBack(t, s, bytes)).equals(bytes)).toBe(true)
  })

  it("is loud when the row has gone, or the bytes were changed", async () => {
    const t = await workspace()
    const s = store(o1)
    const bytes = newFile()
    await put(t, s, bytes)

    const name = objectKey(t, sha256(bytes))
    const good = s.objects.get(name)!
    const bad = Buffer.from(good)
    bad[20] = bad[20]! ^ 1
    s.objects.set(name, bad)
    expect(await failure(readBack(t, s, bytes))).toContain("does not open")
    s.objects.set(name, good)

    // Another workspace holding the same object does not open it.
    const other = await workspace()
    s.objects.set(objectKey(other, sha256(bytes)), good)
    await owner`insert into core.content_objects (tenant_id, sha256, size, sealed_key)
                select ${other}, sha256, size, sealed_key from core.content_objects where tenant_id = ${t}`
    expect(await failure(readBack(other, s, bytes))).toContain("does not open")

    await owner`delete from core.content_objects where tenant_id = ${t}`
    expect(await failure(readBack(t, s, bytes))).toContain("has no key")
    expect(await failure(readBack(t, store(null as never), bytes))).toContain(
      "OBJECT_KEYS is not set",
    )
  })

  it("opens after a new first key and a re-wrap, with the old key removed", async () => {
    const t = await workspace()
    const s = store(o1)
    const bytes = newFile()
    await put(t, s, bytes)

    const objects = TARGETS.find((x) => x.table === "core.content_objects")!
    const report = await rewrapTarget(owner, objects, rotated, { apply: true })
    expect(report.failedRows.filter((f) => f.tenantId === t)).toEqual([])
    for (const k of await sealedKeys(t)) expect(keyUnder(k)).toBe("o2")

    const after = Object.assign(s, { objectKeys: o2Only })
    expect((await readBack(t, after, bytes)).equals(bytes)).toBe(true)
  })
})
