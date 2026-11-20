import { describe, expect, it } from "bun:test"
import type { GetEmailResponse } from "@repo/contracts"
import { createApp } from "../src/app.js"
import { domainScope } from "../src/auth/scope.js"

/**
 * `GET /emails/{id}` confines a domain-restricted key to mail from its own
 * domains, the same exact-match rule the send path applies to `from`.
 *
 * ⚠ CONFINED, NOT REFUSED: sending and then polling for the outcome is what a
 * restricted key is for. And ⚠ 404, NOT 403, for anything outside the key's
 * domains, with the body an unknown id gets, so the key cannot learn that
 * another domain's message exists.
 */

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"
const ID = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb"
const UNKNOWN = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60cc"

const sentFrom = (from: string): GetEmailResponse => ({
  object: "email",
  id: ID,
  from,
  to: ["user@example.com"],
  cc: [],
  bcc: [],
  reply_to: [],
  subject: "Hi",
  html: null,
  text: "body",
  created_at: "2026-11-20T12:00:00.000Z",
  scheduled_at: null,
  last_event: "delivered",
})

const read = async (scopes: string[], from: string, id = ID) => {
  const app = createApp({
    emailLookup: {
      get: async (_tenant, wanted) => (wanted === ID ? sentFrom(from) : null),
    },
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
  return app.request(`/emails/${id}`, { headers: { Authorization: `Bearer ${KEY}` } })
}

const ACME = [domainScope("acme.com")]

describe("GET /emails/{id} with a domain-restricted key", () => {
  it.each([
    ["a bare address", "hello@acme.com"],
    ["a display name", "Acme <hello@acme.com>"],
    ["different casing", "hello@ACME.com"],
  ])("returns mail its key may send from, written with %s", async (_case, from) => {
    const res = await read(ACME, from)
    expect(res.status).toBe(200)
    expect(((await res.json()) as GetEmailResponse).from).toBe(from)
  })

  it.each([
    ["another domain", "hello@other.com"],
    ["a subdomain", "hello@mail.acme.com"],
    ["a look-alike", "hello@evil-acme.com"],
    ["no parseable address", "acme.com"],
  ])("hides mail from %s behind the unknown-id 404", async (_case, from) => {
    const hidden = await read(ACME, from)
    const unknown = await read(ACME, from, UNKNOWN)
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual(await unknown.json())
  })

  it("returns mail from any domain to an unrestricted key", async () => {
    const res = await read(["emails:send"], "hello@other.com")
    expect(res.status).toBe(200)
  })
})
