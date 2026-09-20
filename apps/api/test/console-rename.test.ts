import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountAccount } from "../src/routes/console/account.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * Renaming a workspace renames its Clerk organization.
 *
 * ⚠ THESE WERE TWO NAMES ON PURPOSE, AND THE PURPOSE WAS HALF RIGHT. Syncing
 * them must not put a write to somebody else's API inside our rename
 * transaction, or a Clerk outage makes renaming a workspace impossible — that
 * reasoning still holds and the ordering below is what preserves it. What the
 * reasoning did not survive was contact with a customer: an organization still
 * called "Mohamed" in the switcher long after the workspace became "i10
 * testing", with nothing anywhere to reconcile them and no explanation of why
 * there were two names at all. Reported from production 2026-09-20.
 */

const log = { error: () => {}, warn: () => {} }

function appWith(over: Partial<ConsoleDeps>) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    /*
     * ⚠ EXACTLY WHAT `requireTenant` SETS FOR A CONSOLE SESSION, INCLUDING THE
     * EMPTY `apiKeyId`. There is no key behind a browser session, and the empty
     * string is how that is said rather than a placeholder for one — see
     * middleware/tenant.ts. Scopes are empty for the same reason: the person
     * here IS the owner, so there is nothing to narrow.
     */
    c.set("auth", { apiKeyId: "", tenantId: "ten-1", scopes: [], mode: "live" })
    c.set("user", { userId: "user_1" })
    await next()
  })

  // ⚠ CAST RATHER THAN A FULL STUB, AND ONLY BECAUSE THE ROUTES UNDER TEST
  // TOUCH THREE FIELDS. Building the whole of `ConsoleDeps` here would be forty
  // lines of doubles for queries, usage, marketing and onboarding, none of
  // which this endpoint calls — and every one of them a thing to keep in step
  // with a type that is not what these tests are about.
  mountAccount(app, { log, ...over } as unknown as ConsoleDeps)
  return app
}

const rename = (app: Hono, name: unknown) =>
  app.request("/me/tenant", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })

const profile = (over: Record<string, unknown> = {}) => ({
  get: mock(async () => ({
    id: "ten-1",
    slug: "acme",
    name: "Acme",
    status: "active",
    clerk_org_id: "org_1",
    created_at: "2026-09-01T00:00:00.000Z",
  })),
  rename: mock(async () => true),
  ...over,
})

describe("PATCH /console/me/tenant", () => {
  it("renames the Clerk organization to match", async () => {
    const organizations = { rename: mock(async () => {}) }
    const res = await rename(
      appWith({ profile: profile(), organizations }),
      "i10 testing",
    )

    expect(res.status).toBe(200)
    expect(organizations.rename).toHaveBeenCalledWith("org_1", "i10 testing")
  })

  /*
   * ⚠ OURS COMMITS FIRST, AND THE ORDER IS THE WHOLE DESIGN. Renaming Clerk
   * first and then failing our own write would leave the switcher showing a
   * name the invoice does not — and would make a Clerk outage able to stop a
   * rename, which is the objection the original split was built around.
   */
  it("commits our own rename before it calls Clerk at all", async () => {
    const order: string[] = []
    const p = profile({
      rename: mock(async () => {
        order.push("ours")
        return true
      }),
    })
    const organizations = {
      rename: mock(async () => {
        order.push("clerk")
      }),
    }

    await rename(appWith({ profile: p, organizations }), "i10 testing")
    expect(order).toEqual(["ours", "clerk"])
  })

  /*
   * ⚠ A CLERK FAILURE IS NOT THE CALLER'S PROBLEM, BECAUSE THE RENAME ALREADY
   * HAPPENED. Reporting an error for a workspace that IS renamed would invite
   * somebody to do it again, and the state it leaves — two names briefly apart
   * — is exactly the state the old behaviour was in permanently.
   */
  it("still answers 200 when Clerk refuses", async () => {
    const res = await rename(
      appWith({
        profile: profile(),
        organizations: {
          rename: mock(async () => {
            throw new Error("clerk is down")
          }),
        },
      }),
      "i10 testing",
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, name: "i10 testing" })
  })

  // ⚠ WITHOUT THE PORT IT BEHAVES EXACTLY AS IT DID BEFORE. Absence is the old
  // behaviour — the two names drift — rather than a crash.
  it("renames ours alone when no Clerk client is wired", async () => {
    const p = profile()
    const res = await rename(appWith({ profile: p }), "i10 testing")

    expect(res.status).toBe(200)
    expect(p.rename).toHaveBeenCalledWith("ten-1", "i10 testing")
  })

  // A tenant with no organization — provisioned before one existed, or made by
  // hand. There is nothing on Clerk's side to rename.
  it("calls Clerk about nothing when the tenant has no organization", async () => {
    const organizations = { rename: mock(async () => {}) }
    await rename(
      appWith({
        profile: profile({
          get: mock(async () => ({
            id: "ten-1",
            slug: "acme",
            name: "Acme",
            status: "active",
            clerk_org_id: null,
            created_at: "2026-09-01T00:00:00.000Z",
          })),
        }),
        organizations,
      }),
      "i10 testing",
    )

    expect(organizations.rename).not.toHaveBeenCalled()
  })

  // ⚠ AND A REFUSED RENAME NEVER REACHES CLERK. A 404 here means no workspace
  // moved, so renaming the organization would make Clerk the only place the new
  // name exists.
  it("does not rename the organization when our own rename found nothing", async () => {
    const organizations = { rename: mock(async () => {}) }
    const res = await rename(
      appWith({ profile: profile({ rename: mock(async () => false) }), organizations }),
      "i10 testing",
    )

    expect(res.status).toBe(404)
    expect(organizations.rename).not.toHaveBeenCalled()
  })

  it.each([
    ["an empty name", ""],
    ["whitespace only", "   "],
    ["something that is not a string", 42],
  ])("refuses %s without touching either system", async (_why, value) => {
    const p = profile()
    const organizations = { rename: mock(async () => {}) }
    const res = await rename(appWith({ profile: p, organizations }), value)

    expect(res.status).toBe(422)
    expect(p.rename).not.toHaveBeenCalled()
    expect(organizations.rename).not.toHaveBeenCalled()
  })
})
