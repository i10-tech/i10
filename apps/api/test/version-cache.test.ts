import { describe, expect, it } from "bun:test"
import type { StoredVersion } from "@repo/templates"
import { VersionCache } from "../src/templates/version-cache.js"

const version = (id: string, html = "x"): StoredVersion => ({
  id,
  templateId: "t",
  number: 1,
  subject: null,
  html,
  text: null,
  nonce: "abcdefghijkl",
  variables: [],
})

describe("the send path's version cache (#238)", () => {
  it("keys by tenant, so one workspace never reads another's entry", () => {
    const cache = new VersionCache()
    cache.set("a", version("v1"))
    expect(cache.get("a", "v1")?.id).toBe("v1")
    expect(cache.get("b", "v1")).toBeUndefined()
  })

  it("evicts the least recently used once over its byte budget", () => {
    const cache = new VersionCache(12_000) // entries of ~2.7 KB each
    for (const id of ["v1", "v2", "v3", "v4"])
      cache.set("a", version(id, "x".repeat(1200)))
    cache.get("a", "v1") // v1 is now the most recent
    cache.set("a", version("v5", "x".repeat(1200)))
    expect(cache.get("a", "v2")).toBeUndefined()
    expect(cache.get("a", "v1")).toBeDefined()
    expect(cache.get("a", "v5")).toBeDefined()
    expect(cache.size).toBe(4)
  })

  it("does not let one huge version flush everything else", () => {
    const cache = new VersionCache(12_000)
    cache.set("a", version("small"))
    cache.set("a", version("huge", "x".repeat(10_000)))
    expect(cache.get("a", "huge")).toBeUndefined()
    expect(cache.get("a", "small")).toBeDefined()
  })
})
