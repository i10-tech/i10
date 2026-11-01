import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountCredentials } from "../src/routes/console/credentials.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { KeyStore, KeySummary } from "../src/auth/store.js"
import type { AuditEvent, StoredEvent } from "../src/identity/ports.js"

/**
 * Who may see and act on which API key. Every refusal first, then the grants.
 * The step-up reader and the audit log are real in shape, in memory.
 */

const TENANT = "11111111-1111-4111-8111-111111111111"
const ROLES: Record<string, Role> = {
  owner: "owner",
  admin: "admin",
  alice: "member",
  bob: "member",
}
const K_ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const K_BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const K_ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const K_GONE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const K_LEGACY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

const key = (id: string, createdBy: string | null): KeySummary => ({
  id,
  name: `key-${id.slice(0, 1)}`,
  prefix: "i10_live_abcd",
  mode: "live",
  scopes: [],
  createdBy,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
})

function world(opts: { fresh?: boolean } = {}) {
  const rows = [
    key(K_ALICE, "alice"),
    key(K_BOB, "bob"),
    key(K_ADMIN, "admin"),
    key(K_GONE, "gone"),
    key(K_LEGACY, null),
  ]
  const audit: Array<{ tenantId: string; event: AuditEvent }> = []
  const revoked: string[] = []
  const rotated: string[] = []
  const store = {
    list: async () => rows,
    get: async (_t: string, id: string) => rows.find((k) => k.id === id) ?? null,
    create: async (input: { name: string; createdBy?: string | null }) => ({
      ...key("ffffffff-ffff-4fff-8fff-ffffffffffff", input.createdBy ?? null),
      name: input.name,
      secret: "i10_live_SECRET",
    }),
    revoke: async (_t: string, id: string) => (revoked.push(id), { secretHash: "H" }),
    rotate: async (_t: string, id: string) => {
      rotated.push(id)
      return {
        created: { ...key("99999999-9999-4999-8999-999999999999", "x"), secret: "S" },
        revokedHash: "H",
      }
    },
    setScopes: async (_t: string, id: string) => ({
      key: rows.find((k) => k.id === id)!,
      secretHash: "H",
    }),
    createdBy: async () => [],
  } as unknown as KeyStore
  const events: StoredEvent[] = [
    {
      id: "e1",
      type: "member.deprovisioned",
      actorUserId: "admin",
      subjectUserId: "gone",
      connectionId: null,
      sessionId: null,
      reason: null,
      data: {},
      createdAt: new Date(),
    },
  ]
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" } as never)
    c.set("user", { userId: c.req.header("x-user") ?? "" } as never)
    c.set("freshAuth", (async () => ({
      status: opts.fresh === false ? "stale" : "fresh",
    })) as never)
    await next()
  })
  mountCredentials(app, {
    keys: {
      store,
      cache: { get: async () => null, set: async () => {}, del: async () => {} },
    },
    roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
    identity: {
      store: {
        events: async (_t: string, o: { subjectUserId?: string }) =>
          events.filter((e) => e.subjectUserId === o.subjectUserId),
        record: async (tenantId: string, event: AuditEvent) => {
          audit.push({ tenantId, event })
        },
      },
    },
    people: {
      get: async (id: string) => ({
        name: `Name of ${id}`,
        primaryEmail: `${id}@acme.test`,
        verifiedEmails: [],
      }),
    },
    log: { error: () => {}, warn: () => {} },
  } as unknown as ConsoleDeps)
  const call = (user: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-user": user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { call, audit, revoked, rotated }
}

type Row = { id: string; can_rotate: boolean; can_revoke: boolean; created_by: unknown }
const list = async (w: ReturnType<typeof world>, user: string) =>
  ((await (await w.call(user, "GET", "/api-keys")).json()) as { data: Row[] }).data

describe("listing", () => {
  it("shows a member only the keys they created", async () => {
    const rows = await list(world(), "alice")
    expect(rows.map((r) => r.id)).toEqual([K_ALICE])
  })

  it("shows admins and owners every key, with the creator named", async () => {
    for (const who of ["admin", "owner"]) {
      const rows = await list(world(), who)
      expect(rows).toHaveLength(5)
      expect(rows.find((r) => r.id === K_BOB)?.created_by).toEqual({
        id: "bob",
        name: "Name of bob",
        email: "bob@acme.test",
      })
      expect(rows.find((r) => r.id === K_LEGACY)?.created_by).toBeNull()
    }
  })

  it("flags what the caller may do, from the same rule as the routes", async () => {
    const admin = await list(world(), "admin")
    expect(admin.find((r) => r.id === K_BOB)?.can_rotate).toBe(true)
    // A deprovisioned person's key is visible to an admin but not actionable.
    expect(admin.find((r) => r.id === K_GONE)).toMatchObject({
      can_rotate: false,
      can_revoke: false,
    })
    const owner = await list(world(), "owner")
    expect(owner.find((r) => r.id === K_GONE)?.can_revoke).toBe(true)
    const alice = await list(world(), "alice")
    expect(alice[0]).toMatchObject({ can_rotate: true, can_revoke: true })
  })
})

describe("refusals", () => {
  it.each([
    ["rotate", "POST", (id: string) => `/api-keys/${id}/rotate`],
    ["revoke", "DELETE", (id: string) => `/api-keys/${id}`],
    ["patch", "PATCH", (id: string) => `/api-keys/${id}`],
  ])("a member cannot %s another member's key", async (_n, method, path) => {
    const w = world()
    const res = await w.call("alice", method, path(K_BOB), { domains: [] })
    expect(res.status).toBe(404)
    expect(w.revoked).toEqual([])
    expect(w.rotated).toEqual([])
    expect(w.audit).toEqual([])
  })

  it("a member cannot touch an admin's key, or one with no creator", async () => {
    const w = world()
    expect((await w.call("alice", "DELETE", `/api-keys/${K_ADMIN}`)).status).toBe(404)
    expect((await w.call("alice", "POST", `/api-keys/${K_LEGACY}/rotate`)).status).toBe(
      404,
    )
    expect(w.revoked).toEqual([])
  })

  it("an admin is refused a deprovisioned person's key; an owner is not", async () => {
    const w = world()
    const refused = await w.call("admin", "DELETE", `/api-keys/${K_GONE}`)
    expect(refused.status).toBe(403)
    expect((await w.call("admin", "POST", `/api-keys/${K_GONE}/rotate`)).status).toBe(
      403,
    )
    expect(
      (await w.call("admin", "PATCH", `/api-keys/${K_GONE}`, { domains: [] })).status,
    ).toBe(403)
    expect(w.revoked).toEqual([])
    expect((await w.call("owner", "DELETE", `/api-keys/${K_GONE}`)).status).toBe(200)
    expect(w.revoked).toEqual([K_GONE])
  })

  it("refuses rotate, revoke and patch without a fresh sign-in", async () => {
    const w = world({ fresh: false })
    for (const [method, path] of [
      ["POST", `/api-keys/${K_ALICE}/rotate`],
      ["DELETE", `/api-keys/${K_ALICE}`],
      ["PATCH", `/api-keys/${K_ALICE}`],
    ] as const) {
      expect((await w.call("alice", method, path, { domains: [] })).status).toBe(403)
    }
    expect(w.revoked).toEqual([])
    expect(w.rotated).toEqual([])
    expect(w.audit).toEqual([])
  })

  it("answers a malformed id as not found", async () => {
    const w = world()
    expect((await w.call("owner", "DELETE", "/api-keys/nope")).status).toBe(404)
  })
})

describe("grants and audit", () => {
  it("lets a member act on their own key, audited with them as the actor", async () => {
    const w = world()
    expect((await w.call("alice", "POST", `/api-keys/${K_ALICE}/rotate`)).status).toBe(
      201,
    )
    expect((await w.call("alice", "DELETE", `/api-keys/${K_ALICE}`)).status).toBe(200)
    expect(
      (await w.call("alice", "PATCH", `/api-keys/${K_ALICE}`, { domains: [] })).status,
    ).toBe(200)
    expect(w.audit.map((a) => [a.event.type, a.event.actorUserId])).toEqual([
      ["api_key.rotated", "alice"],
      ["api_key.revoked", "alice"],
      ["api_key.scope_changed", "alice"],
    ])
  })

  it("lets an admin and an owner rotate and revoke a member's key", async () => {
    const w = world()
    expect((await w.call("admin", "POST", `/api-keys/${K_BOB}/rotate`)).status).toBe(
      201,
    )
    expect((await w.call("owner", "DELETE", `/api-keys/${K_BOB}`)).status).toBe(200)
    expect(
      w.audit.map((a) => [a.event.type, a.event.actorUserId, a.event.subjectUserId]),
    ).toEqual([
      ["api_key.rotated", "admin", "bob"],
      ["api_key.revoked", "owner", "bob"],
    ])
  })

  it("audits a create with the actor and keeps the secret in the response", async () => {
    const w = world()
    const res = await w.call("bob", "POST", "/api-keys", { name: "mine" })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { secret: string }).secret).toBe("i10_live_SECRET")
    expect(w.audit[0]?.event).toMatchObject({
      type: "api_key.created",
      actorUserId: "bob",
    })
  })
})
