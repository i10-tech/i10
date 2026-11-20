import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"

/**
 * A domain-restricted key is refused on every customer webhook route (#312).
 *
 * ⚠ THE ROUTES COME FROM THE PUBLISHED DOCUMENT, NOT A LIST WRITTEN HERE. A new
 * webhook route that forgets the guard is caught without anybody remembering to
 * add it to this file. No store is wired, so a route that lets the key through
 * answers 501 (or 422) instead of 403, and the test names it.
 */

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const UUID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"

const WORKSPACE_WIDE = [
  "/webhook-endpoints",
  "/webhook-deliveries",
  "/webhook-stats",
  "/webhook-health-events",
]

const appWith = (scopes: string[]) =>
  createApp({
    apiKeyAuth: {
      lookup: {
        byHash: async () => ({
          id: "key-1",
          tenantId: "ten-1",
          scopes,
          mode: "live",
          revokedAt: null,
          expiresAt: null,
        }),
      },
      cache: { get: async () => null, set: async () => {}, del: async () => {} },
      ttlSeconds: 60,
    },
  })

type Operation = { responses: Record<string, unknown> }
type Document = { paths: Record<string, Record<string, Operation>> }

const document = (await (await createApp().request("/openapi.json")).json()) as Document

const routes = Object.entries(document.paths)
  .filter(([path]) => WORKSPACE_WIDE.some((prefix) => path.startsWith(prefix)))
  .flatMap(([path, operations]) =>
    Object.entries(operations).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path,
      operation,
    })),
  )

const call = (scopes: string[], method: string, path: string) =>
  appWith(scopes).request(path.replace(/\{[a-z_]+\}/g, UUID), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
  })

describe("domain-restricted keys on webhook routes (#312)", () => {
  it("walks the poll, create, update and delivery routes", () => {
    const names = routes.map((r) => `${r.method} ${r.path}`)
    expect(names).toContain("GET /webhook-endpoints/{id}/poll")
    expect(names).toContain("POST /webhook-endpoints")
    expect(names).toContain("PATCH /webhook-endpoints/{id}")
    expect(names).toContain("GET /webhook-deliveries")
  })

  it.each(routes.map((r) => [r.method, r.path] as const))(
    "refuses %s %s with 403 restricted_api_key",
    async (method, path) => {
      const res = await call(["domain:acme.com"], method, path)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { name: string }).name).toBe("restricted_api_key")
    },
  )

  it.each(routes.map((r) => [r.method, r.path, r.operation] as const))(
    "documents the 403 on %s %s",
    (_method, _path, operation) => {
      expect(operation.responses).toHaveProperty("403")
    },
  )

  it.each(routes.map((r) => [r.method, r.path] as const))(
    "lets an unrestricted key past the guard on %s %s",
    async (method, path) => {
      const res = await call(["emails:send"], method, path)
      expect(res.status).not.toBe(403)
    },
  )

  it("still serves the event catalog, which holds no workspace data", async () => {
    const res = await call(["domain:acme.com"], "GET", "/webhook-event-types")
    expect(res.status).toBe(200)
  })
})
