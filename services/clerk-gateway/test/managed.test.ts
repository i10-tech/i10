import { describe, expect, it } from "bun:test"
import { cached, NOT_MANAGED, type ManagedAccounts } from "../src/managed.js"

function counting(answer: () => Promise<boolean>) {
  const asked: string[] = []
  const inner: ManagedAccounts = {
    byIdentifier: (id) => (asked.push(id), answer()),
    bySession: (id) => (asked.push(id), answer()),
  }
  return { asked, inner }
}

describe("the managed-account hook", () => {
  it("is a stub that answers no for everybody until #337", async () => {
    expect(await NOT_MANAGED.byIdentifier("ada@example.com")).toBe(false)
    expect(await NOT_MANAGED.bySession("sess_1")).toBe(false)
  })

  it("caches answers for the ttl, per kind", async () => {
    let clock = 0
    const { asked, inner } = counting(async () => true)
    const hook = cached(inner, { ttlMs: 1000, now: () => clock })
    expect(await hook.byIdentifier("a@b.co")).toBe(true)
    expect(await hook.byIdentifier("a@b.co")).toBe(true)
    expect(await hook.bySession("a@b.co")).toBe(true)
    expect(asked).toEqual(["a@b.co", "a@b.co"])
    clock = 1001
    await hook.byIdentifier("a@b.co")
    expect(asked).toHaveLength(3)
  })

  it("never caches a failure", async () => {
    let fail = true
    const { asked, inner } = counting(async () => {
      if (fail) throw new Error("down")
      return false
    })
    const hook = cached(inner, { ttlMs: 60_000, now: () => 0 })
    await expect(hook.bySession("sess_1")).rejects.toThrow("down")
    fail = false
    expect(await hook.bySession("sess_1")).toBe(false)
    expect(asked).toEqual(["sess_1", "sess_1"])
  })

  it("stays bounded", async () => {
    const { asked, inner: spy } = counting(async () => false)
    const bounded = cached(spy, { ttlMs: 60_000, maxEntries: 2, now: () => 0 })
    await bounded.byIdentifier("1")
    await bounded.byIdentifier("2")
    await bounded.byIdentifier("3")
    await bounded.byIdentifier("1")
    // "1" was evicted when "3" arrived, so it is asked again.
    expect(asked).toEqual(["1", "2", "3", "1"])
  })
})
