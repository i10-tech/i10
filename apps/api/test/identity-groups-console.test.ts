import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The console's group-to-role rule routes and the JIT switch (#341): every
 * refusal has a test - the owner rule on a live connection, step-up, the
 * owner role, bounds, unknown fields, duplicates, the cap - and every change
 * is in the audit log with the actor.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

function consoleApp(
  options: { status?: Connection["status"]; jit?: boolean; fresh?: boolean } = {},
) {
  const store = memoryStore({
    connections: [
      connection({
        status: options.status ?? "draft",
        jitEnabled: options.jit ?? false,
      }),
    ],
  })
  let fresh = options.fresh ?? true
  const apps = new Map<string, Hono>()
  const as = (userId: string) => {
    const cached = apps.get(userId)
    if (cached) return cached
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", { userId, orgId: "org_acme" } as never)
      c.set("freshAuth", (async () =>
        fresh ? { status: "fresh" } : { status: "stale" }) as never)
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
        log,
      },
    } as unknown as ConsoleDeps)
    apps.set(userId, app)
    return app
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const base = `/identity/connections/${CONNECTION}/group-rules`
  const events = (type: string) => store.events.filter((e) => e.type === type)
  return {
    store,
    call,
    base,
    events,
    setFresh: (value: boolean) => {
      fresh = value
    },
  }
}

const RULE = { group: "eng-admins", role: "admin", precedence: 10 }
const MISSING = "99999999-9999-4999-8999-999999999999"

describe("group rules: reading and writing", () => {
  it("lists rules first by precedence, for an admin only", async () => {
    const w = consoleApp()
    await w.call("user_admin", "POST", w.base, { ...RULE, precedence: 20 })
    await w.call("user_admin", "POST", w.base, {
      group: "staff",
      role: "member",
      precedence: 5,
    })
    const res = await w.call("user_admin", "GET", w.base)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { group: string }[]
      defaultRole: string
      max: number
    }
    expect(body.data.map((r) => r.group)).toEqual(["staff", "eng-admins"])
    expect(body.defaultRole).toBe("member")
    expect(body.max).toBe(100)
    expect((await w.call("user_m", "GET", w.base)).status).toBe(403)
    expect(
      (await w.call("user_admin", "GET", `${w.base.replace(CONNECTION, MISSING)}`))
        .status,
    ).toBe(404)
    expect(
      (await w.call("user_admin", "GET", "/identity/connections/nope/group-rules"))
        .status,
    ).toBe(404)
  })

  it("creates, updates and deletes a rule on a draft connection as an admin, and audits each", async () => {
    const w = consoleApp()
    const made = await w.call("user_admin", "POST", w.base, RULE)
    expect(made.status).toBe(201)
    const rule = (await made.json()) as { id: string }
    expect(rule).toMatchObject(RULE)
    expect(w.events("group_rule.created")).toMatchObject([
      {
        actorUserId: "user_admin",
        connectionId: CONNECTION,
        data: {
          rule: { id: rule.id, group: "eng-admins", role: "admin", precedence: 10 },
        },
      },
    ])

    const updated = await w.call("user_admin", "PATCH", `${w.base}/${rule.id}`, {
      role: "member",
      precedence: 3,
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      group: "eng-admins",
      role: "member",
      precedence: 3,
    })
    expect(w.events("group_rule.updated")).toMatchObject([
      {
        actorUserId: "user_admin",
        data: {
          from: { role: "admin", precedence: 10 },
          to: { role: "member", precedence: 3 },
        },
      },
    ])

    expect((await w.call("user_admin", "DELETE", `${w.base}/${rule.id}`)).status).toBe(
      200,
    )
    expect(w.events("group_rule.deleted")).toMatchObject([
      {
        actorUserId: "user_admin",
        data: { rule: { id: rule.id, group: "eng-admins" } },
      },
    ])
    expect(await w.store.store.groupRules(TENANT, CONNECTION)).toEqual([])
  })

  it("trims the group and refuses a second rule for the same group with a 409", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_admin", "POST", w.base, { ...RULE, group: "  eng-admins  " }))
        .status,
    ).toBe(201)
    expect((await w.store.store.groupRules(TENANT, CONNECTION))[0]!.groupValue).toBe(
      "eng-admins",
    )
    expect((await w.call("user_admin", "POST", w.base, RULE)).status).toBe(409)
    // Renaming another rule onto it is the same conflict.
    const other = (await (
      await w.call("user_admin", "POST", w.base, {
        group: "ops",
        role: "member",
        precedence: 1,
      })
    ).json()) as { id: string }
    expect(
      (
        await w.call("user_admin", "PATCH", `${w.base}/${other.id}`, {
          group: "eng-admins",
        })
      ).status,
    ).toBe(409)
    expect(w.events("group_rule.created")).toHaveLength(2)
    expect(w.events("group_rule.updated")).toEqual([])
  })

  it("stops at 100 rules with a 422", async () => {
    const w = consoleApp()
    for (let i = 0; i < 100; i++)
      expect(
        (
          await w.call("user_admin", "POST", w.base, {
            group: `g${i}`,
            role: "member",
            precedence: i,
          })
        ).status,
      ).toBe(201)
    const over = await w.call("user_admin", "POST", w.base, {
      group: "one-more",
      role: "member",
      precedence: 1,
    })
    expect(over.status).toBe(422)
    expect(((await over.json()) as { message: string }).message).toContain(
      "at most 100",
    )
    expect(w.events("group_rule.created")).toHaveLength(100)
  })
})

describe("group rules: validation", () => {
  it("never lets a rule give owner, or any role but member and admin", async () => {
    const w = consoleApp()
    for (const role of ["owner", "Admin", "", null, 1, undefined])
      expect(
        (await w.call("user_admin", "POST", w.base, { ...RULE, role })).status,
      ).toBe(422)
    const made = (await (await w.call("user_admin", "POST", w.base, RULE)).json()) as {
      id: string
    }
    expect(
      (await w.call("user_admin", "PATCH", `${w.base}/${made.id}`, { role: "owner" }))
        .status,
    ).toBe(422)
    expect(await w.store.store.groupRules(TENANT, CONNECTION)).toMatchObject([
      { role: "admin" },
    ])
    expect(w.events("group_rule.created")).toHaveLength(1)
    expect(w.events("group_rule.updated")).toEqual([])
  })

  it("bounds the precedence to whole numbers from 0 to 10000", async () => {
    const w = consoleApp()
    for (const precedence of [-1, 10_001, 1.5, "1", null, undefined])
      expect(
        (await w.call("user_admin", "POST", w.base, { ...RULE, precedence })).status,
      ).toBe(422)
    for (const precedence of [0, 10_000])
      expect(
        (
          await w.call("user_admin", "POST", w.base, {
            ...RULE,
            group: `g${precedence}`,
            precedence,
          })
        ).status,
      ).toBe(201)
  })

  it("bounds the group to 1 to 256 characters without control characters", async () => {
    const w = consoleApp()
    for (const group of [
      "",
      "   ",
      "x".repeat(257),
      "a\u0000b",
      "a\nb",
      7,
      null,
      undefined,
    ])
      expect(
        (await w.call("user_admin", "POST", w.base, { ...RULE, group })).status,
      ).toBe(422)
    expect(
      (await w.call("user_admin", "POST", w.base, { ...RULE, group: "x".repeat(256) }))
        .status,
    ).toBe(201)
  })

  it("refuses an unknown field and an empty patch", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_admin", "POST", w.base, { ...RULE, tenantId: "t_other" }))
        .status,
    ).toBe(422)
    const made = (await (await w.call("user_admin", "POST", w.base, RULE)).json()) as {
      id: string
    }
    const at = `${w.base}/${made.id}`
    expect(
      (await w.call("user_admin", "PATCH", at, { connectionId: MISSING })).status,
    ).toBe(422)
    expect((await w.call("user_admin", "PATCH", at, {})).status).toBe(422)
    expect(
      (await w.call("user_admin", "PATCH", at, { precedence: 99_999 })).status,
    ).toBe(422)
    expect(await w.store.store.groupRules(TENANT, CONNECTION)).toMatchObject([
      { groupValue: "eng-admins", role: "admin", precedence: 10 },
    ])
    expect(w.events("group_rule.updated")).toEqual([])
  })

  it("answers 404 for a rule or connection that is not there", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_admin", "PATCH", `${w.base}/${MISSING}`, { precedence: 1 }))
        .status,
    ).toBe(404)
    expect(
      (await w.call("user_admin", "PATCH", `${w.base}/not-a-uuid`, { precedence: 1 }))
        .status,
    ).toBe(404)
    expect((await w.call("user_admin", "DELETE", `${w.base}/${MISSING}`)).status).toBe(
      404,
    )
    expect((await w.call("user_admin", "DELETE", `${w.base}/not-a-uuid`)).status).toBe(
      404,
    )
    const elsewhere = `/identity/connections/${MISSING}/group-rules`
    expect((await w.call("user_admin", "POST", elsewhere, RULE)).status).toBe(404)
  })
})

describe("group rules: who may change them", () => {
  it("refuses a member everything", async () => {
    const w = consoleApp()
    expect((await w.call("user_m", "POST", w.base, RULE)).status).toBe(403)
    expect(await w.store.store.groupRules(TENANT, CONNECTION)).toEqual([])
  })

  it("keeps an active connection's rules for owners: an admin gets 403 on every write", async () => {
    const w = consoleApp({ status: "active" })
    expect((await w.call("user_admin", "POST", w.base, RULE)).status).toBe(403)
    const made = await w.call("user_owner", "POST", w.base, RULE)
    expect(made.status).toBe(201)
    const at = `${w.base}/${((await made.json()) as { id: string }).id}`
    expect((await w.call("user_admin", "PATCH", at, { role: "member" })).status).toBe(
      403,
    )
    expect((await w.call("user_admin", "DELETE", at)).status).toBe(403)
    expect(await w.store.store.groupRules(TENANT, CONNECTION)).toMatchObject([
      { role: "admin" },
    ])
    // An admin may still read them.
    expect((await w.call("user_admin", "GET", w.base)).status).toBe(200)
    expect((await w.call("user_owner", "PATCH", at, { role: "member" })).status).toBe(
      200,
    )
    expect((await w.call("user_owner", "DELETE", at)).status).toBe(200)
    expect(w.events("group_rule.created")).toMatchObject([
      { actorUserId: "user_owner" },
    ])
  })

  it("holds a disabled connection to the same rule, and a testing one to the draft rule", async () => {
    const disabled = consoleApp({ status: "disabled" })
    expect(
      (await disabled.call("user_admin", "POST", disabled.base, RULE)).status,
    ).toBe(403)
    expect(
      (await disabled.call("user_owner", "POST", disabled.base, RULE)).status,
    ).toBe(201)
    const testing = consoleApp({ status: "testing" })
    expect((await testing.call("user_admin", "POST", testing.base, RULE)).status).toBe(
      201,
    )
  })

  it("needs a fresh step-up for every write, and reads without one", async () => {
    const w = consoleApp({ fresh: false })
    expect((await w.call("user_owner", "POST", w.base, RULE)).status).toBe(403)
    expect(
      (await w.call("user_owner", "PATCH", `${w.base}/${MISSING}`, { precedence: 1 }))
        .status,
    ).toBe(403)
    expect((await w.call("user_owner", "DELETE", `${w.base}/${MISSING}`)).status).toBe(
      403,
    )
    expect(await w.store.store.groupRules(TENANT, CONNECTION)).toEqual([])
    expect(w.events("group_rule.created")).toEqual([])
    expect((await w.call("user_owner", "GET", w.base)).status).toBe(200)
    w.setFresh(true)
    expect((await w.call("user_owner", "POST", w.base, RULE)).status).toBe(201)
  })
})

describe("the JIT switch", () => {
  const patch = (w: ReturnType<typeof consoleApp>, userId: string, body: unknown) =>
    w.call(userId, "PATCH", `/identity/connections/${CONNECTION}`, body)

  it("is an admin's to turn on while the connection is still being set up", async () => {
    const w = consoleApp({ status: "draft" })
    expect((await patch(w, "user_admin", { jitEnabled: true })).status).toBe(200)
  })

  it("needs an owner to turn JIT on for an active or disabled connection", async () => {
    for (const status of ["active", "disabled"] as const) {
      const w = consoleApp({ status, jit: false })
      expect((await patch(w, "user_admin", { jitEnabled: true })).status).toBe(403)
      expect((await w.store.store.connection(TENANT, CONNECTION))!.jitEnabled).toBe(
        false,
      )
      expect((await patch(w, "user_owner", { jitEnabled: true })).status).toBe(200)
      expect((await w.store.store.connection(TENANT, CONNECTION))!.jitEnabled).toBe(
        true,
      )
      expect(w.events("connection.updated").at(-1)).toMatchObject({
        actorUserId: "user_owner",
        data: { changed: ["jitEnabled"] },
      })
    }
  })

  it("lets an admin turn JIT off, and leave it on, on an active connection", async () => {
    const w = consoleApp({ status: "active", jit: true })
    // Already on: setting it on again loosens nothing.
    expect((await patch(w, "user_admin", { jitEnabled: true })).status).toBe(200)
    expect((await patch(w, "user_admin", { jitEnabled: false })).status).toBe(200)
    expect((await w.store.store.connection(TENANT, CONNECTION))!.jitEnabled).toBe(false)
    // And back on is the owner's again.
    expect((await patch(w, "user_admin", { jitEnabled: true })).status).toBe(403)
  })

  it("needs an owner to activate a connection that has JIT on, so draft is no way around", async () => {
    const w = consoleApp({ status: "draft", jit: true })
    expect((await patch(w, "user_admin", { status: "active" })).status).toBe(403)
    expect(
      (await patch(w, "user_admin", { status: "active", jitEnabled: true })).status,
    ).toBe(403)
    expect((await w.store.store.connection(TENANT, CONNECTION))!.status).toBe("draft")
    expect((await patch(w, "user_owner", { status: "active" })).status).toBe(200)

    const turnedOnWithIt = consoleApp({ status: "testing", jit: false })
    expect(
      (
        await patch(turnedOnWithIt, "user_admin", {
          status: "active",
          jitEnabled: true,
        })
      ).status,
    ).toBe(403)
    // Activating with JIT off is the admin's, and turning it off in the same
    // request counts.
    expect(
      (await patch(turnedOnWithIt, "user_admin", { status: "active" })).status,
    ).toBe(200)
    const switchedOff = consoleApp({ status: "draft", jit: true })
    expect(
      (await patch(switchedOff, "user_admin", { status: "active", jitEnabled: false }))
        .status,
    ).toBe(200)
  })
})
