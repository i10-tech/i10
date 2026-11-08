import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import { resumeMailbox, suspendMailbox } from "../src/identity/directory-mail.js"
import { TENANT, log, memoryClerk, memoryStore } from "./identity-fakes.js"
import { LEAVER, memoryMail } from "./identity-mail-fakes.js"

/**
 * The owner's "resume mailbox": an owner or admin gives a suspended mailbox its
 * login back. It clears `suspended_at` and nothing else, refuses what would fight
 * the reason the mailbox was suspended, and needs step-up and the actor in the
 * audit log. (The real store's membership lock is in mailbox-resume-db.test.ts.)
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
  // The suspended person, who is a plain member: they must not lift it themselves.
  [LEAVER]: "member",
}

function world(init: Parameters<typeof memoryMail>[0] = {}) {
  const m = memoryMail({ members: [LEAVER], ...init })
  m.give(LEAVER, "ada@acme.test")
  let fresh = true
  const call = (userId: string, path: string) => {
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
    return app.request(path, { method: "POST" })
  }
  const suspend = () =>
    suspendMailbox(m.deps, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      actorUserId: null,
      cause: "membership_removed",
    })
  return {
    m,
    call,
    suspend,
    setFresh: (value: boolean) => {
      fresh = value
    },
  }
}

const path = `/identity/mailboxes/${LEAVER}/resume`
const stillSuspended = (m: ReturnType<typeof memoryMail>) => !m.canLogin(LEAVER)

describe("resuming a suspended mailbox", () => {
  it("an admin gives the login back, audited with the actor", async () => {
    const w = world()
    await w.suspend()
    expect(stillSuspended(w.m)).toBe(true)

    const res = await w.call("user_admin", path)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stillBlocked: [] })
    expect(w.m.canLogin(LEAVER)).toBe(true)
    expect(w.m.rows.get(`${TENANT}/${LEAVER}`)).toMatchObject({
      state: "active",
      suspendedAt: null,
      next: "keep",
    })
    expect(w.m.events.find((e) => e.type === "mailbox.resumed")).toMatchObject({
      actorUserId: "user_admin",
      subjectUserId: LEAVER,
      reason: "owner",
    })
  })

  it("an owner can too, and a scheduled deletion goes with the suspension", async () => {
    const w = world({ default: { action: "delete_after", days: 30 } })
    await w.suspend()
    expect(w.m.rows.get(`${TENANT}/${LEAVER}`)).toMatchObject({ next: "delete" })

    expect((await w.call("user_owner", path)).status).toBe(200)
    expect(w.m.rows.get(`${TENANT}/${LEAVER}`)).toMatchObject({
      next: "keep",
      deleteAt: null,
    })
    expect(await w.m.store.due(TENANT, new Date("2027-01-01T00:00:00Z"))).toEqual([])
  })

  // ⚠ ONLY `suspended_at`. A payment hold is paid off, a ban or lock is Clerk's.
  it("clears the suspension and nothing else, and says what still refuses the login", async () => {
    const w = world()
    w.m.accounts.get(LEAVER)!.blocks = ["payment_hold", "banned", "locked"]
    await w.suspend()

    const res = await w.call("user_admin", path)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      stillBlocked: ["payment_hold", "banned", "locked"],
    })
    expect(w.m.accounts.get(LEAVER)!.suspended).toBe(false)
    expect(w.m.accounts.get(LEAVER)!.blocks).toEqual([
      "payment_hold",
      "banned",
      "locked",
    ])
    expect(w.m.events.find((e) => e.type === "mailbox.resumed")).toMatchObject({
      data: { stillBlocked: ["payment_hold", "banned", "locked"] },
    })
  })

  it("a member cannot resume a mailbox, not even their own", async () => {
    const w = world()
    await w.suspend()
    expect((await w.call("user_m", path)).status).toBe(403)
    expect((await w.call(LEAVER, path)).status).toBe(403)
    expect(stillSuspended(w.m)).toBe(true)
    expect(w.m.types()).not.toContain("mailbox.resumed")
  })

  it("needs step-up", async () => {
    const w = world()
    await w.suspend()
    w.setFresh(false)
    expect((await w.call("user_admin", path)).status).not.toBe(200)
    expect(stillSuspended(w.m)).toBe(true)
  })

  it("is a 404 for a mailbox that is not suspended, and for an id that is not one", async () => {
    const w = world()
    expect((await w.call("user_admin", path)).status).toBe(404)
    expect(
      (await w.call("user_admin", "/identity/mailboxes/not-an-id/resume")).status,
    ).toBe(404)
    await w.suspend()
    expect((await w.call("user_admin", path)).status).toBe(200)
    // Resuming twice is not a second resume.
    expect((await w.call("user_admin", path)).status).toBe(404)
  })

  // ⚠ THE MAILBOX WAS SUSPENDED BECAUSE THEY LEFT. Re-adding does not lift it and a
  // removed person's login does not come back with a click.
  it("is refused for somebody who is not a member of the workspace", async () => {
    const w = world({ members: [] })
    await w.suspend()
    const res = await w.call("user_admin", path)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain(
      "not a member",
    )
    expect(stillSuspended(w.m)).toBe(true)
    expect(w.m.events.find((e) => e.type === "mailbox.resume_refused")).toMatchObject({
      actorUserId: "user_admin",
      subjectUserId: LEAVER,
      reason: "not_member",
    })
  })

  // ⚠ THE RACE: the person is a member when the route looks and gone by the time the
  // store commits. The store asks again, inside its transaction.
  it("is refused when the store finds the membership gone at the moment of the write", async () => {
    const w = world({ members: [] })
    await w.suspend()
    w.m.deps.isMember = async () => true
    const done = await resumeMailbox(w.m.deps, {
      tenantId: TENANT,
      clerkUserId: LEAVER,
      actorUserId: "user_admin",
    })
    expect(done).toEqual({ outcome: "not_member" })
    expect(stillSuspended(w.m)).toBe(true)
    expect(w.m.types()).not.toContain("mailbox.resumed")
  })

  // ⚠ A DIRECTORY IS THE AUTHORITY ON ITS LEAVERS: resuming one by hand would only be
  // undone by its next push, with a login open in between.
  it("is refused while a directory still says the person is deactivated", async () => {
    const w = world({ directoryDeactivated: [LEAVER] })
    await w.suspend()
    const res = await w.call("user_admin", path)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain("directory")
    expect(stillSuspended(w.m)).toBe(true)
    expect(w.m.events.find((e) => e.type === "mailbox.resume_refused")).toMatchObject({
      reason: "directory_deactivated",
    })
  })

  it("is allowed for a person no directory has heard of, or one it says is active", async () => {
    const unknown = world()
    await unknown.suspend()
    expect((await unknown.call("user_admin", path)).status).toBe(200)

    const active = world({ directoryActive: [LEAVER] })
    await active.suspend()
    expect((await active.call("user_admin", path)).status).toBe(200)
  })

  // ⚠ A mailbox suspended because its domain was removed must not open again on a
  // name the workspace does not hold.
  it("is refused when the workspace no longer hosts the mailbox's domain", async () => {
    const w = world()
    await w.suspend()
    w.m.hosted.delete("acme.test")
    const res = await w.call("user_admin", path)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain("domain")
    expect(stillSuspended(w.m)).toBe(true)

    w.m.hosted.set("acme.test", "another-workspace")
    expect((await w.call("user_admin", path)).status).toBe(422)
    expect(stillSuspended(w.m)).toBe(true)
  })

  it("never reaches a mailbox of another workspace", async () => {
    const w = world()
    w.m.give("user_other", "other@acme.test", "another-workspace")
    w.m.accounts.get("user_other")!.suspended = true
    w.m.members.add("user_other")
    expect(
      (await w.call("user_admin", "/identity/mailboxes/user_other/resume")).status,
    ).toBe(404)
    expect(w.m.accounts.get("user_other")!.suspended).toBe(true)
  })
})
