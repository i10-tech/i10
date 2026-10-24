import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import { ssoGate } from "../src/identity/gate.js"
import { startUrlFor } from "../src/identity/middleware.js"
import type { DiscoveredConnection } from "../src/identity/ports.js"
import { TENANT, log, memoryClerk, memoryStore } from "./identity-fakes.js"
import { memoryPolicy } from "./identity-policy-fakes.js"

/**
 * Home realm discovery (#340): `POST /sso/discover` answers from the address's
 * domain alone, so it can never say whether an account or a membership exists.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

const found = (over: Partial<DiscoveredConnection>): DiscoveredConnection => ({
  id: A,
  tenantId: TENANT,
  name: "Acme Okta",
  enforcement: "off",
  createdAt: new Date("2026-01-01"),
  ...over,
})

function world(discovered: Record<string, DiscoveredConnection[]>, wired = true) {
  const policy = memoryPolicy({ discovered })
  const store = memoryStore()
  const clerk = memoryClerk()
  const deps: SsoRouteDeps = {
    bridge: {
      store: store.store,
      clerk: clerk.clerk,
      engines: new Map(),
      join: async () => "added",
      isExempt: async () => false,
      log,
    },
    gate: ssoGate({ store: store.store, clerk: clerk.clerk, log }),
    identify: async () => ({ status: "signed-out" }),
    returnOrigins: [],
    testEngine: false,
    mayManage: async () => false,
    tenantOfConnection: async () => TENANT,
    ...(wired
      ? {
          discovery: {
            store: policy.store,
            startUrl: startUrlFor("https://auth.i10.localhost"),
          },
        }
      : {}),
  }
  const app = new Hono().route("/sso", createSsoRoutes(deps))
  const ask = (body: unknown) =>
    app.request("/sso/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { ask, policy }
}

describe("home realm discovery", () => {
  it("refuses a body without an email, and is 404 when not wired", async () => {
    const w = world({})
    expect((await w.ask({})).status).toBe(422)
    expect((await w.ask({ email: "a@b.test", other: 1 })).status).toBe(422)
    expect((await w.ask({ email: "x".repeat(321) })).status).toBe(422)
    expect((await world({}, false).ask({ email: "ada@acme.test" })).status).toBe(404)
  })

  it("answers none for a malformed address without asking the database", async () => {
    const w = world({})
    for (const email of ["not-an-address", "a@b@acme.test", "ada@acme"]) {
      const res = await w.ask({ email })
      expect(await res.json()).toEqual({ sso: "none" })
    }
    expect(w.policy.calls).toHaveLength(0)
  })

  it("answers none for a domain no active connection covers", async () => {
    expect(await (await world({}).ask({ email: "ada@gmail.test" })).json()).toEqual({
      sso: "none",
    })
  })

  it("answers available or required, with the start URL, by the connection's enforcement", async () => {
    for (const [enforcement, sso] of [
      ["off", "available"],
      ["optional", "available"],
      ["required_domain", "required"],
      ["required_all", "required"],
    ] as const) {
      const res = await world({ "acme.test": [found({ enforcement })] }).ask({
        email: "Ada@ACME.test",
      })
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(await res.json()).toEqual({
        sso,
        connection: A,
        startUrl: `https://auth.i10.localhost/sso/start?connection=${A}`,
        name: "Acme Okta",
      })
    }
  })

  it("asks only the address's domain, so whoever holds it gets the same answer", async () => {
    const w = world({ "acme.test": [found({})] })
    const answers = await Promise.all(
      ["ada@acme.test", "nobody-at-all@acme.test", "ADA@acme.test"].map(async (email) =>
        (await w.ask({ email })).json(),
      ),
    )
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(w.policy.calls).toEqual([
      "discover:acme.test",
      "discover:acme.test",
      "discover:acme.test",
    ])
  })

  it("picks the strictest of two active connections, then the oldest", async () => {
    const w = world({
      "acme.test": [
        found({ id: A, enforcement: "optional", createdAt: new Date("2025-01-01") }),
        found({
          id: B,
          enforcement: "required_domain",
          createdAt: new Date("2026-01-01"),
        }),
        found({
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          enforcement: "required_domain",
          createdAt: new Date("2026-06-01"),
        }),
      ],
    })
    expect(await (await w.ask({ email: "ada@acme.test" })).json()).toMatchObject({
      sso: "required",
      connection: B,
    })
  })

  it("answers 503, never none, when it cannot tell", async () => {
    const w = world({ "acme.test": [found({})] })
    w.policy.failWith(true)
    expect((await w.ask({ email: "ada@acme.test" })).status).toBe(503)
  })
})
