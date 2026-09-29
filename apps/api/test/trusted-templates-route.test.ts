import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { createApp } from "../src/app.js"
import { mountCampaigns } from "../src/routes/console/campaigns.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { TrustedTemplate, TrustedTemplateStore } from "../src/risk/trusted.js"

/**
 * Submitting templates for review (#222), over the API and from the console.
 *
 * ⚠ BOTH DOORS, ONE STORE. These prove the routes pass who submitted and map
 * the store's refusals to the right statuses; the store's own rules (limits,
 * duplicates, RLS) are proven against Postgres in risk-db.test.ts.
 */
const TENANT = "11111111-1111-4111-8111-111111111111"
const ID = "22222222-2222-4222-8222-222222222222"
const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"

const row = (over: Partial<TrustedTemplate> = {}): TrustedTemplate => ({
  id: ID,
  tenantId: TENANT,
  name: "Password reset",
  status: "pending",
  html: "<p>Hi {{name}}</p>",
  text: null,
  holes: [{ name: "name", max: 40 }],
  segments: ["<p>Hi ", "</p>"],
  staticHosts: [],
  matched: 0,
  submittedBy: "api_key:key-1",
  submittedAt: new Date("2026-09-29T10:00:00Z"),
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  ...over,
})

const store = (over: Partial<TrustedTemplateStore> = {}): TrustedTemplateStore => ({
  list: async () => [row()],
  get: async () => row(),
  submit: mock(async () => ({ template: row() })),
  decide: async () => null,
  revoke: async () => null,
  revokeAll: async () => [],
  withdraw: mock(async () => row({ status: "withdrawn" })),
  approved: async () => [],
  credit: async () => {},
  events: async () => [],
  ...over,
})

function api(s: TrustedTemplateStore | undefined, scopes: string[] = []) {
  const app = createApp({
    apiKeyAuth: {
      lookup: {
        byHash: async () => ({
          id: "key-1",
          tenantId: TENANT,
          scopes,
          mode: "live",
          revokedAt: null,
          expiresAt: null,
        }),
      },
      cache: { get: async () => null, set: async () => {}, del: async () => {} },
      ttlSeconds: 60,
    },
    ...(s ? { trustedTemplates: s } : {}),
  })
  return (path: string, init: RequestInit = {}) =>
    app.request(`/trusted-templates${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
}

const BODY = { name: "Password reset", html: "<p>Hi {{name}}</p>", holes: { name: 40 } }

describe("/trusted-templates", () => {
  it("lists submissions in the public shape", async () => {
    const res = await api(store())("")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          object: "trusted_template",
          id: ID,
          name: "Password reset",
          status: "pending",
          html: "<p>Hi {{name}}</p>",
          text: null,
          holes: [{ name: "name", max: 40 }],
          matched: 0,
          submitted_at: "2026-09-29T10:00:00.000Z",
          decided_at: null,
          decision_reason: null,
        },
      ],
    })
  })

  it("submits in the key's name", async () => {
    const s = store()
    const res = await api(s)("", { method: "POST", body: JSON.stringify(BODY) })
    expect(res.status).toBe(201)
    expect(s.submit).toHaveBeenCalledWith(
      TENANT,
      {
        name: "Password reset",
        html: "<p>Hi {{name}}</p>",
        text: null,
        holes: { name: 40 },
      },
      "api_key:key-1",
    )
  })

  it("answers 409 for a template already waiting or approved", async () => {
    const res = await api(
      store({
        submit: async () => ({ error: "already", code: "duplicate" as const }),
      }),
    )("", { method: "POST", body: JSON.stringify(BODY) })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { name: string }).name).toBe(
      "template_already_submitted",
    )
  })

  it("answers 422 for a template the store refuses, with its reason", async () => {
    const res = await api(
      store({
        submit: async () => ({
          error: "Two placeholders must be separated by fixed text.",
          code: "invalid" as const,
        }),
      }),
    )("", { method: "POST", body: JSON.stringify(BODY) })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain("separated")
  })

  it("answers 422 for a body with neither html nor text", async () => {
    const res = await api(store())("", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    })
    expect(res.status).toBe(422)
  })

  it("withdraws, and 404s what cannot be withdrawn", async () => {
    const s = store()
    expect((await api(s)(`/${ID}`, { method: "DELETE" })).status).toBe(200)
    expect(s.withdraw).toHaveBeenCalledWith(TENANT, ID, "api_key:key-1")
    const none = store({ withdraw: async () => null })
    expect((await api(none)(`/${ID}`, { method: "DELETE" })).status).toBe(404)
  })

  it("refuses a domain-restricted key on every method", async () => {
    const call = api(store(), ["domain:acme.com"])
    expect((await call("")).status).toBe(403)
    expect(
      (await call("", { method: "POST", body: JSON.stringify(BODY) })).status,
    ).toBe(403)
    expect((await call(`/${ID}`, { method: "DELETE" })).status).toBe(403)
  })

  it("answers 501 when the store is not wired", async () => {
    expect((await api(undefined)("")).status).toBe(501)
  })
})

describe("/console/trusted-templates", () => {
  function consoleApp(s: TrustedTemplateStore) {
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" })
      c.set("user", { userId: "user_1" })
      await next()
    })
    mountCampaigns(app, { trustedTemplates: s } as unknown as ConsoleDeps)
    return app
  }

  it("submits in the person's name", async () => {
    const s = store()
    const res = await consoleApp(s).request("/trusted-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    })
    expect(res.status).toBe(201)
    expect(s.submit).toHaveBeenCalledWith(
      TENANT,
      {
        name: "Password reset",
        html: "<p>Hi {{name}}</p>",
        text: null,
        holes: { name: 40 },
      },
      "user:user_1",
    )
  })

  it("withdraws in the person's name", async () => {
    const s = store()
    const res = await consoleApp(s).request(`/trusted-templates/${ID}`, {
      method: "DELETE",
    })
    expect(res.status).toBe(200)
    expect(s.withdraw).toHaveBeenCalledWith(TENANT, ID, "user:user_1")
  })
})
