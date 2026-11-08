import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import { suspendMailbox } from "../src/identity/directory-mail.js"
import { TENANT, log, memoryClerk, memoryStore } from "./identity-fakes.js"
import { LEAVER, memoryMail } from "./identity-mail-fakes.js"

/**
 * The console's directory mail routes (#344): who may decide what happens to a
 * leaver's mail. A workspace-wide "delete after" is an owner's; a per-mailbox
 * pick is an admin's; every change needs step-up.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}

function consoleApp() {
  const m = memoryMail()
  m.give(LEAVER, "ada@acme.test")
  let fresh = true
  const as = (userId: string) => {
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
        store: memoryStore().store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test"],
        deprovision: {},
        mail: { deps: m.deps, groups: m.store },
        log,
      },
    } as unknown as ConsoleDeps)
    return app
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    m,
    call,
    setFresh: (value: boolean) => {
      fresh = value
    },
  }
}

describe("the workspace's leaver default", () => {
  const deleteAfter = { action: "delete_after", days: 30 }

  it("deleting everyone a directory switches off is refused to an admin and to a stale owner", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_admin", "PUT", "/identity/mail/leavers", deleteAfter)).status,
    ).toBe(403)
    w.setFresh(false)
    expect(
      (await w.call("user_owner", "PUT", "/identity/mail/leavers", deleteAfter)).status,
    ).not.toBe(200)
    expect(await w.m.store.leaverDefault(TENANT)).toEqual({
      action: "keep",
      days: null,
    })
  })

  it("an owner with step-up sets it, audited with before and after", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_owner", "PUT", "/identity/mail/leavers", deleteAfter)).status,
    ).toBe(200)
    expect(await w.m.store.leaverDefault(TENANT)).toEqual({
      action: "delete_after",
      days: 30,
    })
    expect(
      w.m.events.find((e) => e.type === "mailbox.leaver_default_set"),
    ).toMatchObject({
      actorUserId: "user_owner",
      data: { from: { action: "keep" }, to: { action: "delete_after", days: 30 } },
    })
  })

  it("forwarding to the manager is an admin's, and a member's is refused", async () => {
    const w = consoleApp()
    const forward = { action: "forward_manager" }
    expect(
      (await w.call("user_m", "PUT", "/identity/mail/leavers", forward)).status,
    ).toBe(403)
    expect(
      (await w.call("user_admin", "PUT", "/identity/mail/leavers", forward)).status,
    ).toBe(200)
  })
})

describe("a suspended mailbox's next step", () => {
  const path = `/identity/mailboxes/${LEAVER}/next`
  const suspended = async () => {
    const w = consoleApp()
    await suspendMailbox(w.m.deps, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      actorUserId: null,
      cause: "scim",
    })
    return w
  }

  it("is refused to a member and to an admin without step-up", async () => {
    const w = await suspended()
    expect(
      (await w.call("user_m", "PUT", path, { next: "delete", days: 30 })).status,
    ).toBe(403)
    w.setFresh(false)
    expect(
      (await w.call("user_admin", "PUT", path, { next: "delete", days: 30 })).status,
    ).not.toBe(200)
    expect(w.m.rows.get(`${TENANT}/${LEAVER}`)!.next).toBe("keep")
  })

  it("an admin with step-up schedules the deletion", async () => {
    const w = await suspended()
    const res = await w.call("user_admin", "PUT", path, { next: "delete", days: 30 })
    expect(res.status).toBe(200)
    expect(w.m.rows.get(`${TENANT}/${LEAVER}`)!.next).toBe("delete")
    expect(w.m.scheduled).toHaveLength(1)
  })

  it("a live mailbox is not the admin's to decide", async () => {
    const w = consoleApp()
    expect(
      (await w.call("user_admin", "PUT", path, { next: "delete", days: 30 })).status,
    ).toBe(404)
  })
})
