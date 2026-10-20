import { describe, expect, it } from "bun:test"
import {
  apiManaged,
  cached,
  NOT_MANAGED,
  type ManagedAccounts,
} from "../src/managed.js"

function counting(answer: () => Promise<boolean>) {
  const asked: string[] = []
  const inner: ManagedAccounts = {
    byIdentifier: (id) => (asked.push(id), answer()),
    bySession: (id) => (asked.push(id), answer()),
  }
  return { asked, inner }
}

describe("the managed-account hook", () => {
  it("has a no-one-is-managed fixture for the tests", async () => {
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

describe("the API-backed lookup (#337)", () => {
  const seen: { url: string; init: RequestInit }[] = []
  const api = (respond: () => Response | Promise<Response>) => {
    seen.length = 0
    return apiManaged({
      url: "https://api.i10.tech/",
      secret: "s3cret-s3cret-s3cret-s3cret-s3cret",
      fetch: async (url, init) => {
        seen.push({ url, init })
        return respond()
      },
    })
  }

  it("asks our API with the shared secret, by identifier and by session", async () => {
    const hook = api(() => Response.json({ managed: true }))
    expect(await hook.byIdentifier("ada@acme.test")).toBe(true)
    expect(seen[0]!.url).toBe("https://api.i10.tech/internal/identity/managed")
    expect(seen[0]!.init.method).toBe("POST")
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe(
      "Bearer s3cret-s3cret-s3cret-s3cret-s3cret",
    )
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      identifier: "ada@acme.test",
    })
    expect(await hook.bySession("sess_1")).toBe(true)
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ sessionId: "sess_1" })
  })

  it("reads `false` as an answer", async () => {
    expect(
      await api(() => Response.json({ managed: false })).byIdentifier("a@b.co"),
    ).toBe(false)
  })

  it("throws, never answers no, for anything but a 200 with a boolean", async () => {
    for (const respond of [
      () => new Response("down", { status: 503 }),
      () => new Response("no", { status: 401 }),
      () => Response.json({ managed: "yes" }),
      () => Response.json({}),
      () => new Response("not json", { status: 200 }),
      () => {
        throw new TypeError("network down")
      },
    ]) {
      await expect(api(respond).byIdentifier("a@b.co")).rejects.toThrow()
    }
  })

  it("throws when it is not configured", async () => {
    const fetch = async () => Response.json({ managed: false })
    await expect(
      apiManaged({ url: undefined, secret: "x".repeat(32), fetch }).byIdentifier(
        "a@b.co",
      ),
    ).rejects.toThrow("not configured")
    await expect(
      apiManaged({ url: "https://api.i10.tech", secret: undefined, fetch }).bySession(
        "sess_1",
      ),
    ).rejects.toThrow("not configured")
  })

  it("gives up after its timeout", async () => {
    const hook = apiManaged({
      url: "https://api.i10.tech",
      secret: "x".repeat(32),
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    })
    await expect(hook.byIdentifier("a@b.co")).rejects.toThrow("aborted")
  })

  it("through the gateway: a managed identifier is told to use SSO, an API outage is a 503", async () => {
    const { harness } = await import("./helpers.js")
    const body = (identifier: string) =>
      new URLSearchParams({ identifier, strategy: "email_code" }).toString()
    const init = (identifier: string): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body(identifier),
    })
    const managed = harness({ managed: api(() => Response.json({ managed: true })) })
    const refused = await managed.send("/v1/client/sign_ins", init("ada@acme.test"))
    expect(refused.status).toBe(422)
    expect(managed.calls).toHaveLength(0)
    const down = harness({ managed: api(() => new Response("", { status: 503 })) })
    const outage = await down.send("/v1/client/sign_ins", init("ada@acme.test"))
    expect(outage.status).toBe(503)
    expect(down.calls).toHaveLength(0)
  })
})
