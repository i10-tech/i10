import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"
import type { OutboxEntry } from "../src/identity/directory-ports.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import { LIMITS, SCHEMA } from "../src/identity/scim.js"
import type { ScimRouteDeps } from "../src/routes/scim.js"
import {
  DIRECTORY,
  OTHER_DIRECTORY,
  memoryDirectories,
  scimToken,
} from "./identity-scim-fakes.js"
import { OTHER_TENANT, TENANT } from "./identity-fakes.js"

/**
 * The SCIM server's HTTP surface (#342): every refusal of the token, the
 * limits, the content rules and the filters first, then each endpoint with
 * payloads as Entra, Okta and Google send them.
 */

const ALPHA = scimToken("alpha")
const BETA = scimToken("beta")
const BASE = "https://api.test/scim/v2"
const ENTRA = [SCHEMA.user, SCHEMA.enterprise]

interface Options {
  limits?: ScimRouteDeps["limits"]
  tokens?: NonNullable<Parameters<typeof memoryDirectories>[0]>["tokens"]
  directories?: NonNullable<Parameters<typeof memoryDirectories>[0]>["directories"]
  configured?: boolean
}

function world(options: Options = {}) {
  const dirs = memoryDirectories({
    tokens: options.tokens ?? [{ seed: "alpha" }],
    directories: options.directories ?? [{ id: DIRECTORY }, { id: OTHER_DIRECTORY }],
  })
  let clock = new Date("2026-10-21T10:00:00Z")
  const scheduled: { tenantId: string; entries: OutboxEntry[] }[] = []
  const kicks: string[] = []
  const events: { tenantId: string; type: string; [k: string]: unknown }[] = []
  const logged: { level: string; o: object; m: string }[] = []
  const deps: ScimRouteDeps = {
    store: dirs.store,
    baseUrl: (id) => `${BASE}/${id}`,
    schedule: async (tenantId, entries) => {
      scheduled.push({ tenantId, entries: [...entries] })
    },
    kick: async (tenantId, directoryId) => {
      kicks.push(`${tenantId}:${directoryId}`)
    },
    record: async (tenantId, event) => {
      events.push({ tenantId, ...event })
    },
    take: fixedWindow(null, () => clock.getTime()),
    contextSecret: undefined,
    ...(options.limits ? { limits: options.limits } : {}),
    log: {
      warn: (o, m) => logged.push({ level: "warn", o, m }),
      error: (o, m) => logged.push({ level: "error", o, m }),
    },
    now: () => clock,
  }
  const app = createApp(options.configured === false ? {} : { scim: deps })
  const call = (
    method: string,
    path: string,
    init: {
      body?: unknown
      raw?: string
      token?: string | null
      headers?: Record<string, string>
      directory?: string
      type?: string | null
    } = {},
  ) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    const token = init.token === undefined ? ALPHA.token : init.token
    if (token) headers.authorization = `Bearer ${token}`
    if (init.type !== null && (init.body !== undefined || init.raw !== undefined))
      headers["content-type"] = init.type ?? "application/scim+json"
    return app.request(`/scim/v2/${init.directory ?? DIRECTORY}${path}`, {
      method,
      headers,
      ...(init.raw !== undefined
        ? { body: init.raw }
        : init.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
    })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test reads its own shape
  const json = async (res: Response) => (await res.json()) as Record<string, any>
  return {
    dirs,
    deps,
    app,
    call,
    json,
    scheduled,
    kicks,
    events,
    logged,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    now: () => clock,
  }
}

const ada = (over: Record<string, unknown> = {}) => ({
  schemas: ENTRA,
  externalId: "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10",
  userName: "ada@acme.test",
  active: true,
  displayName: "Ada Lovelace",
  name: { givenName: "Ada", familyName: "Lovelace" },
  emails: [{ primary: true, type: "work", value: "ada@acme.test" }],
  [SCHEMA.enterprise]: { department: "Engineering" },
  ...over,
})

const patch = (...Operations: Record<string, unknown>[]) => ({
  schemas: [SCHEMA.patch],
  Operations,
})

async function seed(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
  const res = await w.call("POST", "/Users", { body: ada(over) })
  expect(res.status).toBe(201)
  return (await w.json(res)) as { id: string; userName: string }
}

// ── The token ───────────────────────────────────────────────────────────────

describe("authentication: every refusal", () => {
  it("answers 501 in SCIM's shape when SCIM is not configured", async () => {
    const w = world({ configured: false })
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(501)
    expect(res.headers.get("content-type")).toContain("application/scim+json")
    expect(await w.json(res)).toMatchObject({ schemas: [SCHEMA.error], status: "501" })
  })

  it("refuses a request with no Authorization header, and says how to authenticate", async () => {
    const w = world()
    const res = await w.call("GET", "/Users", { token: null })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="scim"')
    expect(res.headers.get("content-type")).toContain("application/scim+json")
    expect(await w.json(res)).toMatchObject({ schemas: [SCHEMA.error], status: "401" })
  })

  for (const [name, header] of [
    ["another scheme", `Basic ${ALPHA.token}`],
    ["a token of the wrong shape", "Bearer not-a-scim-token"],
    ["our prefix and the wrong length", `Bearer i10_scim_${"a".repeat(20)}`],
    ["another prefix", `Bearer sk_live_${"a".repeat(43)}`],
    ["a token and something after it", `Bearer ${ALPHA.token} extra`],
    ["an empty bearer", "Bearer "],
  ] as const)
    it(`refuses ${name}`, async () => {
      const w = world()
      const res = await w.call("GET", "/Users", {
        token: null,
        headers: { authorization: header },
      })
      expect(res.status).toBe(401)
      expect(w.kicks).toEqual([])
    })

  it("refuses a well-formed token nobody holds, without an audit row (it names no workspace)", async () => {
    const w = world()
    const res = await w.call("GET", "/Users", { token: scimToken("nobody").token })
    expect(res.status).toBe(401)
    expect(w.events).toEqual([])
    expect(w.kicks).toEqual([])
  })

  it("refuses a revoked token and audits the refusal under its workspace", async () => {
    const w = world({ tokens: [{ seed: "alpha", over: { revokedAt: new Date() } }] })
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(401)
    expect(w.events).toMatchObject([
      {
        tenantId: TENANT,
        type: "scim.auth_failed",
        reason: "revoked",
        data: { directoryId: DIRECTORY },
      },
    ])
    expect(w.kicks).toEqual([])
  })

  it("refuses an expired token", async () => {
    const w = world({
      tokens: [
        { seed: "alpha", over: { expiresAt: new Date("2026-10-21T09:00:00Z") } },
      ],
    })
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(401)
    expect(w.events[0]).toMatchObject({ type: "scim.auth_failed", reason: "expired" })
  })

  it("refuses a token for another directory, on this directory's URL", async () => {
    const w = world({ tokens: [{ seed: "alpha", directoryId: OTHER_DIRECTORY }] })
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(403)
    expect(w.events[0]).toMatchObject({
      type: "scim.auth_failed",
      reason: "wrong_directory",
      data: { directoryId: OTHER_DIRECTORY },
    })
    expect((await w.call("GET", "/Users", { directory: OTHER_DIRECTORY })).status).toBe(
      200,
    )
  })

  it("refuses a token on a URL that names no directory at all", async () => {
    const w = world()
    expect((await w.call("GET", "/Users", { directory: "not-a-uuid" })).status).toBe(
      403,
    )
  })

  it("refuses a token whose directory is gone", async () => {
    const w = world({
      directories: [{ id: OTHER_DIRECTORY }],
      tokens: [{ seed: "alpha" }],
    })
    expect((await w.call("GET", "/Users")).status).toBe(404)
  })

  it("refuses a disabled directory, and says so in the audit log", async () => {
    const w = world({ directories: [{ id: DIRECTORY, enabled: false }] })
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(403)
    expect(w.events[0]).toMatchObject({ reason: "directory_disabled" })
    expect(w.kicks).toEqual([])
  })

  it("ends an old token at once when a new one is issued with no overlap, and later when it overlaps", async () => {
    const w = world()
    await w.dirs.store.issueToken(
      TENANT,
      DIRECTORY,
      { tokenHash: BETA.hash, hint: "i10_scim_beta", createdBy: "u", overlapMs: 0 },
      w.now(),
    )
    expect((await w.call("GET", "/Users")).status).toBe(401)
    expect((await w.call("GET", "/Users", { token: BETA.token })).status).toBe(200)

    const gamma = scimToken("gamma")
    await w.dirs.store.issueToken(
      TENANT,
      DIRECTORY,
      {
        tokenHash: gamma.hash,
        hint: "i10_scim_gamm",
        createdBy: "u",
        overlapMs: 3_600_000,
      },
      w.now(),
    )
    // The older one still works inside the overlap, the new one works at once...
    expect((await w.call("GET", "/Users", { token: BETA.token })).status).toBe(200)
    expect((await w.call("GET", "/Users", { token: gamma.token })).status).toBe(200)
    // ...and the older one stops when the overlap ends.
    w.advance(3_600_001)
    expect((await w.call("GET", "/Users", { token: BETA.token })).status).toBe(401)
    expect((await w.call("GET", "/Users", { token: gamma.token })).status).toBe(200)
  })

  it("notes a token's use at most once a minute", async () => {
    const w = world()
    await w.call("GET", "/Users")
    const first = w.dirs.tokens[0]!.lastUsedAt
    expect(first).toEqual(w.now())
    w.advance(10_000)
    await w.call("GET", "/Users")
    expect(w.dirs.tokens[0]!.lastUsedAt).toEqual(first)
    w.advance(61_000)
    await w.call("GET", "/Users")
    expect(w.dirs.tokens[0]!.lastUsedAt).toEqual(w.now())
  })

  it("never puts the token in an audit row, a log line or an error body", async () => {
    const w = world({
      tokens: [{ seed: "alpha", over: { revokedAt: new Date() } }, { seed: "beta" }],
    })
    const failed = await w.call("GET", "/Users")
    const ok = await w.call("POST", "/Users", { body: ada(), token: BETA.token })
    expect(failed.status).toBe(401)
    expect(ok.status).toBe(201)
    const everything = JSON.stringify([
      w.events,
      w.logged,
      w.dirs.events,
      await failed.clone().text(),
      await ok.clone().text(),
    ])
    for (const t of [ALPHA, BETA]) {
      expect(everything).not.toContain(t.token)
      expect(everything).not.toContain(t.hash)
      expect(everything).not.toContain(t.token.slice(TOKEN_BODY_START))
    }
  })

  it("kicks the directory once authenticated, and not before", async () => {
    const w = world()
    await w.call("GET", "/Users", { token: null })
    expect(w.kicks).toEqual([])
    await w.call("GET", "/Users")
    expect(w.kicks).toEqual([`${TENANT}:${DIRECTORY}`])
  })
})

const TOKEN_BODY_START = "i10_scim_".length

// ── Limits ──────────────────────────────────────────────────────────────────

describe("limits", () => {
  const ip = { "cf-connecting-ip": "203.0.113.7" }

  it("limits requests per client address with a 429 and Retry-After, in SCIM's shape", async () => {
    const w = world({ limits: { perIp: { max: 3, windowSeconds: 60 } } })
    for (let i = 0; i < 3; i++)
      expect((await w.call("GET", "/Users", { headers: ip })).status).toBe(200)
    const res = await w.call("GET", "/Users", { headers: ip })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(await w.json(res)).toMatchObject({ schemas: [SCHEMA.error], status: "429" })
    // Another address is not limited, and the window ends.
    expect(
      (
        await w.call("GET", "/Users", {
          headers: { "cf-connecting-ip": "203.0.113.8" },
        })
      ).status,
    ).toBe(200)
    w.advance(61_000)
    expect((await w.call("GET", "/Users", { headers: ip })).status).toBe(200)
  })

  it("answers failed authentication with 429 after enough of them, and never locks out a valid token", async () => {
    const w = world({ limits: { authFailures: { max: 3, windowSeconds: 60 } } })
    for (let i = 0; i < 3; i++)
      expect(
        (
          await w.call("GET", "/Users", {
            headers: ip,
            token: scimToken(`bad${i}`).token,
          })
        ).status,
      ).toBe(401)
    const blocked = await w.call("GET", "/Users", {
      headers: ip,
      token: scimToken("bad9").token,
    })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    // The same address with a good token is served as ever.
    expect((await w.call("GET", "/Users", { headers: ip })).status).toBe(200)
    // The failures of a known (revoked) token count too, and stop being audited past the limit.
    const r = world({
      limits: { authFailures: { max: 1, windowSeconds: 60 } },
      tokens: [{ seed: "alpha", over: { revokedAt: new Date() } }],
    })
    expect((await r.call("GET", "/Users", { headers: ip })).status).toBe(401)
    expect((await r.call("GET", "/Users", { headers: ip })).status).toBe(429)
    expect(r.events).toHaveLength(1)
  })

  it("counts failures with no trusted address in one bucket rather than in none", async () => {
    const w = world({ limits: { authFailures: { max: 2, windowSeconds: 60 } } })
    const statuses = []
    for (let i = 0; i < 4; i++)
      statuses.push(
        (await w.call("GET", "/Users", { token: scimToken(`b${i}`).token })).status,
      )
    expect(statuses).toEqual([401, 401, 429, 429])
  })

  it("limits each directory once it is authenticated", async () => {
    const w = world({ limits: { perDirectory: { max: 2, windowSeconds: 60 } } })
    expect((await w.call("GET", "/Users")).status).toBe(200)
    expect((await w.call("GET", "/Users")).status).toBe(200)
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).not.toBeNull()
  })

  it("refuses a body over 1 MiB with 413 in SCIM's shape, before it is read", async () => {
    const w = world()
    const res = await w.call("POST", "/Users", {
      raw: JSON.stringify({ userName: "a", filler: "x".repeat(LIMITS.body) }),
    })
    expect(res.status).toBe(413)
    expect(await w.json(res)).toMatchObject({ schemas: [SCHEMA.error], status: "413" })
    expect(w.dirs.users).toHaveLength(0)
  })
})

// ── Content rules ───────────────────────────────────────────────────────────

describe("content rules", () => {
  it("refuses a body that is not JSON by content type: 415", async () => {
    const w = world()
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/xml",
    ]) {
      const res = await w.call("POST", "/Users", { raw: "userName=a", type })
      expect(res.status).toBe(415)
      expect(await w.json(res)).toMatchObject({
        schemas: [SCHEMA.error],
        status: "415",
      })
    }
    expect((await w.call("POST", "/Users", { raw: "{}", type: null })).status).toBe(415)
    const id = (await seed(w)).id
    expect(
      (await w.call("PUT", `/Users/${id}`, { raw: "{}", type: "text/plain" })).status,
    ).toBe(415)
    expect(
      (await w.call("PATCH", `/Users/${id}`, { raw: "{}", type: "text/plain" })).status,
    ).toBe(415)
    expect(w.dirs.users).toHaveLength(1)
  })

  it("accepts application/json, with or without a charset, as well as application/scim+json", async () => {
    const w = world()
    expect(
      (
        await w.call("POST", "/Users", {
          body: ada({ userName: "a@acme.test" }),
          type: "application/json",
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await w.call("POST", "/Users", {
          body: ada({ userName: "b@acme.test" }),
          type: "Application/SCIM+JSON; charset=utf-8",
        })
      ).status,
    ).toBe(201)
  })

  it("refuses malformed JSON and a body that is not an object, as 400", async () => {
    const w = world()
    const broken = await w.call("POST", "/Users", { raw: "{not json" })
    expect(broken.status).toBe(400)
    expect(await w.json(broken)).toMatchObject({ scimType: "invalidSyntax" })
    expect((await w.call("POST", "/Users", { raw: "[1,2]" })).status).toBe(400)
    expect((await w.call("POST", "/Users", { raw: '"x"' })).status).toBe(400)
    expect((await w.call("POST", "/Users", { raw: "" })).status).toBe(400)
  })

  it("answers every success as application/scim+json", async () => {
    const w = world()
    const res = await w.call("GET", "/ServiceProviderConfig")
    expect(res.headers.get("content-type")).toBe("application/scim+json; charset=utf-8")
  })

  it("answers an unknown path in SCIM's shape and the unsupported endpoints with 501", async () => {
    const w = world()
    const missing = await w.call("GET", "/Nothing/here")
    expect(missing.status).toBe(404)
    expect(await w.json(missing)).toMatchObject({
      schemas: [SCHEMA.error],
      status: "404",
    })
    for (const path of [
      "/Bulk",
      "/Me",
      "/.search",
      "/Users/.search",
      "/Groups/.search",
    ])
      expect((await w.call("POST", path, { body: {} })).status).toBe(501)
    expect((await w.call("GET", "/Me")).status).toBe(501)
    // An unauthenticated caller learns nothing about which paths exist.
    expect((await w.call("GET", "/Nothing/here", { token: null })).status).toBe(401)
  })

  it("turns a failing store into a 503 in SCIM's shape without naming what failed", async () => {
    const w = world()
    w.dirs.store.listUsers = async () => {
      throw new Error("connection to 10.0.0.5 refused")
    }
    const res = await w.call("GET", "/Users")
    expect(res.status).toBe(503)
    expect(res.headers.get("retry-after")).toBe("5")
    expect(JSON.stringify(await w.json(res))).not.toContain("10.0.0.5")
    expect(w.logged.some((l) => l.level === "error")).toBe(true)
    expect(JSON.stringify(w.logged)).not.toContain("10.0.0.5")
  })
})

// ── Discovery ───────────────────────────────────────────────────────────────

describe("discovery", () => {
  it("serves ServiceProviderConfig, ResourceTypes and Schemas", async () => {
    const w = world()
    const config = await w.json(await w.call("GET", "/ServiceProviderConfig"))
    expect(config).toMatchObject({
      patch: { supported: true },
      meta: { location: `${BASE}/${DIRECTORY}/ServiceProviderConfig` },
    })
    const types = await w.json(await w.call("GET", "/ResourceTypes"))
    expect(types.Resources.map((t: { id: string }) => t.id)).toEqual(["User", "Group"])
    expect((await w.call("GET", "/ResourceTypes/user")).status).toBe(200)
    expect((await w.call("GET", "/ResourceTypes/Widget")).status).toBe(404)
    const all = await w.json(await w.call("GET", "/Schemas"))
    expect(all.totalResults).toBe(3)
    expect(
      (await w.call("GET", `/Schemas/${encodeURIComponent(SCHEMA.enterprise)}`)).status,
    ).toBe(200)
    expect((await w.call("GET", "/Schemas/urn:nothing")).status).toBe(404)
  })
})

// ── Users ───────────────────────────────────────────────────────────────────

describe("Users: refusals", () => {
  it("refuses a duplicate userName with 409 uniqueness, case-insensitively", async () => {
    const w = world()
    await seed(w)
    const res = await w.call("POST", "/Users", {
      body: ada({ userName: "ADA@acme.test" }),
    })
    expect(res.status).toBe(409)
    expect(await w.json(res)).toMatchObject({ scimType: "uniqueness", status: "409" })
    expect(w.dirs.users).toHaveLength(1)
    expect(w.scheduled).toHaveLength(1)
  })

  it("refuses a PUT or PATCH that would take another user's userName", async () => {
    const w = world()
    await seed(w)
    const other = await seed(w, { userName: "grace@acme.test", externalId: "e2" })
    const put = await w.call("PUT", `/Users/${other.id}`, {
      body: ada({ userName: "Ada@Acme.Test" }),
    })
    expect(put.status).toBe(409)
    const patched = await w.call("PATCH", `/Users/${other.id}`, {
      body: patch({ op: "replace", path: "userName", value: "ada@acme.test" }),
    })
    expect(patched.status).toBe(409)
    expect(w.dirs.users.find((u) => u.id === other.id)!.userName).toBe(
      "grace@acme.test",
    )
  })

  it("lets the same userName live in two directories", async () => {
    const w = world({
      tokens: [{ seed: "alpha" }, { seed: "beta", directoryId: OTHER_DIRECTORY }],
    })
    await seed(w)
    const second = await w.call("POST", "/Users", {
      body: ada(),
      token: BETA.token,
      directory: OTHER_DIRECTORY,
    })
    expect(second.status).toBe(201)
  })

  it("refuses a user without a userName, or with an active that is not a boolean, as 400", async () => {
    const w = world()
    expect((await w.call("POST", "/Users", { body: { active: true } })).status).toBe(
      400,
    )
    expect(
      (await w.call("POST", "/Users", { body: { userName: "a", active: "yes" } }))
        .status,
    ).toBe(400)
    expect(w.dirs.users).toHaveLength(0)
    expect(w.scheduled).toEqual([])
  })

  it("answers 404 for a user that does not exist, a malformed id, another directory's user and a deleted one", async () => {
    const w = world({
      tokens: [{ seed: "alpha" }, { seed: "beta", directoryId: OTHER_DIRECTORY }],
    })
    const mine = await seed(w)
    const theirs = (await (
      await w.call("POST", "/Users", {
        body: ada(),
        token: BETA.token,
        directory: OTHER_DIRECTORY,
      })
    ).json()) as { id: string }
    const missing = "00000000-0000-4000-8000-0000000000ff"
    for (const id of [missing, "banana", theirs.id]) {
      expect((await w.call("GET", `/Users/${id}`)).status).toBe(404)
      expect((await w.call("PUT", `/Users/${id}`, { body: ada() })).status).toBe(404)
      expect(
        (
          await w.call("PATCH", `/Users/${id}`, {
            body: patch({ op: "replace", path: "title", value: "x" }),
          })
        ).status,
      ).toBe(404)
      expect((await w.call("DELETE", `/Users/${id}`)).status).toBe(404)
    }
    expect((await w.call("DELETE", `/Users/${mine.id}`)).status).toBe(204)
    expect((await w.call("GET", `/Users/${mine.id}`)).status).toBe(404)
    expect((await w.call("DELETE", `/Users/${mine.id}`)).status).toBe(404)
    expect(await w.json(await w.call("GET", `/Users/${missing}`))).toMatchObject({
      schemas: [SCHEMA.error],
      status: "404",
    })
  })

  it("refuses an id in a PUT body that is not the resource's", async () => {
    const w = world()
    const { id } = await seed(w)
    const res = await w.call("PUT", `/Users/${id}`, {
      body: ada({ id: "00000000-0000-4000-8000-0000000000aa" }),
    })
    expect(res.status).toBe(400)
    expect(await w.json(res)).toMatchObject({ scimType: "mutability" })
  })

  it("refuses a PATCH that is invalid as a whole and stores none of it", async () => {
    const w = world()
    const { id } = await seed(w)
    const res = await w.call("PATCH", `/Users/${id}`, {
      body: patch(
        { op: "replace", path: "title", value: "Boss" },
        { op: "replace", path: "id", value: "other" },
      ),
    })
    expect(res.status).toBe(400)
    expect(w.dirs.users[0]!.resource.title).toBeUndefined()
    expect(w.scheduled).toHaveLength(1)
  })

  it("refuses filters it does not support as invalidFilter, never as everybody", async () => {
    const w = world()
    await seed(w)
    for (const filter of [
      "userName pr",
      'userName co "a"',
      "active eq true",
      'userName eq "a" or userName eq "b"',
    ]) {
      const res = await w.call("GET", `/Users?filter=${encodeURIComponent(filter)}`)
      expect(res.status).toBe(400)
      expect(await w.json(res)).toMatchObject({ scimType: "invalidFilter" })
    }
    expect((await w.call("GET", "/Users?startIndex=abc")).status).toBe(400)
    expect((await w.call("GET", "/Groups?filter=userName%20eq%20%22a%22")).status).toBe(
      400,
    )
  })

  it("does not show one workspace's directory to another's token", async () => {
    const w = world({
      directories: [{ id: DIRECTORY }, { id: OTHER_DIRECTORY, tenantId: OTHER_TENANT }],
      tokens: [{ seed: "alpha" }],
    })
    await seed(w)
    expect((await w.call("GET", "/Users", { directory: OTHER_DIRECTORY })).status).toBe(
      403,
    )
  })
})

describe("Users: the happy paths", () => {
  it("creates a user: 201, Location, the resource, an outbox entry and an audit row", async () => {
    const w = world()
    const res = await w.call("POST", "/Users", { body: ada({ password: "never" }) })
    expect(res.status).toBe(201)
    const body = await w.json(res)
    expect(res.headers.get("location")).toBe(`${BASE}/${DIRECTORY}/Users/${body.id}`)
    expect(body).toMatchObject({
      schemas: ENTRA,
      userName: "ada@acme.test",
      active: true,
      displayName: "Ada Lovelace",
      name: { givenName: "Ada", familyName: "Lovelace" },
      groups: [],
      meta: { resourceType: "User", location: `${BASE}/${DIRECTORY}/Users/${body.id}` },
    })
    expect(body).not.toHaveProperty("password")
    expect(w.scheduled).toHaveLength(1)
    expect(w.scheduled[0]!.entries).toHaveLength(1)
    expect(w.scheduled[0]!.entries[0]!.directoryUserId).toBe(body.id)
    expect(w.dirs.events).toMatchObject([
      {
        type: "scim.user.created",
        data: { directoryId: DIRECTORY, directoryUserId: body.id },
      },
    ])
    expect(JSON.stringify(w.dirs.events)).not.toContain("ada@acme.test")
  })

  it("lists, filters and pages", async () => {
    const w = world()
    for (const n of ["a", "b", "c"])
      await seed(w, {
        userName: `${n}@acme.test`,
        externalId: `ext-${n}`,
        emails: [{ value: `${n}@acme.test`, primary: true }],
      })
    const all = await w.json(await w.call("GET", "/Users"))
    expect(all).toMatchObject({
      schemas: [SCHEMA.list],
      totalResults: 3,
      itemsPerPage: 3,
      startIndex: 1,
    })
    const paged = await w.json(await w.call("GET", "/Users?startIndex=2&count=1"))
    expect(paged).toMatchObject({ totalResults: 3, itemsPerPage: 1, startIndex: 2 })
    expect(paged.Resources[0].userName).toBe("b@acme.test")
    const none = await w.json(await w.call("GET", "/Users?count=0"))
    expect(none).toMatchObject({ totalResults: 3, itemsPerPage: 0 })
    const byName = await w.json(
      await w.call(
        "GET",
        `/Users?filter=${encodeURIComponent('userName eq "C@ACME.TEST"')}`,
      ),
    )
    expect(byName.totalResults).toBe(1)
    const byExternal = await w.json(
      await w.call(
        "GET",
        `/Users?filter=${encodeURIComponent('externalId eq "ext-a"')}`,
      ),
    )
    expect(byExternal.Resources[0].userName).toBe("a@acme.test")
    const byEmail = await w.json(
      await w.call(
        "GET",
        `/Users?filter=${encodeURIComponent('emails.value eq "B@acme.test"')}`,
      ),
    )
    expect(byEmail.Resources[0].userName).toBe("b@acme.test")
  })

  it("answers Entra's probe for a GUID userName with an empty list, and ignores aadOptscim062020", async () => {
    const w = world()
    await seed(w)
    const res = await w.call(
      "GET",
      `/Users?aadOptscim062020&filter=${encodeURIComponent('userName eq "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10"')}`,
    )
    expect(res.status).toBe(200)
    expect(await w.json(res)).toMatchObject({ totalResults: 0, Resources: [] })
    expect((await w.call("GET", "/Users?aadOptscim062020=true&unknown=1")).status).toBe(
      200,
    )
  })

  it("projects attributes and excludedAttributes on a list and on one user", async () => {
    const w = world()
    const { id } = await seed(w)
    const list = await w.json(await w.call("GET", "/Users?attributes=userName"))
    expect(Object.keys(list.Resources[0]).sort()).toEqual([
      "id",
      "meta",
      "schemas",
      "userName",
    ])
    const one = await w.json(
      await w.call("GET", `/Users/${id}?excludedAttributes=emails,name`),
    )
    expect(one.emails).toBeUndefined()
    expect(one.userName).toBe("ada@acme.test")
  })

  it("reads Entra's string booleans on create and its capitalised PATCH, and audits (de)activation", async () => {
    const w = world()
    const created = await w.call("POST", "/Users", {
      body: ada({
        active: "True",
        emails: [{ value: "ada@acme.test", primary: "True", type: "work" }],
      }),
    })
    const { id } = await w.json(created)
    const off = await w.call("PATCH", `/Users/${id}`, {
      body: patch({ op: "Replace", path: "active", value: "False" }),
    })
    expect(off.status).toBe(200)
    expect((await w.json(off)).active).toBe(false)
    const on = await w.call("PATCH", `/Users/${id}`, {
      body: patch({ op: "Replace", path: "active", value: "True" }),
    })
    expect((await w.json(on)).active).toBe(true)
    expect(w.dirs.events.map((e) => e.type)).toEqual([
      "scim.user.created",
      "scim.user.deactivated",
      "scim.user.reactivated",
    ])
    expect(w.scheduled).toHaveLength(3)
  })

  it("applies Okta's path-less deactivation and Entra's key-as-path fragments", async () => {
    const w = world()
    const { id } = await seed(w)
    const off = await w.call("PATCH", `/Users/${id}`, {
      body: patch({ op: "replace", value: { active: false } }),
    })
    expect((await w.json(off)).active).toBe(false)
    const frag = await w.call("PATCH", `/Users/${id}`, {
      body: patch({
        op: "Replace",
        value: {
          "name.givenName": "Augusta",
          'emails[type eq "work"].value': "augusta@acme.test",
          [`${SCHEMA.enterprise}:department`]: "Analytics",
        },
      }),
    })
    const body = await w.json(frag)
    expect(body.name.givenName).toBe("Augusta")
    expect(body.emails[0].value).toBe("augusta@acme.test")
    expect(body[SCHEMA.enterprise].department).toBe("Analytics")
    expect(w.dirs.users[0]!.email).toBe("augusta@acme.test")
  })

  it("replaces a user on PUT (Okta's profile update), dropping what the new body leaves out", async () => {
    const w = world()
    const { id } = await seed(w)
    const res = await w.call("PUT", `/Users/${id}`, {
      body: {
        id,
        schemas: [SCHEMA.user],
        userName: "ada@acme.test",
        active: true,
        title: "Countess",
      },
    })
    expect(res.status).toBe(200)
    const body = await w.json(res)
    expect(body.title).toBe("Countess")
    expect(body.displayName).toBeUndefined()
    expect(body.id).toBe(id)
    expect(w.dirs.users[0]!.givenName).toBeNull()
  })

  it("deletes: 204, a scheduled entry, the userName free again", async () => {
    const w = world()
    const { id } = await seed(w)
    const res = await w.call("DELETE", `/Users/${id}`)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(w.scheduled.at(-1)!.entries[0]!.directoryUserId).toBe(id)
    expect(w.dirs.outbox.at(-1)!.cause).toBe("deleted")
    expect(w.dirs.events.at(-1)).toMatchObject({ type: "scim.user.deleted" })
    expect((await w.call("POST", "/Users", { body: ada() })).status).toBe(201)
  })

  it("shows a user's groups", async () => {
    const w = world()
    const { id } = await seed(w)
    const group = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "Engineers", members: [{ value: id }] },
      }),
    )
    const user = await w.json(await w.call("GET", `/Users/${id}`))
    expect(user.groups).toEqual([
      {
        value: group.id,
        display: "Engineers",
        $ref: `${BASE}/${DIRECTORY}/Groups/${group.id}`,
      },
    ])
  })
})

// ── Groups ──────────────────────────────────────────────────────────────────

describe("Groups", () => {
  it("creates a group with members, skipping ones that are nobody here and saying nothing of it to the IdP", async () => {
    const w = world()
    const a = await seed(w)
    const res = await w.call("POST", "/Groups", {
      body: {
        schemas: [SCHEMA.group],
        displayName: "Engineers",
        externalId: "g-1",
        members: [
          { value: a.id },
          { value: "00000000-0000-4000-8000-0000000000ff" },
          { value: "banana" },
        ],
      },
    })
    expect(res.status).toBe(201)
    const body = await w.json(res)
    expect(res.headers.get("location")).toBe(`${BASE}/${DIRECTORY}/Groups/${body.id}`)
    expect(body.members).toHaveLength(1)
    expect(body.members[0]).toMatchObject({ value: a.id, type: "User" })
    expect(w.dirs.events.at(-1)).toMatchObject({
      type: "scim.group.created",
      data: { members: 1, skipped: 2 },
    })
    // One entry for the member the group touched.
    expect(w.scheduled.at(-1)!.entries.map((e) => e.directoryUserId)).toEqual([a.id])
  })

  it("holds only its own directory's people", async () => {
    const w = world({
      tokens: [{ seed: "alpha" }, { seed: "beta", directoryId: OTHER_DIRECTORY }],
    })
    const theirs = (await (
      await w.call("POST", "/Users", {
        body: ada(),
        token: BETA.token,
        directory: OTHER_DIRECTORY,
      })
    ).json()) as { id: string }
    const body = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "G", members: [{ value: theirs.id }] },
      }),
    )
    expect(body.members).toEqual([])
  })

  it("filters, reads, projects and 404s", async () => {
    const w = world()
    const g = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "Engineers", externalId: "g-1" },
      }),
    )
    await w.call("POST", "/Groups", { body: { displayName: "Sales" } })
    const found = await w.json(
      await w.call(
        "GET",
        `/Groups?filter=${encodeURIComponent('displayName eq "engineers"')}`,
      ),
    )
    expect(found.totalResults).toBe(1)
    const byExternal = await w.json(
      await w.call(
        "GET",
        `/Groups?filter=${encodeURIComponent('externalId eq "g-1"')}`,
      ),
    )
    expect(byExternal.Resources[0].id).toBe(g.id)
    const slim = await w.json(
      await w.call("GET", `/Groups/${g.id}?excludedAttributes=members`),
    )
    expect(slim.members).toBeUndefined()
    expect((await w.call("GET", "/Groups/banana")).status).toBe(404)
    expect(
      (await w.call("GET", "/Groups/00000000-0000-4000-8000-0000000000ff")).status,
    ).toBe(404)
    expect((await w.call("DELETE", "/Groups/banana")).status).toBe(404)
    expect(
      (
        await w.call("PATCH", `/Groups/banana`, {
          body: patch({ op: "replace", path: "displayName", value: "x" }),
        })
      ).status,
    ).toBe(404)
  })

  it("refuses a group without a displayName and a bad PATCH", async () => {
    const w = world()
    expect((await w.call("POST", "/Groups", { body: { members: [] } })).status).toBe(
      400,
    )
    const g = await w.json(
      await w.call("POST", "/Groups", { body: { displayName: "G" } }),
    )
    expect(
      (
        await w.call("PATCH", `/Groups/${g.id}`, {
          body: patch({ op: "remove", path: "displayName" }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await w.call("PUT", `/Groups/${g.id}`, {
          body: { id: "other", displayName: "G" },
        })
      ).status,
    ).toBe(400)
  })

  it("adds and removes members the way Okta and Entra do, and an entry is scheduled for each person touched", async () => {
    const w = world()
    const a = await seed(w)
    const b = await seed(w, { userName: "b@acme.test", externalId: "eb" })
    const c = await seed(w, { userName: "c@acme.test", externalId: "ec" })
    const g = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "G", members: [{ value: a.id }] },
      }),
    )
    const before = w.scheduled.length

    // Okta: add by path, remove by filter.
    await w.call("PATCH", `/Groups/${g.id}`, {
      body: patch({
        op: "add",
        path: "members",
        value: [{ value: b.id, display: "B" }],
      }),
    })
    expect(w.scheduled.at(-1)!.entries.map((e) => e.directoryUserId)).toEqual([b.id])
    await w.call("PATCH", `/Groups/${g.id}`, {
      body: patch({ op: "remove", path: `members[value eq "${a.id}"]` }),
    })
    expect(w.scheduled.at(-1)!.entries.map((e) => e.directoryUserId)).toEqual([a.id])
    // Entra: remove with a value list, add capitalised.
    await w.call("PATCH", `/Groups/${g.id}`, {
      body: patch(
        { op: "Add", path: "members", value: [{ value: c.id }] },
        { op: "Remove", path: "members", value: [{ value: b.id }] },
      ),
    })
    const members = (await w.json(await w.call("GET", `/Groups/${g.id}`))).members.map(
      (m: { value: string }) => m.value,
    )
    expect(members).toEqual([c.id])
    expect(w.scheduled.length).toBe(before + 3)
    // Removing somebody who is gone is not an error (Okta retries).
    const again = await w.call("PATCH", `/Groups/${g.id}`, {
      body: patch({ op: "remove", path: `members[value eq "${a.id}"]` }),
    })
    expect(again.status).toBe(200)
  })

  it("schedules every member when a group is renamed, because group rules read names", async () => {
    const w = world()
    const a = await seed(w)
    const b = await seed(w, { userName: "b@acme.test", externalId: "eb" })
    const g = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "G", members: [{ value: a.id }, { value: b.id }] },
      }),
    )
    await w.call("PATCH", `/Groups/${g.id}`, {
      body: patch({ op: "replace", value: { displayName: "Renamed" } }),
    })
    expect(
      w.scheduled
        .at(-1)!
        .entries.map((e) => e.directoryUserId)
        .sort(),
    ).toEqual([a.id, b.id].sort())
    await w.call("PUT", `/Groups/${g.id}`, {
      body: { displayName: "Renamed again", members: [{ value: a.id }] },
    })
    expect(
      w.scheduled
        .at(-1)!
        .entries.map((e) => e.directoryUserId)
        .sort(),
    ).toEqual([a.id, b.id].sort())
  })

  it("deletes a group and schedules its former members", async () => {
    const w = world()
    const a = await seed(w)
    const g = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "G", members: [{ value: a.id }] },
      }),
    )
    const res = await w.call("DELETE", `/Groups/${g.id}`)
    expect(res.status).toBe(204)
    expect(w.scheduled.at(-1)!.entries.map((e) => e.directoryUserId)).toEqual([a.id])
    expect((await w.call("GET", `/Groups/${g.id}`)).status).toBe(404)
    expect((await w.json(await w.call("GET", `/Users/${a.id}`))).groups).toEqual([])
  })

  it("takes a deleted user out of its groups", async () => {
    const w = world()
    const a = await seed(w)
    const g = await w.json(
      await w.call("POST", "/Groups", {
        body: { displayName: "G", members: [{ value: a.id }] },
      }),
    )
    await w.call("DELETE", `/Users/${a.id}`)
    expect((await w.json(await w.call("GET", `/Groups/${g.id}`))).members).toEqual([])
  })
})
