import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { DomainStore } from "../src/domains/store.js"

/**
 * The typed-time check behind the domain box's inline refusal.
 *
 * ⚠ THE ONE THING THAT CAN SILENTLY BREAK IT IS ROUTE ORDER. `/domains/check`
 * sits beside `/domains/:id`, and if it is ever registered below it the check
 * becomes a lookup of a domain whose id is "check" — a 404 the console reads
 * as "no objection", so the box goes quiet and nothing fails.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"

const domains = {
  refusal: async (_tenant: string, name: string) => {
    return name === "i10.tech" ? "i10.tech is ours" : null
  },
  get: async () => null,
} as unknown as DomainStore

const app = createApp({
  console: {
    sessions: { verify: async () => ({ status: "signed-in", userId: "user_1" }) },
    tenants: { resolve: async () => TENANT },
    keys: {} as ConsoleDeps["keys"],
    domains,
    queries: {} as ConsoleDeps["queries"],
    usage: {} as ConsoleDeps["usage"],
    onboarding: {} as ConsoleDeps["onboarding"],
    profile: {} as ConsoleDeps["profile"],
    marketing: {} as ConsoleDeps["marketing"],
    log: { error: () => {}, warn: () => {} },
  },
})

const get = (path: string) =>
  app.request(path, { headers: { Authorization: "Bearer stub" } })

describe("GET /console/domains/check", () => {
  it("answers the store's refusal, not a lookup by id", async () => {
    const res = await get("/console/domains/check?name=i10.tech")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "i10.tech", refusal: "i10.tech is ours" })
  })

  it("answers null for a name nobody objects to", async () => {
    const res = await get("/console/domains/check?name=acme.com")
    expect(await res.json()).toEqual({ name: "acme.com", refusal: null })
  })

  it("wants a name", async () => {
    expect((await get("/console/domains/check")).status).toBe(422)
  })
})
