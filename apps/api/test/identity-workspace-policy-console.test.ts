import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import { GRACE_MS } from "../src/routes/console/identity-workspace-policy.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import {
  IDLE_TIMEOUT_SECONDS_LIMIT,
  IDLE_TIMEOUT_SECONDS_MIN,
  MAX_SESSION_SECONDS_LIMIT,
  MAX_SESSION_SECONDS_MIN,
} from "../src/identity/workspace-policy.js"
import { TENANT, connection, log, memoryClerk, memoryStore } from "./identity-fakes.js"
import { memoryWorkspacePolicy } from "./identity-workspace-fakes.js"

/**
 * The console routes for the workspace session policy, the second-factor rule
 * and the IP allowlist (#345). Refusals first: who may not, what is not valid,
 * and the owner who would lock themselves out.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

function consoleApp(wired = true) {
  const store = memoryStore({ connections: [connection()] })
  const policy = memoryWorkspacePolicy(store)
  let forgotten = 0
  let fresh = true
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" } as never)
    c.set("user", { userId: c.req.header("x-user") ?? "", orgId: "org_acme" } as never)
    c.set("freshAuth", (async () => ({ status: fresh ? "fresh" : "stale" })) as never)
    await next()
  })
  mountIdentity(app, {
    roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
    identity: {
      store: store.store,
      clerk: memoryClerk().clerk,
      gate: { forget: () => {} },
      protocols: ["test"],
      deprovision: {},
      ...(wired
        ? {
            workspacePolicy: {
              store: policy.store,
              gate: { forgetTenant: () => forgotten++ },
              contextSecret: undefined,
            },
          }
        : {}),
      log,
    },
  } as unknown as ConsoleDeps)
  const call = (
    userId: string,
    method: string,
    path: string,
    body?: unknown,
    ip: string | null = "203.0.113.7",
  ) =>
    app.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-user": userId,
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    app,
    store,
    policy,
    call,
    forgotten: () => forgotten,
    stale: () => (fresh = false),
    events: (type: string) => store.events.filter((e) => e.type === type),
  }
}

const SESSION = "/identity/session-policy"
const FACTOR = "/identity/second-factor-policy"
const IPS = "/identity/ip-allowlist"
const valid = { maxSessionSeconds: 28_800, idleTimeoutSeconds: 1800 }

describe("who may read and who may change", () => {
  for (const path of [SESSION, FACTOR, IPS]) {
    it(`${path}: a member cannot read, an admin can, only an owner can change`, async () => {
      const w = consoleApp()
      expect((await w.call("user_m", "GET", path)).status).toBe(403)
      expect((await w.call("user_admin", "GET", path)).status).toBe(200)
      const bodies: Record<string, unknown> = {
        [SESSION]: valid,
        [FACTOR]: { required: true },
        [IPS]: { console: false, apiKeys: false, ranges: [] },
      }
      for (const user of ["user_admin", "user_m", "user_stranger"])
        expect((await w.call(user, "PUT", path, bodies[path])).status).toBe(403)
      expect(w.policy.policies.size).toBe(0)
      expect(w.store.events).toHaveLength(0)
    })

    it(`${path}: refuses a change without step-up`, async () => {
      const w = consoleApp()
      w.stale()
      const bodies: Record<string, unknown> = {
        [SESSION]: valid,
        [FACTOR]: { required: true },
        [IPS]: { console: false, apiKeys: false, ranges: [] },
      }
      const res = await w.call("user_owner", "PUT", path, bodies[path])
      expect(res.status).not.toBe(200)
      expect(w.policy.policies.size).toBe(0)
    })

    it(`${path}: answers 501 on a deployment without the policy store`, async () => {
      const w = consoleApp(false)
      expect((await w.call("user_owner", "GET", path)).status).toBe(501)
    })
  }
})

describe("session policy", () => {
  const refusals: [string, unknown][] = [
    ["a missing field", { maxSessionSeconds: 28_800 }],
    ["an unknown field", { ...valid, extra: 1 }],
    [
      "a maximum below the floor",
      { ...valid, maxSessionSeconds: MAX_SESSION_SECONDS_MIN - 1 },
    ],
    [
      "a maximum above the ceiling",
      { ...valid, maxSessionSeconds: MAX_SESSION_SECONDS_LIMIT + 1 },
    ],
    [
      "an idle timeout below the floor",
      { ...valid, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS_MIN - 1 },
    ],
    [
      "an idle timeout above the ceiling",
      { ...valid, idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS_LIMIT + 1 },
    ],
    ["a fractional number", { ...valid, maxSessionSeconds: 3600.5 }],
    ["a string", { ...valid, maxSessionSeconds: "3600" }],
    ["zero", { ...valid, idleTimeoutSeconds: 0 }],
    ["a negative number", { ...valid, maxSessionSeconds: -1 }],
    ["not an object", [1, 2]],
  ]
  for (const [name, body] of refusals)
    it(`refuses ${name}`, async () => {
      const w = consoleApp()
      const res = await w.call("user_owner", "PUT", SESSION, body)
      expect(res.status).toBe(422)
      expect(w.policy.policies.size).toBe(0)
      expect(w.store.events).toHaveLength(0)
    })

  it("saves, audits before and after, and drops the gate's cache", async () => {
    const w = consoleApp()
    const res = await w.call("user_owner", "PUT", SESSION, valid)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(valid)
    expect(w.forgotten()).toBe(1)
    expect(w.events("session_policy.updated")).toEqual([
      {
        tenantId: TENANT,
        type: "session_policy.updated",
        actorUserId: "user_owner",
        data: {
          before: { maxSessionSeconds: null, idleTimeoutSeconds: null },
          after: valid,
        },
      },
    ])
    const read = await w.call("user_admin", "GET", SESSION)
    expect(await read.json()).toMatchObject({
      ...valid,
      bounds: { maxSessionSeconds: { min: MAX_SESSION_SECONDS_MIN } },
    })
  })

  it("takes both limits off with null", async () => {
    const w = consoleApp()
    await w.call("user_owner", "PUT", SESSION, valid)
    const res = await w.call("user_owner", "PUT", SESSION, {
      maxSessionSeconds: null,
      idleTimeoutSeconds: null,
    })
    expect(res.status).toBe(200)
    expect(w.events("session_policy.updated").at(-1)).toMatchObject({
      data: {
        before: valid,
        after: { maxSessionSeconds: null, idleTimeoutSeconds: null },
      },
    })
  })
})

describe("second-factor policy", () => {
  it("refuses a body that is not exactly { required: boolean }", async () => {
    const w = consoleApp()
    for (const body of [
      {},
      { required: "yes" },
      { required: true, extra: 1 },
      { required: 1 },
    ])
      expect((await w.call("user_owner", "PUT", FACTOR, body)).status).toBe(422)
    expect(w.store.events).toHaveLength(0)
  })

  it("turns it on and off, audited", async () => {
    const w = consoleApp()
    expect(await (await w.call("user_admin", "GET", FACTOR)).json()).toEqual({
      required: false,
    })
    const on = await w.call("user_owner", "PUT", FACTOR, { required: true })
    expect(await on.json()).toEqual({ required: true })
    await w.call("user_owner", "PUT", FACTOR, { required: false })
    expect(w.events("second_factor_policy.updated").map((e) => e.data)).toEqual([
      { before: false, after: true },
      { before: true, after: false },
    ])
    expect(w.forgotten()).toBe(2)
  })
})

describe("IP allowlist", () => {
  const list = (over: Record<string, unknown> = {}) => ({
    console: true,
    apiKeys: false,
    ranges: ["203.0.113.0/24"],
    ...over,
  })

  const refusals: [string, unknown][] = [
    ["a missing switch", { console: true, ranges: ["203.0.113.0/24"] }],
    ["an unknown field", list({ extra: 1 })],
    ["a switch that is not a boolean", list({ apiKeys: "yes" })],
    ["ranges that are not a list", list({ ranges: "203.0.113.0/24" })],
    ["a range that is not an address", list({ ranges: ["203.0.113.0/24", "hello"] })],
    ["a /0 range", list({ ranges: ["0.0.0.0/0"] })],
    ["an IPv6 /0 range", list({ ranges: ["::/0"] })],
    ["a prefix that is too long", list({ ranges: ["203.0.113.0/33"] })],
    [
      "more than 100 ranges",
      list({ ranges: Array.from({ length: 101 }, (_, i) => `10.0.${i}.0/24`) }),
    ],
    ["an empty list with the console switch on", list({ ranges: [] })],
    [
      "an empty list with the API-key switch on",
      list({ console: false, apiKeys: true, ranges: [] }),
    ],
  ]
  for (const [name, body] of refusals)
    it(`refuses ${name}`, async () => {
      const w = consoleApp()
      const res = await w.call("user_owner", "PUT", IPS, body)
      expect(res.status).toBe(422)
      expect(w.policy.policies.size).toBe(0)
      expect(w.store.events).toHaveLength(0)
    })

  describe("an owner cannot lock themselves out", () => {
    it("refuses a console list that leaves out the saver's address, saving nothing", async () => {
      const w = consoleApp()
      const res = await w.call(
        "user_owner",
        "PUT",
        IPS,
        list({ ranges: ["198.51.100.0/24"] }),
      )
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({
        name: "would_lock_out",
        yourAddress: "203.0.113.7",
      })
      expect(w.policy.policies.size).toBe(0)
      expect(w.store.events).toHaveLength(0)
    })

    it("refuses when the saver's address cannot be determined", async () => {
      const w = consoleApp()
      const res = await w.call("user_owner", "PUT", IPS, list(), null)
      expect(res.status).toBe(422)
      expect(await res.json()).toMatchObject({
        name: "would_lock_out",
        yourAddress: null,
      })
      expect(w.policy.policies.size).toBe(0)
    })

    it("refuses a forged x-forwarded-for naming a listed address", async () => {
      const w = consoleApp()
      const res = await w.app.request(IPS, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-user": "user_owner",
          "x-forwarded-for": "203.0.113.7",
          "cf-connecting-ip": "198.51.100.1",
        },
        body: JSON.stringify(list()),
      })
      expect(res.status).toBe(422)
      expect(w.policy.policies.size).toBe(0)
    })

    it("a flag that is not exactly true confirms nothing", async () => {
      const w = consoleApp()
      for (const confirmLockout of [false, "true", 1]) {
        const res = await w.call(
          "user_owner",
          "PUT",
          IPS,
          list({ ranges: ["198.51.100.0/24"], confirmLockout }),
        )
        expect(res.status).toBe(422)
      }
      expect(w.policy.policies.size).toBe(0)
    })

    it("lets a list that includes the saver's address through with no grace", async () => {
      const w = consoleApp()
      const res = await w.call("user_owner", "PUT", IPS, list())
      expect(res.status).toBe(200)
      expect(w.policy.policies.get(TENANT)!.network.grace).toBeNull()
      expect(w.events("ip_allowlist.updated")[0]!.data).toMatchObject({
        lockoutConfirmed: false,
      })
    })

    it("sees an IPv4-mapped address of the saver as the IPv4 one they are", async () => {
      const w = consoleApp()
      const res = await w.call("user_owner", "PUT", IPS, list(), "::ffff:203.0.113.7")
      expect(res.status).toBe(200)
    })

    it("with the flag, saves, and the saver's own address stays allowed for ten minutes", async () => {
      const w = consoleApp()
      const before = Date.now()
      const res = await w.call(
        "user_owner",
        "PUT",
        IPS,
        list({ ranges: ["198.51.100.0/24"], confirmLockout: true }),
      )
      expect(res.status).toBe(200)
      const grace = w.policy.policies.get(TENANT)!.network.grace!
      expect(grace).toMatchObject({ userId: "user_owner", address: "203.0.113.7" })
      expect(grace.until.getTime()).toBeGreaterThanOrEqual(before + GRACE_MS)
      expect(grace.until.getTime()).toBeLessThanOrEqual(Date.now() + GRACE_MS)
      expect(w.events("ip_allowlist.updated")[0]!.data).toMatchObject({
        lockoutConfirmed: true,
      })
      expect(((await res.json()) as { graceUntil: string }).graceUntil).toBeTruthy()
    })

    it("with the flag and no known address, saves with no grace to give", async () => {
      const w = consoleApp()
      const res = await w.call(
        "user_owner",
        "PUT",
        IPS,
        list({ confirmLockout: true }),
        null,
      )
      expect(res.status).toBe(200)
      expect(w.policy.policies.get(TENANT)!.network.grace).toBeNull()
    })

    it("does not guard a list that only holds API keys, and clears a stale grace", async () => {
      const w = consoleApp()
      await w.call(
        "user_owner",
        "PUT",
        IPS,
        list({ ranges: ["198.51.100.0/24"], confirmLockout: true }),
      )
      const res = await w.call(
        "user_owner",
        "PUT",
        IPS,
        list({ console: false, apiKeys: true, ranges: ["198.51.100.0/24"] }),
      )
      expect(res.status).toBe(200)
      expect(w.policy.policies.get(TENANT)!.network.grace).toBeNull()
    })
  })

  it("saves normalised ranges and audits the lists before and after", async () => {
    const w = consoleApp()
    await w.call("user_owner", "PUT", IPS, list())
    const res = await w.call(
      "user_owner",
      "PUT",
      IPS,
      list({
        apiKeys: true,
        ranges: ["203.0.113.99/24", "2001:DB8::1/32", "203.0.113.0/24", "198.51.100.4"],
      }),
    )
    expect(await res.json()).toMatchObject({
      console: true,
      apiKeys: true,
      ranges: ["198.51.100.4/32", "203.0.113.0/24", "2001:db8::/32"],
    })
    expect(w.events("ip_allowlist.updated").at(-1)).toMatchObject({
      actorUserId: "user_owner",
      data: {
        before: { console: true, apiKeys: false, ranges: ["203.0.113.0/24"] },
        after: {
          console: true,
          apiKeys: true,
          ranges: ["198.51.100.4/32", "203.0.113.0/24", "2001:db8::/32"],
        },
      },
    })
    expect(w.forgotten()).toBe(2)
  })

  it("turning it off is an owner's with step-up, audited, and keeps the ranges", async () => {
    const w = consoleApp()
    await w.call("user_owner", "PUT", IPS, list())
    expect(
      (
        await w.call("user_admin", "PUT", IPS, {
          console: false,
          apiKeys: false,
          ranges: [],
        })
      ).status,
    ).toBe(403)
    const off = await w.call("user_owner", "PUT", IPS, {
      console: false,
      apiKeys: false,
      ranges: ["203.0.113.0/24"],
    })
    expect(off.status).toBe(200)
    expect(w.events("ip_allowlist.updated").at(-1)).toMatchObject({
      data: {
        before: { console: true },
        after: { console: false, ranges: ["203.0.113.0/24"] },
      },
    })
  })

  it("tells the console the caller's address and whether the list holds it", async () => {
    const w = consoleApp()
    await w.call("user_owner", "PUT", IPS, list())
    const here = await (await w.call("user_admin", "GET", IPS)).json()
    expect(here).toMatchObject({
      console: true,
      ranges: ["203.0.113.0/24"],
      yourAddress: "203.0.113.7",
      yourAddressListed: true,
      graceUntil: null,
      maxRanges: 100,
    })
    const away = await (
      await w.call("user_admin", "GET", IPS, undefined, "198.51.100.1")
    ).json()
    expect(away).toMatchObject({
      yourAddress: "198.51.100.1",
      yourAddressListed: false,
    })
  })

  it("shows the grace only to the owner it belongs to", async () => {
    const w = consoleApp()
    await w.call(
      "user_owner",
      "PUT",
      IPS,
      list({ ranges: ["198.51.100.0/24"], confirmLockout: true }),
    )
    const mine = await (await w.call("user_owner", "GET", IPS)).json()
    const theirs = await (await w.call("user_admin", "GET", IPS)).json()
    expect((mine as { graceUntil: string | null }).graceUntil).toBeTruthy()
    expect((theirs as { graceUntil: string | null }).graceUntil).toBeNull()
  })
})
