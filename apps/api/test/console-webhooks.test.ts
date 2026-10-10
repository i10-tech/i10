import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import type { SessionVerifier } from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"
import type { WebhookEndpointStore } from "../src/webhooks/store.js"

/**
 * The console's webhook endpoint routes (#286): creating takes the same
 * contract the public API does, and one endpoint can be read on its own.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"
const ENDPOINT = "33333333-3333-4333-8333-333333333333"
const BEARER = { Authorization: "Bearer stub", "Content-Type": "application/json" }

const sessions: SessionVerifier = {
  verify: async () => ({ status: "signed-in", userId: "user_1" }),
}
const tenants: TenantResolver = { resolve: async () => TENANT }

function appWith(webhooks: Partial<WebhookEndpointStore>) {
  return createApp({
    console: {
      sessions,
      tenants,
      webhooks: webhooks as WebhookEndpointStore,
      queries: {} as ConsoleDeps["queries"],
      usage: {} as ConsoleDeps["usage"],
      onboarding: {} as ConsoleDeps["onboarding"],
      profile: {} as ConsoleDeps["profile"],
      marketing: {} as ConsoleDeps["marketing"],
      log: { error: () => {}, warn: () => {} },
    },
  })
}

describe("POST /console/webhook-endpoints", () => {
  /*
   * ⚠ THE REGRESSION THIS GUARDS. The route used to copy four fields out of
   * the body by hand, so a polling endpoint arrived at the store as an HTTP
   * one with an empty URL, and headers and filters were dropped silently.
   */
  it("hands the store every field of the contract", async () => {
    let seen: unknown
    const app = appWith({
      create: async (_tenant, input) => {
        seen = input
        return { status: "rejected", reason: "stop here" }
      },
    })

    const body = {
      kind: "sqs",
      url: "https://sqs.eu-west-1.amazonaws.com/123456789012/events",
      aws_credentials: {
        access_key_id: "AKIAIOSFODNN7EXAMPLE",
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      events: ["email.delivered"],
      rate_limit: 10,
      filter_domains: ["acme.com"],
      filter_tags: { team: "billing" },
    }
    const res = await appWith({}).request("/console/webhook-endpoints", {
      method: "POST",
      headers: BEARER,
      body: JSON.stringify({ events: [] }),
    })
    expect(res.status).toBe(422)

    await app.request("/console/webhook-endpoints", {
      method: "POST",
      headers: BEARER,
      body: JSON.stringify(body),
    })
    expect(seen).toEqual(body)
  })

  it("creates a polling endpoint with no URL", async () => {
    const app = appWith({
      create: async (_tenant, input) => ({
        status: "created",
        endpoint: { id: ENDPOINT, kind: input.kind, url: null } as never,
      }),
    })
    const res = await app.request("/console/webhook-endpoints", {
      method: "POST",
      headers: BEARER,
      body: JSON.stringify({ kind: "polling", events: ["email.bounced"] }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ kind: "polling", url: null })
  })
})

describe("GET /console/webhook-endpoints/:id", () => {
  const app = appWith({
    get: async (_tenant, id) =>
      id === ENDPOINT ? ({ id: ENDPOINT, kind: "http" } as never) : null,
  })

  it("answers one endpoint", async () => {
    const res = await app.request(`/console/webhook-endpoints/${ENDPOINT}`, {
      headers: BEARER,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: ENDPOINT })
  })

  it("is a 404 for an unknown or malformed id", async () => {
    for (const id of ["44444444-4444-4444-8444-444444444444", "not-an-id"]) {
      const res = await app.request(`/console/webhook-endpoints/${id}`, {
        headers: BEARER,
      })
      expect(res.status).toBe(404)
    }
  })
})

describe("GET /console/webhook-deliveries filters", () => {
  function appListing(seen: { filter?: unknown }) {
    return createApp({
      console: {
        sessions,
        tenants,
        webhooks: {} as WebhookEndpointStore,
        queries: {
          listDeliveries: async (_tenant: string, filter: unknown) => {
            seen.filter = filter
            return { data: [], nextCursor: null }
          },
        } as unknown as ConsoleDeps["queries"],
        usage: {} as ConsoleDeps["usage"],
        onboarding: {} as ConsoleDeps["onboarding"],
        profile: {} as ConsoleDeps["profile"],
        marketing: {} as ConsoleDeps["marketing"],
        log: { error: () => {}, warn: () => {} },
      },
    })
  }

  it("passes time, response class and search to the query", async () => {
    const seen: { filter?: unknown } = {}
    const res = await appListing(seen).request(
      "/console/webhook-deliveries?since=2026-10-01T00:00:00.000Z&until=2026-10-02T00:00:00.000Z&http_class=none&q=0199a3f2",
      { headers: BEARER },
    )
    expect(res.status).toBe(200)
    expect(seen.filter).toEqual({
      since: new Date("2026-10-01T00:00:00.000Z"),
      until: new Date("2026-10-02T00:00:00.000Z"),
      httpClass: "none",
      q: "0199a3f2",
    })
  })

  /*
   * ⚠ A SEARCH THAT CANNOT BE AN ID IS STILL PASSED ON: the query answers it
   * with nothing. Dropping it, as a bad time or class is dropped, would show
   * the whole log under a search box that says "acme".
   */
  it("drops a bad time or class, and keeps a search that cannot match", async () => {
    const seen: { filter?: unknown } = {}
    await appListing(seen).request(
      "/console/webhook-deliveries?since=yesterday&http_class=3xx&q=acme",
      { headers: BEARER },
    )
    expect(seen.filter).toEqual({ q: "acme" })
  })
})
