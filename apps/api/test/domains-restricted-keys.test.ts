import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import { domainScope } from "../src/auth/scope.js"
import type { DomainStore } from "../src/domains/store.js"

/**
 * A domain-restricted key is refused on every /domains route.
 *
 * ⚠ THE ROUTES COME FROM THE PUBLISHED DOCUMENT, NOT A LIST WRITTEN HERE. A new
 * /domains route that forgets the guard is caught without anybody remembering
 * to add it to this file.
 *
 * ⚠ AND THE KEY IS SCOPED TO THE VERY DOMAIN IT ASKS ABOUT. Refusing is not
 * confining: a key restricted to `example.com` cannot manage `example.com`
 * either, and a store that records its calls proves the request never got as
 * far as reading or writing anything.
 */

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"

const domain = {
  object: "domain" as const,
  id: ID,
  name: "example.com",
  status: "pending" as const,
  created_at: "2026-09-05T12:00:00.000Z",
  region: "eu-central-1",
  records: [],
}

const recordingStore = () => {
  const calls: string[] = []
  const store = {
    create: async () => (calls.push("create"), { status: "created", domain }),
    get: async () => (calls.push("get"), domain),
    list: async () => (calls.push("list"), [domain]),
    update: async () => (calls.push("update"), domain),
    remove: async () => (calls.push("remove"), true),
    verify: async () => (calls.push("verify"), { status: "ok", domain }),
  } as unknown as DomainStore
  return { calls, store }
}

const appWith = (scopes: string[], domains: DomainStore) =>
  createApp({
    domains,
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
  .filter(([path]) => path === "/domains" || path.startsWith("/domains/"))
  .flatMap(([path, operations]) =>
    Object.entries(operations).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path,
      operation,
    })),
  )

// A body every write route accepts: `name` for create, a toggle for update.
const BODY = JSON.stringify({ name: "example.com", open_tracking: true })

const call = async (scopes: string[], method: string, path: string) => {
  const { calls, store } = recordingStore()
  const res = await appWith(scopes, store).request(path.replace(/\{id\}/g, ID), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    ...(method === "GET" || method === "DELETE" ? {} : { body: BODY }),
  })
  return { res, calls }
}

describe("domain-restricted keys on /domains", () => {
  it("walks every domain route", () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "DELETE /domains/{id}",
        "GET /domains",
        "GET /domains/{id}",
        "PATCH /domains/{id}",
        "POST /domains",
        "POST /domains/{id}/verify",
      ]),
    )
  })

  it.each(routes.map((r) => [r.method, r.path] as const))(
    "refuses %s %s with 403 restricted_api_key, before the store",
    async (method, path) => {
      const { res, calls } = await call([domainScope("example.com")], method, path)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { name: string }).name).toBe("restricted_api_key")
      expect(calls).toEqual([])
    },
  )

  it.each(routes.map((r) => [r.method, r.path, r.operation] as const))(
    "documents the 403 on %s %s",
    (_method, _path, operation) => {
      expect(operation.responses).toHaveProperty("403")
    },
  )

  it.each(routes.map((r) => [r.method, r.path] as const))(
    "serves %s %s to an unrestricted key",
    async (method, path) => {
      const { res } = await call(["emails:send"], method, path)
      expect(res.status).toBeLessThan(300)
    },
  )
})
