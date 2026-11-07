import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import { mountIdentity } from "../src/routes/console/identity.js"
import {
  CREDENTIAL_EVENT_TYPES,
  HOOK_SECRET_PREFIX,
  MAX_EVENT_AGE_MS,
  mintHookSecret,
  redactedConfig,
  storedOktaHook,
} from "../src/identity/okta-event-hook.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import {
  createOktaEventHooks,
  type OktaEventHookRouteDeps,
} from "../src/routes/okta-event-hooks.js"
import type { Connection } from "../src/identity/model.js"
import {
  CONNECTION,
  OTHER_TENANT,
  TENANT,
  connection,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * Okta Event Hooks (#383, B9 step 2b): the owner's secret, the public receiver
 * that checks it, and the events that raise a person's mail credential epoch.
 *
 * ⚠ THE EPOCH RAISE IS A FAKE THAT RECORDS WHO, because what these tests pin is
 * which people a delivery reaches. The statement itself is pinned by
 * credential-epoch.test.ts, and the two meet in
 * identity-okta-event-hook-db.test.ts.
 */

const NOW = new Date("2026-11-07T12:00:00Z")
const HOUR = 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const OTHER_CONN = "44444444-4444-4444-8444-444444444444"
const GENERIC_CONN = "55555555-5555-4555-8555-555555555555"
const NO_SECRET_CONN = "66666666-6666-4666-8666-666666666666"

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex")

const okta = (over: Partial<Connection> = {}) =>
  connection({ protocol: "oidc", provider: "okta", ...over })

interface Logged {
  o: Record<string, unknown>
  m: string
}

/**
 * Two Okta connections in two workspaces, each with its own hook secret; a
 * generic one that has a hash stored anyway; an Okta one with no secret.
 * People: Ada and Bob on the first, and an unrelated "Ada" (the same Okta id
 * string) on the second.
 */
function world(
  options: {
    raise?: (clerkUserId: string) => Promise<void>
    limits?: OktaEventHookRouteDeps["limits"]
  } = {},
) {
  const a = mintHookSecret(NOW)
  const b = mintHookSecret(NOW)
  const stray = mintHookSecret(NOW)
  const mem = memoryStore({
    connections: [
      okta({ config: { oktaEventHook: a.stored, oidc: { clientId: "keep-me" } } }),
      okta({
        id: OTHER_CONN,
        tenantId: OTHER_TENANT,
        config: { oktaEventHook: b.stored },
      }),
      connection({
        id: GENERIC_CONN,
        provider: "generic",
        config: { oktaEventHook: stray.stored },
      }),
      okta({ id: NO_SECRET_CONN }),
    ],
  })
  const raised: string[] = []
  const logged: Logged[] = []
  const deps: OktaEventHookRouteDeps = {
    store: mem.store,
    raiseEpoch:
      options.raise ??
      (async (id) => {
        raised.push(id)
      }),
    take: fixedWindow(null),
    contextSecret: undefined,
    edgeSecret: undefined,
    ...(options.limits ? { limits: options.limits } : {}),
    log: {
      info: (o, m) => logged.push({ o: o as Record<string, unknown>, m }),
      warn: (o, m) => logged.push({ o: o as Record<string, unknown>, m }),
      error: (o, m) => logged.push({ o: o as Record<string, unknown>, m }),
    },
    now: () => NOW,
  }
  const app = new Hono().route("/webhooks", createOktaEventHooks(deps))

  const link = (
    tenantId: string,
    connectionId: string,
    subject: string,
    clerkUserId: string,
    email: string | null,
  ) => mem.store.link(tenantId, { connectionId, subject, clerkUserId, email })

  const call = (
    method: "GET" | "POST",
    id: string,
    opts: {
      auth?: string | null
      body?: unknown
      raw?: string
      challenge?: string
    } = {},
  ) =>
    app.request(`/webhooks/okta/${id}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.auth ? { authorization: opts.auth } : {}),
        ...(opts.challenge ? { "x-okta-verification-challenge": opts.challenge } : {}),
      },
      ...(method === "POST"
        ? { body: opts.raw ?? JSON.stringify(opts.body ?? {}) }
        : {}),
    })

  /** A delivery to the first connection with its own secret, unless told otherwise. */
  const deliver = (events: unknown[], auth: string | null = a.secret) =>
    call("POST", CONNECTION, { auth, body: delivery(events) })

  return { mem, a, b, stray, app, raised, logged, link, call, deliver, deps }
}

const delivery = (events: unknown[]) => ({
  eventType: "com.okta.event_hook",
  eventId: "85b60edb-4263-4e13-993b-818e26201052",
  data: { events },
})

/** An event as Okta's System Log carries it: an admin acting on Ada. */
const event = (eventType: string, over: Record<string, unknown> = {}) => ({
  uuid: crypto.randomUUID(),
  published: ago(1000),
  eventType,
  outcome: { result: "SUCCESS" },
  actor: { id: "00u_admin", type: "User", alternateId: "admin@acme.test" },
  target: [{ id: "00u_ada", type: "User", alternateId: "ada@acme.test" }],
  ...over,
})

const seeded = async (over: Parameters<typeof world>[0] = {}) => {
  const w = world(over)
  await w.link(TENANT, CONNECTION, "00u_ada", "user_ada", "ada@acme.test")
  await w.link(TENANT, CONNECTION, "00u_bob", "user_bob", "bob@acme.test")
  await w.link(TENANT, CONNECTION, "00u_admin", "user_okta_admin", "admin@acme.test")
  // The same Okta id string, a different org: not the same person.
  await w.link(OTHER_TENANT, OTHER_CONN, "00u_ada", "user_other_ada", "ada@other.test")
  return w
}

describe("Okta event hook: what the secret is", () => {
  it("is a prefixed random token, stored as nothing but its SHA-256", () => {
    const { secret, stored } = mintHookSecret(NOW)
    expect(secret.startsWith(HOOK_SECRET_PREFIX)).toBe(true)
    expect(secret.length).toBeGreaterThan(HOOK_SECRET_PREFIX.length + 40)
    expect(stored.secretHash).toBe(sha256(secret))
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(stored.hint).toBe(secret.slice(0, HOOK_SECRET_PREFIX.length + 4))
    expect(mintHookSecret(NOW).secret).not.toBe(secret)
  })

  it("is dropped from the config the console may see, and nothing else is", () => {
    const { stored } = mintHookSecret(NOW)
    const config = { oidc: { clientId: "c" }, oktaEventHook: stored }
    const shown = redactedConfig(config)
    expect(JSON.stringify(shown)).not.toContain(stored.secretHash)
    expect(shown).toEqual({
      oidc: { clientId: "c" },
      oktaEventHook: { hint: stored.hint, issuedAt: stored.issuedAt },
    })
    expect(redactedConfig({ oidc: {} })).toEqual({ oidc: {} })
  })

  it("is ignored when the stored value is not a digest", () => {
    expect(
      storedOktaHook({ config: { oktaEventHook: { secretHash: "not-hex" } } }),
    ).toEqual({})
    expect(storedOktaHook({ config: { oktaEventHook: "x" } })).toEqual({})
  })

  it("subscribes the hook to exactly the seven credential events", () => {
    expect([...CREDENTIAL_EVENT_TYPES].sort()).toEqual([
      "user.account.lock",
      "user.account.reset_password",
      "user.account.update_password",
      "user.lifecycle.deactivate",
      "user.lifecycle.delete.initiated",
      "user.lifecycle.suspend",
      "user.session.clear",
    ])
  })
})

describe("Okta event hook: verification and refusals", () => {
  it("answers Okta's one-time challenge with the right secret", async () => {
    const w = await seeded()
    const res = await w.call("GET", CONNECTION, {
      auth: w.a.secret,
      challenge: "chal-123",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ verification: "chal-123" })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(w.raised).toEqual([])
  })

  it("takes the secret with or without a Bearer prefix, since Okta sends what the admin typed", async () => {
    const w = await seeded()
    for (const auth of [w.a.secret, `Bearer ${w.a.secret}`, `bearer  ${w.a.secret}`])
      expect((await w.call("GET", CONNECTION, { auth, challenge: "c" })).status).toBe(
        200,
      )
  })

  it("needs the challenge header, once the caller is proven", async () => {
    const w = await seeded()
    expect((await w.call("GET", CONNECTION, { auth: w.a.secret })).status).toBe(400)
  })

  // ⚠ ONE ANSWER FOR EVERY WAY TO FAIL: the status, the body and the headers
  // that matter say nothing about which check refused.
  it("refuses an unknown connection, a malformed id, a non-Okta connection, an Okta one with no secret, a wrong secret and no secret in one identical way", async () => {
    const w = await seeded()
    const stranger = "77777777-7777-4777-8777-777777777777"
    const cases: [string, string, string | null][] = [
      ["an unknown connection", stranger, w.a.secret],
      ["a malformed id", "not-a-uuid", w.a.secret],
      ["a generic connection with a hash stored", GENERIC_CONN, w.stray.secret],
      ["an Okta connection with no secret", NO_SECRET_CONN, w.a.secret],
      ["another connection's secret", CONNECTION, w.b.secret],
      ["a wrong secret", CONNECTION, `${HOOK_SECRET_PREFIX}wrong`],
      ["no header", CONNECTION, null],
      ["an empty secret", CONNECTION, "Bearer "],
    ]
    const seen = new Set<string>()
    for (const [what, id, auth] of cases) {
      for (const method of ["GET", "POST"] as const) {
        const res = await w.call(method, id, {
          auth,
          challenge: "c",
          body: delivery([event("user.session.clear")]),
        })
        expect(res.status, `${method} with ${what}`).toBe(401)
        seen.add(await res.text())
      }
    }
    expect(seen.size).toBe(1)
    expect(w.raised).toEqual([])
  })

  it("compares a hash of the secret, never the secret itself", async () => {
    const w = await seeded()
    const stored = w.mem.connections.get(CONNECTION)!.config.oktaEventHook as {
      secretHash: string
    }
    // The stored digest is not itself an accepted secret.
    expect(
      (await w.call("GET", CONNECTION, { auth: stored.secretHash, challenge: "c" }))
        .status,
    ).toBe(401)
  })

  it("accepts a hook while the connection is still a draft, since the admin verifies it during setup", async () => {
    const w = await seeded()
    w.mem.connections.set(CONNECTION, {
      ...w.mem.connections.get(CONNECTION)!,
      status: "draft",
    })
    expect((await w.deliver([event("user.account.update_password")])).status).toBe(200)
    expect(w.raised).toEqual(["user_ada"])
  })

  it("counts failures per address and then stops answering them, while a good caller is untouched", async () => {
    const w = await seeded({ limits: { authFailures: { max: 2, windowSeconds: 60 } } })
    const bad = () => w.call("POST", CONNECTION, { auth: "nope", body: delivery([]) })
    expect((await bad()).status).toBe(401)
    expect((await bad()).status).toBe(401)
    const limited = await bad()
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).not.toBeNull()
    expect((await w.deliver([event("user.account.update_password")])).status).toBe(200)
    expect(w.raised).toEqual(["user_ada"])
  })

  it("caps an authenticated connection per minute", async () => {
    const w = await seeded({ limits: { perConnection: { max: 2, windowSeconds: 60 } } })
    expect((await w.deliver([])).status).toBe(200)
    expect((await w.deliver([])).status).toBe(200)
    expect((await w.deliver([])).status).toBe(429)
  })

  it("is a 503 on a deployment with no hooks wired, never an open door", async () => {
    const app = new Hono().route("/webhooks", createOktaEventHooks(undefined))
    const res = await app.request(`/webhooks/okta/${CONNECTION}`, {
      method: "POST",
      headers: { authorization: "anything" },
      body: "{}",
    })
    expect(res.status).toBe(503)
  })

  it("refuses a body that is not a delivery, after proving the caller", async () => {
    const w = await seeded()
    for (const body of [{}, { data: {} }, { data: { events: "x" } }, [], "x"]) {
      const res = await w.call("POST", CONNECTION, { auth: w.a.secret, body })
      expect(res.status).toBe(400)
    }
    expect(
      (await w.call("POST", CONNECTION, { auth: w.a.secret, raw: "{not json" })).status,
    ).toBe(400)
    expect(w.raised).toEqual([])
  })
})

describe("Okta event hook: which events raise whose epoch", () => {
  for (const type of [...CREDENTIAL_EVENT_TYPES].sort()) {
    it(`${type} raises the person it names, and nobody else`, async () => {
      const w = await seeded()
      const res = await w.deliver([event(type)])
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("")
      // Ada, not the admin who acted, not Bob, not the other org's Ada.
      expect(w.raised).toEqual(["user_ada"])
    })
  }

  it("ignores every other event type with a 200", async () => {
    const w = await seeded()
    const res = await w.deliver(
      [
        "user.session.start",
        "user.session.end",
        "user.lifecycle.create",
        "user.lifecycle.activate",
        "user.lifecycle.unsuspend",
        "user.lifecycle.delete.completed",
        "user.account.unlock_token",
        "group.user_membership.add",
        "com.okta.event_hook",
      ].map((t) => event(t)),
    )
    expect(res.status).toBe(200)
    expect(w.raised).toEqual([])
  })

  it("ignores an attempt that changed nothing, and acts when the outcome is success or missing", async () => {
    const w = await seeded()
    await w.deliver([
      event("user.account.reset_password", { outcome: { result: "FAILURE" } }),
      event("user.account.reset_password", { outcome: { result: "SKIPPED" } }),
    ])
    expect(w.raised).toEqual([])
    await w.deliver([event("user.account.reset_password", { outcome: undefined })])
    expect(w.raised).toEqual(["user_ada"])
  })

  it("raises each person once however many events name them, and every person a batch names", async () => {
    const w = await seeded()
    const bob = {
      target: [{ id: "00u_bob", type: "User", alternateId: "bob@acme.test" }],
    }
    await w.deliver([
      event("user.account.update_password"),
      event("user.session.clear"),
      event("user.lifecycle.suspend"),
      event("user.account.lock", bob),
    ])
    expect([...w.raised].sort()).toEqual(["user_ada", "user_bob"])
  })

  it("does nothing for a person the connection does not know", async () => {
    const w = await seeded()
    const res = await w.deliver([
      event("user.lifecycle.deactivate", {
        target: [{ id: "00u_nobody", type: "User", alternateId: "nobody@acme.test" }],
      }),
    ])
    expect(res.status).toBe(200)
    expect(w.raised).toEqual([])
  })

  it("only reads User targets: an app or a group with the same id is nobody", async () => {
    const w = await seeded()
    await w.deliver([
      event("user.session.clear", {
        target: [{ id: "00u_ada", type: "AppInstance", alternateId: "ada@acme.test" }],
        actor: { id: "00u_ada", type: "SystemPrincipal" },
      }),
    ])
    expect(w.raised).toEqual([])
  })

  it("takes a User actor as the person when no target is a user, as in a self-service change", async () => {
    const w = await seeded()
    await w.deliver([
      event("user.account.update_password", {
        actor: { id: "00u_bob", type: "User", alternateId: "bob@acme.test" },
        target: [{ id: "lae42", type: "AuthenticatorEnrollment" }],
      }),
    ])
    expect(w.raised).toEqual(["user_bob"])
  })

  describe("when no link has the Okta id", () => {
    it("finds a SAML link whose subject is the login", async () => {
      const w = await seeded()
      await w.link(TENANT, CONNECTION, "carol@acme.test", "user_carol", null)
      await w.deliver([
        event("user.account.reset_password", {
          target: [{ id: "00u_carol", type: "User", alternateId: "carol@acme.test" }],
        }),
      ])
      expect(w.raised).toEqual(["user_carol"])
    })

    it("finds the address the link last asserted, whatever the case", async () => {
      const w = await seeded()
      await w.link(TENANT, CONNECTION, "NameID-9", "user_dan", "dan@acme.test")
      await w.deliver([
        event("user.session.clear", {
          target: [{ id: "00u_dan", type: "User", alternateId: "Dan@Acme.test" }],
        }),
      ])
      expect(w.raised).toEqual(["user_dan"])
    })

    it("finds nobody for a login that is no address and matches no subject", async () => {
      const w = await seeded()
      await w.deliver([
        event("user.session.clear", {
          target: [{ id: "00u_zoe", type: "User", alternateId: "zoe" }],
        }),
      ])
      expect(w.raised).toEqual([])
    })
  })

  describe("workspace and connection isolation", () => {
    it("never reaches a person on another connection, even with the same Okta id", async () => {
      const w = await seeded()
      await w.deliver([event("user.account.update_password")])
      expect(w.raised).not.toContain("user_other_ada")
      // And the other org's own hook reaches only its own people.
      w.raised.length = 0
      const res = await w.call("POST", OTHER_CONN, {
        auth: w.b.secret,
        body: delivery([event("user.account.update_password")]),
      })
      expect(res.status).toBe(200)
      expect(w.raised).toEqual(["user_other_ada"])
    })

    it("does not let one connection's secret speak for another's", async () => {
      const w = await seeded()
      const res = await w.call("POST", OTHER_CONN, {
        auth: w.a.secret,
        body: delivery([event("user.account.update_password")]),
      })
      expect(res.status).toBe(401)
      expect(w.raised).toEqual([])
    })

    it("does not find a person by an address another connection holds", async () => {
      const w = await seeded()
      await w.deliver([
        event("user.session.clear", {
          target: [{ id: "00u_x", type: "User", alternateId: "ada@other.test" }],
        }),
      ])
      expect(w.raised).toEqual([])
    })
  })

  describe("old and repeated events", () => {
    it("acts on an event inside the bound and ignores one past it", async () => {
      const w = await seeded()
      await w.deliver([
        event("user.account.update_password", {
          published: ago(MAX_EVENT_AGE_MS + 1000),
        }),
      ])
      expect(w.raised).toEqual([])
      await w.deliver([
        event("user.account.update_password", {
          published: ago(MAX_EVENT_AGE_MS - 60_000),
        }),
      ])
      expect(w.raised).toEqual(["user_ada"])
    })

    it("keeps its bound longer than the longest a password is remembered (3 hours)", () => {
      expect(MAX_EVENT_AGE_MS).toBeGreaterThanOrEqual(2 * 3 * HOUR)
    })

    it("acts when the timestamp is missing, unreadable or in the future", async () => {
      const w = await seeded()
      for (const published of [undefined, "yesterday-ish", ago(-HOUR)]) {
        w.raised.length = 0
        await w.deliver([event("user.session.clear", { published })])
        expect(w.raised).toEqual(["user_ada"])
      }
    })

    it("raises again on a replay, which changes nothing a first raise did not", async () => {
      const w = await seeded()
      const body = [event("user.account.update_password")]
      expect((await w.deliver(body)).status).toBe(200)
      expect((await w.deliver(body)).status).toBe(200)
      expect(w.raised).toEqual(["user_ada", "user_ada"])
    })

    it("logs the event uuid of what it acted on, and never a login or an Okta id", async () => {
      const w = await seeded()
      const e = event("user.account.update_password")
      await w.deliver([e])
      const line = w.logged.find((l) => l.m.includes("raised"))
      expect(line?.o.eventUuids).toEqual([e.uuid])
      const everything = JSON.stringify(w.logged)
      for (const secret of ["ada@acme.test", "00u_ada", w.a.secret])
        expect(everything).not.toContain(secret)
    })
  })

  describe("a damaged batch", () => {
    it("applies the readable events and skips the garbage", async () => {
      const w = await seeded()
      const res = await w.deliver([
        null,
        "x",
        { eventType: 5 },
        { eventType: "user.session.clear", target: "nope" },
        event("user.account.update_password"),
      ])
      expect(res.status).toBe(200)
      expect(w.raised).toEqual(["user_ada"])
    })

    it("is a 503 when a raise fails, so Okta sends it again, and still raises everyone else", async () => {
      const attempted: string[] = []
      const w = await seeded({
        raise: async (id) => {
          attempted.push(id)
          if (id === "user_ada") throw new Error("database is down")
        },
      })
      const res = await w.deliver([
        event("user.account.update_password"),
        event("user.account.lock", {
          target: [{ id: "00u_bob", type: "User", alternateId: "bob@acme.test" }],
        }),
      ])
      expect(res.status).toBe(503)
      expect(res.headers.get("retry-after")).not.toBeNull()
      expect([...attempted].sort()).toEqual(["user_ada", "user_bob"])
    })

    it("is a 503 when the link lookup fails", async () => {
      const w = await seeded()
      w.mem.store.identityBySubject = async () => {
        throw new Error("database is down")
      }
      const res = await w.deliver([event("user.account.update_password")])
      expect(res.status).toBe(503)
      expect(w.raised).toEqual([])
    })
  })
})

// ── The owner's side ─────────────────────────────────────────────────────

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

function owned(
  options: {
    fresh?: boolean
    wired?: boolean
    over?: Partial<Connection>
    status?: Connection["status"]
  } = {},
) {
  const w = world()
  // Start from a connection that has no hook, as a fresh one does.
  const bare = okta({
    ...(options.status ? { status: options.status } : {}),
    config: { oidc: { clientId: "keep-me" } },
    ...options.over,
  })
  w.mem.connections.set(bare.id, bare)
  let fresh = options.fresh ?? true
  const apps = new Map<string, Hono>()
  const as = (userId: string) => {
    const cached = apps.get(userId)
    if (cached) return cached
    const a = new Hono()
    a.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", { userId, orgId: "org_acme" } as never)
      c.set("freshAuth", (async () => ({ status: fresh ? "fresh" : "stale" })) as never)
      await next()
    })
    mountIdentity(a, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: w.mem.store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test"],
        deprovision: {},
        log: w.deps.log,
        ...(options.wired === false
          ? {}
          : {
              oktaHook: {
                url: (id: string) => `https://api.i10.test/webhooks/okta/${id}`,
                now: () => NOW,
              },
            }),
      },
    } as unknown as ConsoleDeps)
    apps.set(userId, a)
    return a
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const base = `/identity/connections/${bare.id}/okta-event-hook`
  return {
    ...w,
    owner: call,
    base,
    id: bare.id,
    setFresh: (v: boolean) => (fresh = v),
    stored: () => storedOktaHook(w.mem.connections.get(bare.id)!),
    config: () => w.mem.connections.get(bare.id)!.config,
    /** Everything the fake holds, to prove a secret is in none of it. */
    everything: () =>
      JSON.stringify({
        connections: [...w.mem.connections.values()],
        secrets: [...w.mem.secrets.entries()],
        events: w.mem.events,
      }),
    mint: async () => {
      const res = await call("user_owner", "POST", `${base}/secret`)
      return { res, body: (await res.json()) as Record<string, unknown> }
    },
    hook: (secret: string | null, events: unknown[] = []) =>
      w.call("POST", bare.id, { auth: secret, body: delivery(events) }),
  }
}

describe("Okta event hook: making the secret", () => {
  it("shows the secret once, keeps only its SHA-256, and leaves it out of everything else", async () => {
    const w = owned()
    const { res, body } = await w.mint()
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const secret = body.secret as string
    expect(secret.startsWith(HOOK_SECRET_PREFIX)).toBe(true)
    expect(w.stored().secretHash).toBe(sha256(secret))
    expect(w.everything()).not.toContain(secret)
    expect(body).toMatchObject({
      url: `https://api.i10.test/webhooks/okta/${w.id}`,
      header: "Authorization",
      secretSet: true,
      hint: secret.slice(0, HOOK_SECRET_PREFIX.length + 4),
      events: [...CREDENTIAL_EVENT_TYPES],
    })
    expect(JSON.stringify(body)).not.toContain(w.stored().secretHash)
  })

  it("never shows it again: the view and the connection list carry neither secret nor hash", async () => {
    const w = owned()
    const { body } = await w.mint()
    const hash = w.stored().secretHash!
    for (const path of [w.base, "/identity/connections"]) {
      const res = await w.owner("user_admin", "GET", path)
      const text = await res.text()
      expect(res.status, path).toBe(200)
      expect(text, path).not.toContain(body.secret as string)
      expect(text, path).not.toContain(hash)
    }
    const view = (await (await w.owner("user_admin", "GET", w.base)).json()) as Record<
      string,
      unknown
    >
    expect(view.secretSet).toBe(true)
    expect(view).not.toHaveProperty("secret")
  })

  it("is accepted by the receiver, and leaves the rest of the connection's config alone", async () => {
    const w = owned()
    const { body } = await w.mint()
    expect((await w.hook(body.secret as string)).status).toBe(200)
    expect(w.config().oidc).toEqual({ clientId: "keep-me" })
    expect(w.config()).toHaveProperty("oktaEventHook")
  })

  it("replaces the old secret on rotation, at once", async () => {
    const w = owned()
    const first = (await w.mint()).body.secret as string
    expect((await w.hook(first)).status).toBe(200)
    const second = (await w.mint()).body.secret as string
    expect(second).not.toBe(first)
    expect((await w.hook(first)).status).toBe(401)
    expect((await w.hook(second)).status).toBe(200)
    expect(w.stored().secretHash).toBe(sha256(second))
    expect(w.everything()).not.toContain(first)
    expect(w.everything()).not.toContain(second)
  })

  it("is audited with the actor, whether it rotated, and never the secret", async () => {
    const w = owned()
    await w.mint()
    await w.mint()
    const events = w.mem.events.filter((e) => e.type === "connection.secret_set")
    expect(events.map((e) => e.data)).toEqual([
      { kind: "okta_event_hook", rotated: false, status: "active" },
      { kind: "okta_event_hook", rotated: true, status: "active" },
    ])
    expect(events.every((e) => e.actorUserId === "user_owner")).toBe(true)
    expect(events.every((e) => e.connectionId === w.id)).toBe(true)
  })

  it("is an owner's, on a draft connection too: an admin and a member change nothing", async () => {
    for (const status of ["draft", "active"] as const) {
      const w = owned({ status })
      for (const user of ["user_admin", "user_m"]) {
        const res = await w.owner(user, "POST", `${w.base}/secret`)
        expect(res.status, `${user} on ${status}`).toBe(403)
        expect(((await res.json()) as { message: string }).message).toMatch(/owner/)
        expect((await w.owner(user, "DELETE", `${w.base}/secret`)).status).toBe(403)
      }
      expect(w.stored()).toEqual({})
      expect(w.mem.events).toEqual([])
    }
  })

  it("needs a fresh step-up, and stores nothing without it", async () => {
    const w = owned({ fresh: false })
    expect((await w.owner("user_owner", "POST", `${w.base}/secret`)).status).toBe(403)
    expect((await w.owner("user_owner", "DELETE", `${w.base}/secret`)).status).toBe(403)
    expect(w.stored()).toEqual({})
    expect(w.mem.events).toEqual([])
    w.setFresh(true)
    expect((await w.owner("user_owner", "POST", `${w.base}/secret`)).status).toBe(201)
  })

  it("is for an admin to see and a member not", async () => {
    const w = owned()
    expect((await w.owner("user_admin", "GET", w.base)).status).toBe(200)
    expect((await w.owner("user_m", "GET", w.base)).status).toBe(403)
  })

  it("is for Okta connections only", async () => {
    const w = owned({ over: { provider: "entra" } })
    for (const [method, path] of [
      ["GET", w.base],
      ["POST", `${w.base}/secret`],
      ["DELETE", `${w.base}/secret`],
    ] as const)
      expect((await w.owner("user_owner", method, path)).status).toBe(422)
    expect(w.stored()).toEqual({})
  })

  it("answers 404 for a malformed id and for another workspace's connection", async () => {
    const w = owned()
    const before = JSON.stringify(w.mem.connections.get(OTHER_CONN))
    for (const id of ["nope", OTHER_CONN]) {
      const path = `/identity/connections/${id}/okta-event-hook`
      expect((await w.owner("user_owner", "GET", path)).status).toBe(404)
      expect((await w.owner("user_owner", "POST", `${path}/secret`)).status).toBe(404)
      expect((await w.owner("user_owner", "DELETE", `${path}/secret`)).status).toBe(404)
    }
    expect(JSON.stringify(w.mem.connections.get(OTHER_CONN))).toBe(before)
    expect(w.mem.events).toEqual([])
  })

  it("answers 501 where event hooks are not wired", async () => {
    const w = owned({ wired: false })
    expect((await w.owner("user_owner", "GET", w.base)).status).toBe(501)
    expect((await w.owner("user_owner", "POST", `${w.base}/secret`)).status).toBe(501)
    expect(w.stored()).toEqual({})
  })
})

describe("Okta event hook: turning it off", () => {
  it("stops the receiver at once, keeps the rest of the config, and is audited", async () => {
    const w = owned()
    const { body } = await w.mint()
    const secret = body.secret as string
    const res = await w.owner("user_owner", "DELETE", `${w.base}/secret`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { secretSet: boolean }).secretSet).toBe(false)
    expect((await w.hook(secret)).status).toBe(401)
    expect(w.config()).toEqual({ oidc: { clientId: "keep-me" } })
    expect(w.mem.events.filter((e) => e.type === "connection.secret_revoked")).toEqual([
      expect.objectContaining({
        actorUserId: "user_owner",
        data: { kind: "okta_event_hook", status: "active" },
      }),
    ])
  })

  it("audits nothing when there was nothing to turn off", async () => {
    const w = owned()
    expect((await w.owner("user_owner", "DELETE", `${w.base}/secret`)).status).toBe(200)
    expect(w.mem.events).toEqual([])
  })
})
