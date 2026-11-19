import { describe, expect, it } from "bun:test"
import { keyringFromEnv } from "../src/crypto/keyring.js"

const K1 = Buffer.alloc(32, 1).toString("base64")
const K2 = Buffer.alloc(32, 2).toString("base64")
const parse = (value: string) => keyringFromEnv("SEAL_KEYS", value)

describe("a keyring variable", () => {
  it("takes the first key as current and keeps the rest for reading", () => {
    const ring = parse(`k2:${K2}, k1:${K1}`)
    expect(ring.current).toBe("k2")
    expect([...ring.keys.keys()]).toEqual(["k2", "k1"])
  })

  it("refuses short keys, bad ids, duplicates and nothing, naming the variable", () => {
    expect(() => parse("k1:c2hvcnQ=")).toThrow("SEAL_KEYS: key k1 is not 32 bytes")
    expect(() => parse(`k 1:${K1}`)).toThrow("kid:base64")
    expect(() => parse(`:${K1}`)).toThrow("kid:base64")
    expect(() => parse(`k1:${K1},k1:${K2}`)).toThrow("twice")
    expect(() => parse(" , ")).toThrow("SEAL_KEYS: no key")
  })
})
