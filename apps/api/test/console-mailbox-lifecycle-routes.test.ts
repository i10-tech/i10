import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { DeleteMailbox } from "@repo/contracts"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type {
  DeleteResult,
  MailboxAdminLifecycle,
  ResumeResult,
  RestoreOutcome,
  RetryExportOutcome,
  SuspendResult,
} from "../src/mailboxes/lifecycle.js"
import { mountMailboxAdmin } from "../src/routes/console/mailbox-admin.js"

/**
 * A mailbox's suspend, resume, delete and restore over HTTP. The order of the
 * refusals is the point - wired, role, step-up, address, body - so each test that
 * cares says what it must not have reached.
 */

const TENANT = "3f1a0e00-0000-4000-8000-000000000001"
const people = { admin: "user_admin", member: "user_member" }
const ADDRESS = "ada@acme.test"

const row = {
  tenantId: TENANT,
  clerkUserId: "user_ada",
  address: ADDRESS,
  outcome: "delete" as const,
  forwardUserId: null,
  forwardAddress: null,
  requestedBy: people.admin,
  deletingAt: new Date(0),
  purgeAfter: new Date(0),
}

function world(
  over: {
    suspend?: SuspendResult
    resume?: ResumeResult
    remove?: DeleteResult
    restore?: RestoreOutcome
    retryExport?: RetryExportOutcome
    wired?: boolean
  } = {},
) {
  const retryExport = mock<MailboxAdminLifecycle["retryExport"]>(
    async () => over.retryExport ?? "started",
  )
  const suspend = mock<MailboxAdminLifecycle["suspend"]>(
    async () => over.suspend ?? "suspended",
  )
  const resume = mock<MailboxAdminLifecycle["resume"]>(
    async () => over.resume ?? { status: "resumed", stillBlocked: [] },
  )
  const remove = mock<MailboxAdminLifecycle["remove"]>(
    async () => over.remove ?? { status: "deleting", row },
  )
  const restore = mock<MailboxAdminLifecycle["restore"]>(
    async () => over.restore ?? "restored",
  )
  const lifecycle: MailboxAdminLifecycle = {
    isAdmin: async (_tenant, userId) => userId === people.admin,
    suspend,
    resume,
    remove,
    restore,
    retryExport,
  }
  return {
    lifecycle,
    suspend,
    resume,
    remove,
    restore,
    retryExport,
    wired: over.wired ?? true,
  }
}

function appFor(w: ReturnType<typeof world>, who: keyof typeof people, fresh = true) {
  const stepUp = mock(async () => ({ status: fresh ? "fresh" : "stale" }))
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" })
    c.set("user", { userId: people[who], orgId: "org_acme" })
    c.set("freshAuth" as never, stepUp as never)
    await next()
  })
  const mailbox = { address: ADDRESS, status: "deleting" }
  const deps = {
    ...(w.wired ? { mailboxLifecycle: w.lifecycle } : {}),
    mailboxes: { get: async () => mailbox },
  } as unknown as ConsoleDeps
  mountMailboxAdmin(app, deps)
  return { app, stepUp }
}

const call = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const path = (verb: string, address = ADDRESS) =>
  `/mailboxes/${encodeURIComponent(address)}/${verb}`

const named = async (res: Response) => (await res.json()) as { name: string }

describe.each(["suspend", "resume", "delete", "restore", "retry-export"] as const)(
  "POST /mailboxes/:address/%s",
  (verb) => {
    const body = verb === "delete" ? { outcome: "delete" } : undefined
    const mocks = (w: ReturnType<typeof world>) =>
      ({
        suspend: w.suspend,
        resume: w.resume,
        delete: w.remove,
        restore: w.restore,
        "retry-export": w.retryExport,
      })[verb]

    it("answers 501 where the lifecycle is not wired", async () => {
      const w = world({ wired: false })
      const res = await call(appFor(w, "admin").app, path(verb), body)
      expect(res.status).toBe(501)
    })

    it("refuses a member with 403 and never asks them to step up", async () => {
      const w = world()
      const { app, stepUp } = appFor(w, "member", false)
      const res = await call(app, path(verb), body)

      expect(res.status).toBe(403)
      expect((await named(res)).name).toBe("forbidden")
      expect(stepUp).not.toHaveBeenCalled()
      expect(mocks(w)).not.toHaveBeenCalled()
    })

    it("asks an admin with a stale session to step up, before the body or the mailbox", async () => {
      const w = world()
      const res = await call(appFor(w, "admin", false).app, path(verb), {
        nonsense: true,
      })

      expect(res.status).toBe(403)
      expect((await named(res)).name).toBe("invalid_access")
      expect(mocks(w)).not.toHaveBeenCalled()
    })

    it("answers 404 for something that is not an address, without asking the lifecycle", async () => {
      const w = world()
      const res = await call(
        appFor(w, "admin").app,
        "/mailboxes/not-an-address/" + verb,
        body,
      )
      expect(res.status).toBe(404)
      expect(mocks(w)).not.toHaveBeenCalled()
    })

    it("takes the actor and the workspace from the session, never from the body", async () => {
      const w = world()
      await call(appFor(w, "admin").app, path(verb), {
        ...(body ?? {}),
        actorId: "user_other",
        tenantId: "somebody-else",
      })

      const input = mocks(w).mock.calls[0]?.[0] as { tenantId: string; actorId: string }
      expect(input).toMatchObject({
        tenantId: TENANT,
        actorId: people.admin,
        address: ADDRESS,
      })
    })
  },
)

describe("suspend", () => {
  it("answers with the mailbox as the list shows it", async () => {
    const res = await call(appFor(world(), "admin").app, path("suspend"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mailbox: { address: ADDRESS, status: "deleting" },
    })
  })

  it("maps a missing mailbox to 404 and one being deleted to 409", async () => {
    expect(
      (
        await call(
          appFor(world({ suspend: "not_found" }), "admin").app,
          path("suspend"),
        )
      ).status,
    ).toBe(404)
    const res = await call(
      appFor(world({ suspend: "deleting" }), "admin").app,
      path("suspend"),
    )
    expect(res.status).toBe(409)
    expect((await named(res)).name).toBe("mailbox_deleting")
  })
})

describe("resume", () => {
  it("says what still refuses the login", async () => {
    const w = world({
      resume: { status: "resumed", stillBlocked: ["payment_hold", "banned"] },
    })
    const res = await call(appFor(w, "admin").app, path("resume"))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      still_blocked: ["payment_hold", "banned"],
    })
  })

  it.each([
    "not_suspended",
    "deleting",
    "not_member",
    "directory_deactivated",
    "domain_not_hosted",
  ] as const)("refuses %s with 409 and the reason as its name", async (status) => {
    const res = await call(
      appFor(world({ resume: { status } }), "admin").app,
      path("resume"),
    )
    expect(res.status).toBe(409)
    expect((await named(res)).name).toBe(status)
  })

  it("maps a missing mailbox to 404", async () => {
    const res = await call(
      appFor(world({ resume: { status: "not_found" } }), "admin").app,
      path("resume"),
    )
    expect(res.status).toBe(404)
  })
})

describe("delete", () => {
  it.each<[DeleteMailbox]>([
    [{ outcome: "delete" }],
    [{ outcome: "export_then_delete" }],
    [{ outcome: "forward", forward_to: "bob@acme.test" }],
  ])("passes the outcome %j through and answers with the mailbox", async (body) => {
    const w = world()
    const res = await call(appFor(w, "admin").app, path("delete"), body)

    expect(res.status).toBe(200)
    expect(w.remove.mock.calls[0]?.[0].request).toEqual(body)
    expect(await res.json()).toEqual({
      mailbox: { address: ADDRESS, status: "deleting" },
    })
  })

  it.each([
    [{}, "no outcome"],
    [{ outcome: "shred" }, "an unknown outcome"],
    [{ outcome: "forward" }, "a forward with no target"],
    [{ outcome: "delete", forward_to: "bob@acme.test" }, "a target on a delete"],
    [{ outcome: "forward", forward_to: "nope" }, "a target that is not an address"],
  ])("answers 422 for %j (%s) before the mailbox is touched", async (body) => {
    const w = world()
    const res = await call(appFor(w, "admin").app, path("delete"), body)
    expect(res.status).toBe(422)
    expect(w.remove).not.toHaveBeenCalled()
  })

  it.each([
    ["not_found", 404, "not_found"],
    ["already", 409, "already_deleting"],
    ["forward_invalid", 422, "validation_error"],
    ["forward_exists", 409, "forward_exists"],
    ["forward_target_in_use", 409, "forward_target_in_use"],
    ["export_unavailable", 501, "internal_server_error"],
    ["export_failed", 503, "application_error"],
  ] as const)("maps %s to %i", async (status, code, name) => {
    const res = await call(
      appFor(world({ remove: { status } }), "admin").app,
      path("delete"),
      { outcome: "delete" },
    )
    expect(res.status).toBe(code)
    expect((await named(res)).name).toBe(name)
  })
})

describe("restore", () => {
  it("restores", async () => {
    const res = await call(appFor(world(), "admin").app, path("restore"))
    expect(res.status).toBe(200)
  })

  it("maps what cannot be restored to 404 and 409", async () => {
    expect(
      (
        await call(
          appFor(world({ restore: "not_found" }), "admin").app,
          path("restore"),
        )
      ).status,
    ).toBe(404)
    const notDeleting = await call(
      appFor(world({ restore: "not_deleting" }), "admin").app,
      path("restore"),
    )
    expect(notDeleting.status).toBe(409)
    expect((await named(notDeleting)).name).toBe("not_deleting")
    const closed = await call(
      appFor(world({ restore: "window_closed" }), "admin").app,
      path("restore"),
    )
    expect(closed.status).toBe(409)
    expect((await named(closed)).name).toBe("restore_window_closed")
  })
})

describe("retry-export", () => {
  it("starts the export again and answers with the mailbox", async () => {
    const w = world()
    const res = await call(appFor(w, "admin").app, path("retry-export"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mailbox: { address: ADDRESS, status: "deleting" },
    })
    expect(w.retryExport).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["not_found", 404, "not_found"],
    ["not_deleting", 409, "not_deleting"],
    ["not_waiting_for_export", 409, "not_waiting_for_export"],
    ["export_unavailable", 501, "internal_server_error"],
    ["export_failed", 503, "application_error"],
  ] as const)("maps %s to %i", async (status, code, name) => {
    const res = await call(
      appFor(world({ retryExport: status }), "admin").app,
      path("retry-export"),
    )
    expect(res.status).toBe(code)
    expect((await named(res)).name).toBe(name)
  })
})
