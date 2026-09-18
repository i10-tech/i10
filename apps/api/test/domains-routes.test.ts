import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { DomainStore } from "../src/domains/store.js"

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"

const apiKeyAuth = {
  lookup: {
    byHash: async () => ({
      id: "key-1",
      tenantId: "ten-1",
      scopes: ["emails:send"],
      mode: "live",
      revokedAt: null,
      expiresAt: null,
    }),
  },
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
  ttlSeconds: 60,
}

const domain = {
  object: "domain" as const,
  id: ID,
  name: "example.com",
  status: "pending" as const,
  created_at: "2026-09-05T12:00:00.000Z",
  region: "eu-central-1",
  records: [
    {
      record: "SPF",
      name: "send.example.com",
      type: "TXT" as const,
      ttl: "Auto",
      status: "pending" as const,
      value: "v=spf1 include:amazonses.com ~all",
    },
  ],
}

const store = (over: Partial<DomainStore> = {}): DomainStore =>
  ({
    create: async () => ({ status: "created", domain }),
    get: async () => domain,
    list: async () => [{ ...domain, records: undefined as never }],
    remove: async () => true,
    verify: async () => ({ status: "ok", domain }),
    ...over,
  }) as DomainStore

const app = (domains?: DomainStore) =>
  createApp({ apiKeyAuth, ...(domains ? { domains } : {}) })

const authed = (body?: unknown) => ({
  method: body ? "POST" : "GET",
  headers: {
    Authorization: `Bearer ${KEY}`,
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

describe("Resend compatibility", () => {
  /**
   * ⚠ THE PATHS AND VERBS ARE THE COMPATIBILITY SURFACE. `resend/node` →
   * `@i10/node` is meant to be a one-line change, so a customer who has written
   * `domains.create({ name })` must not discover ours takes a different key.
   */
  it("creates at POST /domains with `name`, and answers 201", async () => {
    const res = await app(store()).request("/domains", authed({ name: "example.com" }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ object: "domain", id: ID })
  })

  it("verifies at POST /domains/{id}/verify", async () => {
    const res = await app(store()).request(`/domains/${ID}/verify`, authed({}))
    expect(res.status).toBe(200)
  })

  it("lists at GET /domains under `data`", async () => {
    const res = await app(store()).request("/domains", authed())
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty("data")
  })

  it("deletes at DELETE /domains/{id} and echoes the id", async () => {
    const res = await app(store()).request(`/domains/${ID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${KEY}` },
    })
    expect(await res.json()).toEqual({ object: "domain", id: ID, deleted: true })
  })
})

describe("refusals", () => {
  /**
   * ⚠ 403 AND NOT 429, AND THIS IS THE ONE THAT MATTERS. The SDKs back off on a
   * 429, and waiting does not produce another domain — a retry loop would run
   * forever. A plan limit on a held resource is not rate limiting.
   */
  it("answers 403 with plan_limit_exceeded when the plan is full", async () => {
    const res = await app(
      store({ create: async () => ({ status: "limit", reason: "no room" }) }),
    ).request("/domains", authed({ name: "example.com" }))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ name: "plan_limit_exceeded" })
  })

  it("answers 409 for a domain that is already registered", async () => {
    const res = await app(
      store({
        create: async () => ({ status: "conflict", reason: "already registered" }),
      }),
    ).request("/domains", authed({ name: "example.com" }))

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ name: "domain_already_exists" })
  })

  it("answers 422 for something that is not a domain", async () => {
    const res = await app(
      store({ create: async () => ({ status: "rejected", reason: "not a domain" }) }),
    ).request("/domains", authed({ name: "https://example.com" }))

    expect(res.status).toBe(422)
  })

  it("answers 404 for an unknown id", async () => {
    const res = await app(store({ get: async () => null })).request(
      `/domains/${ID}`,
      authed(),
    )
    expect(res.status).toBe(404)
  })

  it("needs a key", async () => {
    const res = await app(store()).request("/domains")
    expect(res.status).toBe(401)
  })

  /**
   * ⚠ 501, NOT 404 AND NOT A SILENT SUCCESS. A deployment with no domain store
   * has a configuration problem, and a 404 would send the caller looking for a
   * typo in a URL that is correct.
   */
  it("answers 501 when domains are not configured", async () => {
    const res = await app().request("/domains", authed())
    expect(res.status).toBe(501)
  })
})
