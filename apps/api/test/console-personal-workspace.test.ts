import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountAccount } from "../src/routes/console/account.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { NO_TENANT } from "../src/middleware/tenant.js"

/**
 * The Personal workspace (#325): made only when somebody picks it, one per
 * person, and turned into a team workspace only by its owner.
 */

const log = { error: () => {}, warn: () => {} }

function appWith(
  over: Partial<ConsoleDeps>,
  who: { tenantId?: string; orgId?: string } = {},
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", {
      apiKeyId: "",
      tenantId: who.tenantId ?? NO_TENANT,
      scopes: [],
      mode: "live",
    })
    c.set("user", { userId: "user_1", ...(who.orgId ? { orgId: who.orgId } : {}) })
    await next()
  })
  // Cast for the same reason as console-rename.test.ts: these routes touch two fields.
  mountAccount(app, { log, ...over } as unknown as ConsoleDeps)
  return app
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("POST /console/workspaces/personal", () => {
  it("makes one for the person asking and answers the organization to activate", async () => {
    const createPersonal = mock(async () => ({ id: "org_p", created: true }))
    const res = await post(
      appWith({ organizations: { rename: mock(), createPersonal } }),
      "/workspaces/personal",
    )

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ organization_id: "org_p" })
    expect(createPersonal).toHaveBeenCalledWith("user_1")
  })

  // ⚠ A SECOND PRESS, OR A RETRY AFTER A TIMEOUT, FINDS THE ONE THEY HAVE.
  it("answers 200 with the existing one rather than making a second", async () => {
    const createPersonal = mock(async () => ({ id: "org_p", created: false }))
    const res = await post(
      appWith({ organizations: { rename: mock(), createPersonal } }),
      "/workspaces/personal",
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ organization_id: "org_p" })
  })

  it("answers 501 when Clerk is not wired", async () => {
    const res = await post(appWith({}), "/workspaces/personal")
    expect(res.status).toBe(501)
  })
})

describe("POST /console/workspace/team", () => {
  const profile = () => ({ rename: mock(async () => true) })

  it("turns the active Personal workspace into a team, renaming ours too", async () => {
    const makeTeam = mock(async () => "ok" as const)
    const p = profile()
    const res = await post(
      appWith(
        { profile: p as never, organizations: { rename: mock(), makeTeam } },
        { tenantId: "ten-1", orgId: "org_p" },
      ),
      "/workspace/team",
      { name: "Acme" },
    )

    expect(res.status).toBe(200)
    expect(makeTeam).toHaveBeenCalledWith("org_p", "user_1", "Acme")
    expect(p.rename).toHaveBeenCalledWith("ten-1", "Acme")
  })

  // ⚠ NOBODY LIFTS THE LIMIT ON A WORKSPACE THAT IS NOT THEIR PERSONAL ONE.
  it("refuses anything that is not the person's Personal workspace", async () => {
    const p = profile()
    const res = await post(
      appWith(
        {
          profile: p as never,
          organizations: {
            rename: mock(),
            makeTeam: mock(async () => "not_personal" as const),
          },
        },
        { tenantId: "ten-1", orgId: "org_team" },
      ),
      "/workspace/team",
      { name: "Acme" },
    )

    expect(res.status).toBe(422)
    expect(p.rename).not.toHaveBeenCalled()
  })

  it("needs a name", async () => {
    const makeTeam = mock(async () => "ok" as const)
    const res = await post(
      appWith(
        { profile: profile() as never, organizations: { rename: mock(), makeTeam } },
        { tenantId: "ten-1", orgId: "org_p" },
      ),
      "/workspace/team",
      { name: "  " },
    )

    expect(res.status).toBe(422)
    expect(makeTeam).not.toHaveBeenCalled()
  })
})
