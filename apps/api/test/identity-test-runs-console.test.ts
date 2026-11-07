import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * The test-run history and the preset list the SSO screens read (#340): an
 * admin's, this workspace's, and shaped as the screen expects.
 */

const ROLES: Record<string, Role> = { user_admin: "admin", user_m: "member" }
const OTHER = "00000000-0000-4000-8000-0000000000aa"

function consoleApp() {
  const store = memoryStore({
    connections: [connection({ status: "testing" })],
    live: { [CONNECTION]: ["acme.test"] },
  })
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" } as never)
    c.set("user", { userId: c.req.header("x-user") ?? "", orgId: "org_acme" } as never)
    await next()
  })
  mountIdentity(app, {
    roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
    identity: {
      store: store.store,
      clerk: memoryClerk().clerk,
      gate: { forget: () => {} },
      protocols: ["test", "oidc", "saml"],
      deprovision: {},
      log,
    },
  } as unknown as ConsoleDeps)
  const call = (userId: string, path: string) =>
    app.request(path, { headers: { "x-user": userId } })
  return { store, call }
}

const runs = `/identity/connections/${CONNECTION}/test-runs`

describe("a connection's test runs", () => {
  it("refuses a member, and a path that is not a connection id", async () => {
    const w = consoleApp()
    expect((await w.call("user_m", runs)).status).toBe(403)
    expect(
      (await w.call("user_admin", "/identity/connections/nope/test-runs")).status,
    ).toBe(404)
  })

  it("answers 404 for another workspace's connection", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_admin", `/identity/connections/${OTHER}/test-runs`)).status,
    ).toBe(404)
  })

  it("lists the runs newest first with their claims and resolution", async () => {
    const w = consoleApp()
    await w.store.store.recordTestRun(TENANT, {
      connectionId: CONNECTION,
      attemptId: "a1",
      outcome: "failed",
      reason: "email_unverified",
      claims: { email: "a@acme.test" },
      resolution: { refused: "email_unverified" },
    })
    await w.store.store.recordTestRun(TENANT, {
      connectionId: CONNECTION,
      attemptId: "a2",
      outcome: "passed",
      reason: null,
      claims: { email: "b@acme.test", groups: ["eng"] },
      resolution: { path: "jit", wouldCreate: true },
    })
    const res = await w.call("user_admin", runs)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { outcome: string; claims: Record<string, unknown> }[]
    }
    expect(body.data.map((r) => r.outcome)).toEqual(["passed", "failed"])
    expect(body.data[0]!.claims.groups).toEqual(["eng"])
  })
})

describe("the connection list", () => {
  it("carries the IdP presets the wizard offers, and refuses a member", async () => {
    const w = consoleApp()
    expect((await w.call("user_m", "/identity/connections")).status).toBe(403)
    const body = (await (
      await w.call("user_admin", "/identity/connections")
    ).json()) as {
      presets: { oidc: { id: string }[]; saml: { id: string }[] }
    }
    expect(body.presets.oidc.map((p) => p.id)).toContain("okta")
    expect(body.presets.saml.map((p) => p.id)).toContain("entra")
  })
})
