import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountDomains } from "../src/routes/console/domains.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * Moving a domain between two workspaces the same person is in (2026-10-13):
 * the transfer, offered to their own verified address and accepted at once.
 */

function appWith(over: Record<string, unknown>, fresh = true) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: "ten-a", scopes: [], mode: "live" })
    c.set("user", { userId: "user_1" })
    c.set(
      "freshAuth" as never,
      (async () => ({ status: fresh ? "fresh" : "stale" })) as never,
    )
    await next()
  })
  // Cast: the routes touch a handful of fields - see console-rename.test.ts.
  mountDomains(app, {
    log: { error() {}, warn() {} },
    ...over,
  } as unknown as ConsoleDeps)
  return app
}

function deps(
  accept: unknown = {
    status: "accepted",
    domainId: "dom_1",
    domainName: "acme.com",
    keys: { secretHashes: [] },
  },
) {
  const transfers = {
    offer: mock(async () => ({
      status: "offered",
      offer: { id: "off_1", recipient_email: "me@acme.com" },
    })),
    accept: mock(async () => accept),
    cancel: mock(async () => true),
  }
  return {
    transfers,
    over: {
      transfers,
      people: {
        get: async () => ({
          name: "Ada",
          primaryEmail: "me@acme.com",
          verifiedEmails: ["me@acme.com"],
        }),
      },
      profile: { get: async () => ({ name: "A" }) },
      memberships: {
        list: async () => [
          { id: "org_a", name: "A" },
          { id: "org_b", name: "B" },
        ],
      },
      tenants: {
        resolve: async ({ orgId }: { orgId: string }) =>
          orgId === "org_a" ? "ten-a" : "ten-b",
      },
    },
  }
}

const move = (app: Hono, body: unknown) =>
  app.request("/domains/dom_1/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("moving a domain between your own workspaces", () => {
  it("lists only the other workspaces", async () => {
    const res = await appWith(deps().over).request("/domains/dom_1/move-targets")
    expect(await res.json()).toEqual({ data: [{ id: "org_b", name: "B" }] })
  })

  it("offers to their own address and accepts into the chosen workspace", async () => {
    const { transfers, over } = deps()
    const res = await move(appWith(over), { workspace: "org_b" })
    expect(res.status).toBe(200)
    expect(transfers.offer.mock.calls[0]).toMatchObject([
      "ten-a",
      "dom_1",
      { email: "me@acme.com" },
    ])
    expect(transfers.accept.mock.calls[0]).toMatchObject([
      { tenantId: "ten-a", id: "off_1", toTenantId: "ten-b" },
    ])
    expect(transfers.cancel).not.toHaveBeenCalled()
  })

  it("refuses a workspace they are not in, or the one it is already in", async () => {
    const { transfers, over } = deps()
    expect((await move(appWith(over), { workspace: "org_z" })).status).toBe(422)
    expect((await move(appWith(over), { workspace: "org_a" })).status).toBe(422)
    expect(transfers.offer).not.toHaveBeenCalled()
  })

  it("withdraws the offer when the move cannot land", async () => {
    const { transfers, over } = deps({
      status: "limited",
      reason: "Plan limit reached.",
    })
    const res = await move(appWith(over), { workspace: "org_b" })
    expect(res.status).toBe(403)
    expect(transfers.cancel).toHaveBeenCalledWith("ten-a", "dom_1")
  })

  it("asks for a fresh sign-in first", async () => {
    const { transfers, over } = deps()
    const res = await move(appWith(over, false), { workspace: "org_b" })
    expect(res.status).toBe(403)
    expect(transfers.offer).not.toHaveBeenCalled()
  })
})
