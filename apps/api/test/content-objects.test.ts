import { describe, expect, it } from "bun:test"
import { openObject, sealObject } from "../src/content/objects.js"
import { keyringFromEnv } from "../src/crypto/keyring.js"

/**
 * Files sealed for R2 (content/objects.ts). The write and read through
 * Postgres, dedup included, are test/content-objects-db.test.ts.
 */
const key = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64")}`
const ring = (value: string) => keyringFromEnv("OBJECT_KEYS", value)
const o1 = ring(key("o1", 1))
const rotated = ring(`${key("o2", 2)},${key("o1", 1)}`)
const o2Only = ring(key("o2", 2))

const file = Buffer.from("%PDF-1.7 the invoice, with its numbers")
const ids = { tenantId: crypto.randomUUID(), sha256: "a".repeat(64) }

describe("sealObject", () => {
  it("opens to the file, and the sealed bytes do not hold it", () => {
    const sealed = sealObject(o1, ids, file)
    expect(sealed.bytes.includes(file)).toBe(false)
    expect(openObject(o1, ids, sealed.bytes, sealed.sealedKey).equals(file)).toBe(true)
  })

  it("seals an empty file", () => {
    const sealed = sealObject(o1, ids, new Uint8Array(0))
    expect(openObject(o1, ids, sealed.bytes, sealed.sealedKey).byteLength).toBe(0)
  })

  it("does not open for another workspace or another hash", () => {
    const sealed = sealObject(o1, ids, file)
    for (const other of [
      { ...ids, tenantId: crypto.randomUUID() },
      { ...ids, sha256: "b".repeat(64) },
    ]) {
      expect(() => openObject(o1, other, sealed.bytes, sealed.sealedKey)).toThrow(
        "does not open",
      )
    }
  })

  it("refuses tampered bytes, and says nothing about the key", () => {
    const sealed = sealObject(o1, ids, file)
    const bad = Buffer.from(sealed.bytes)
    bad[14] = bad[14]! ^ 1
    expect(() => openObject(o1, ids, bad, sealed.sealedKey)).toThrow(
      /^stored file a{64} does not open$/,
    )
  })

  it("opens after a new first key is added, and names a key that is gone", () => {
    const sealed = sealObject(o1, ids, file)
    expect(openObject(rotated, ids, sealed.bytes, sealed.sealedKey).equals(file)).toBe(
      true,
    )
    expect(() => openObject(o2Only, ids, sealed.bytes, sealed.sealedKey)).toThrow(
      "stored file is wrapped with key o1, which is not configured",
    )
  })
})
