import { describe, expect, it } from "bun:test"
import { memoryStore, packKey, type ContentStore } from "../src/content/object-store.js"
import { BodyCache, restorePacked } from "../src/content/packs.js"
import { BODY_KEY, openBody, sealBody, type BodyIds } from "../src/content/seal.js"
import { keyUnder as bodyKeyUnder, rewrapKey } from "../src/crypto/envelope.js"
import { keyringFromEnv, type Keyring } from "../src/crypto/keyring.js"

const rewrapBodyKey = (ring: Keyring, ids: BodyIds, wrapped: string) =>
  rewrapKey(BODY_KEY, ring, ids, wrapped)

/**
 * Sealing bodies and reading them back out of packs (#188). The database half
 * (packing, releasing, sweeping) is test/content-db.test.ts.
 */
const key = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
const K1 = key()
const K2 = key()
const ring = (value: string) => keyringFromEnv("CONTENT_KEYS", value)
const keys = ring(`k1:${K1}`)
const ids = { tenantId: crypto.randomUUID(), messageId: crypto.randomUUID() }

describe("sealBody", () => {
  it("opens to exactly what was sealed, including nulls and every kind of text", () => {
    for (const body of [
      { html: "<p>hi</p>", text: "hi" },
      { html: null, text: "only text" },
      { html: "<p>only html</p>", text: null },
      { html: "émoji 🎉 \u0003 \r\n\t  trailing  ", text: "" },
      { html: "<p>" + "x".repeat(200_000) + "</p>", text: null },
    ]) {
      const sealed = sealBody(keys, ids, body)
      expect(openBody(keys, ids, sealed.record, sealed.wrappedKey)).toEqual(body)
    }
  })

  it("compresses before it encrypts", () => {
    const html = "<tr><td>row</td></tr>".repeat(5_000)
    const sealed = sealBody(keys, ids, { html, text: null })
    expect(sealed.record.byteLength).toBeLessThan(html.length / 20)
    expect(sealed.record.toString()).not.toContain("<tr>")
  })

  it("uses a new key for every body", () => {
    const a = sealBody(keys, ids, { html: "same", text: null })
    const b = sealBody(keys, ids, { html: "same", text: null })
    expect(a.wrappedKey).not.toBe(b.wrappedKey)
    expect(a.record.equals(b.record)).toBe(false)
  })

  it("will not open on another message or another workspace", () => {
    const sealed = sealBody(keys, ids, { html: "mine", text: null })
    expect(() =>
      openBody(
        keys,
        { ...ids, messageId: crypto.randomUUID() },
        sealed.record,
        sealed.wrappedKey,
      ),
    ).toThrow()
    expect(() =>
      openBody(
        keys,
        { ...ids, tenantId: crypto.randomUUID() },
        sealed.record,
        sealed.wrappedKey,
      ),
    ).toThrow()
  })

  it("refuses a tampered record", () => {
    const sealed = sealBody(keys, ids, { html: "mine", text: null })
    const bad = Buffer.from(sealed.record)
    bad[20] = bad[20]! ^ 1
    expect(() => openBody(keys, ids, bad, sealed.wrappedKey)).toThrow()
  })

  it("reads bodies wrapped with an older key after a rotation, and says which key is missing", () => {
    const old = sealBody(keys, ids, { html: "before", text: null })
    const rotated = ring(`k2:${K2},k1:${K1}`)
    expect(openBody(rotated, ids, old.record, old.wrappedKey).html).toBe("before")
    const fresh = sealBody(rotated, ids, { html: "after", text: null })
    expect(() => openBody(keys, ids, fresh.record, fresh.wrappedKey)).toThrow(
      "wrapped with key k2",
    )
  })
})

describe("rewrapBodyKey", () => {
  const rotated = ring(`k2:${K2},k1:${K1}`)
  const k2Only = ring(`k2:${K2}`)

  it("moves a body key onto the current key, and the record opens as it was without the old key", () => {
    const body = { html: "<p>before</p>", text: "before" }
    const old = sealBody(keys, ids, body)
    expect(bodyKeyUnder(old.wrappedKey)).toBe("k1")

    const fresh = rewrapBodyKey(rotated, ids, old.wrappedKey)

    expect(bodyKeyUnder(fresh)).toBe("k2")
    expect(openBody(k2Only, ids, old.record, fresh)).toEqual(body)
  })

  it("will not move a key copied onto another message or another workspace", () => {
    const old = sealBody(keys, ids, { html: "mine", text: null })
    for (const other of [
      { ...ids, messageId: crypto.randomUUID() },
      { ...ids, tenantId: crypto.randomUUID() },
    ]) {
      expect(() => rewrapBodyKey(rotated, other, old.wrappedKey)).toThrow(
        "does not open under key k1",
      )
    }
  })

  it("fails on a key it does not hold, and on a tampered or malformed value, with no key material", () => {
    const old = sealBody(keys, ids, { html: "mine", text: null })
    expect(() => rewrapBodyKey(k2Only, ids, old.wrappedKey)).toThrow(
      "message body is wrapped with key k1, which is not configured",
    )

    const bad = Buffer.from(old.wrappedKey, "base64")
    bad[bad.byteLength - 1] = bad[bad.byteLength - 1]! ^ 1
    expect(() => rewrapBodyKey(rotated, ids, bad.toString("base64"))).toThrow(
      /^message body key does not open under key k1$/,
    )

    expect(bodyKeyUnder("not a key")).toBeNull()
    expect(() => rewrapBodyKey(rotated, ids, "not a key")).toThrow(
      /^message body key is not well formed$/,
    )
  })

  it("leaves a key already under the current kid as it is, once it opens", () => {
    const current = sealBody(rotated, ids, { html: "after", text: null })
    expect(rewrapBodyKey(rotated, ids, current.wrappedKey)).toBe(current.wrappedKey)
    expect(() =>
      rewrapBodyKey(
        rotated,
        { ...ids, messageId: crypto.randomUUID() },
        current.wrappedKey,
      ),
    ).toThrow("does not open under key k2")
  })
})

/** A pack in memory, as the job would have written it. */
function packed(
  store: ContentStore,
  tenantId: string,
  bodies: { html: string | null; text: string | null }[],
) {
  const packId = crypto.randomUUID()
  const parts: Buffer[] = []
  let offset = 0
  const rows = bodies.map((body) => {
    const messageId = crypto.randomUUID()
    const sealed = sealBody(keys, { tenantId, messageId }, body)
    parts.push(sealed.record)
    const row = {
      messageId,
      html: null as string | null,
      text: null as string | null,
      packId,
      packOffset: offset,
      packLength: sealed.record.byteLength,
      bodyKey: sealed.wrappedKey,
    }
    offset += sealed.record.byteLength
    return row
  })
  ;(store as ReturnType<typeof memoryStore>).objects.set(
    packKey(tenantId, packId),
    new Uint8Array(Buffer.concat(parts)),
  )
  return rows
}

describe("restorePacked", () => {
  const tenant = crypto.randomUUID()

  it("reads each body with one ranged read of its own bytes", async () => {
    const store = Object.assign(memoryStore(), { keys })
    const bodies = [
      { html: "<p>one</p>", text: "one" },
      { html: "<p>two</p>", text: null },
      { html: null, text: "three" },
    ]
    const rows = packed(store, tenant, bodies)
    const plain = { messageId: "m", html: "<p>inline</p>", text: null }
    const back = await restorePacked(store, tenant, [...rows, plain])
    expect(back.map((r) => ({ html: r.html, text: r.text }))).toEqual([
      ...bodies,
      { html: "<p>inline</p>", text: null },
    ])
    expect(store.ranges).toBe(3)
  })

  it("passes rows that are not packed straight through, with no store needed", async () => {
    const rows = [{ messageId: "m", html: "<p>x</p>", text: null }]
    expect(await restorePacked(null, tenant, rows)).toBe(rows)
  })

  it("is loud without a store or keys, and when the key was deleted", async () => {
    const store = Object.assign(memoryStore(), { keys })
    const [row] = packed(store, tenant, [{ html: "x", text: null }])
    await expect(restorePacked(null, tenant, [row!])).rejects.toThrow("CONTENT_KEYS")
    await expect(restorePacked(memoryStore(), tenant, [row!])).rejects.toThrow(
      "CONTENT_KEYS",
    )
    await expect(
      restorePacked(store, tenant, [{ ...row!, bodyKey: null }]),
    ).rejects.toThrow("was deleted")
  })

  it("serves a repeat open from the cache", async () => {
    const store = Object.assign(memoryStore(), {
      keys,
      cache: new BodyCache(1_000_000),
    })
    const [row] = packed(store, tenant, [{ html: "<p>hot</p>", text: null }])
    await restorePacked(store, tenant, [row!])
    const [again] = await restorePacked(store, tenant, [row!])
    expect(again!.html).toBe("<p>hot</p>")
    expect(store.ranges).toBe(1)
  })
  // Its inline images after it: test/content-db.test.ts, where the keys live.
})

describe("BodyCache", () => {
  it("evicts the least recently used past its size, and expires by age", () => {
    // 250 bytes each (UTF-16), four fit.
    const cache = new BodyCache(1_000, 60_000)
    for (const k of ["a", "b", "c", "d"])
      cache.set(k, { html: k.repeat(125), text: null })
    cache.get("a")
    cache.set("e", { html: "e".repeat(125), text: null })
    expect(cache.get("b")).toBeNull()
    for (const k of ["a", "c", "d", "e"]) expect(cache.get(k)).not.toBeNull()

    const aged = new BodyCache(10_000, -1)
    aged.set("x", { html: "x", text: null })
    expect(aged.get("x")).toBeNull()
  })

  it("never holds one body bigger than a quarter of itself", () => {
    const cache = new BodyCache(400)
    cache.set("big", { html: "x".repeat(60), text: null })
    expect(cache.get("big")).toBeNull()
  })
})
