import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountShapes } from "../src/routes/console/shapes.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { ShapeCounts } from "../src/console/queries.js"

function appWith(over: Partial<ConsoleDeps>, userId = "user_1", tenantId = "ten-1") {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId, scopes: [], mode: "live" })
    c.set("user", { userId })
    await next()
  })
  mountShapes(app, {
    log: { error() {}, warn() {} },
    ...over,
  } as unknown as ConsoleDeps)
  return app
}

const getShapes = async (app: Hono) => {
  const res = await app.request("/shapes")
  expect(res.status).toBe(200)
  return (await res.json()) as { data: ShapeCounts }
}

describe("GET /console/shapes", () => {
  it("returns counts for every list page when all queries succeed", async () => {
    const fullDbCounts: Omit<ShapeCounts, "transfers"> = {
      domains: 3,
      apiKeys: 2,
      emails: 5,
      logs: 7,
      suppressions: 1,
      contacts: 4,
      segments: 2,
      topics: 3,
      broadcasts: 1,
      webhooks: 2,
      templates: 6,
    }

    const app = appWith({
      queries: {
        countShapes: async (tenantId: string) => {
          expect(tenantId).toBe("ten-1")
          return fullDbCounts
        },
      } as unknown as ConsoleDeps["queries"],
      people: {
        get: async (userId: string) => {
          expect(userId).toBe("user_1")
          return {
            name: "User",
            primaryEmail: null,
            verifiedEmails: ["user@test.local"],
          }
        },
      },
      transfers: {
        incoming: async (tenantId: string, emails: string[]) => {
          expect(tenantId).toBe("ten-1")
          expect(emails).toEqual(["user@test.local"])
          return [{}, {}] as never
        },
      } as unknown as ConsoleDeps["transfers"],
    })

    const body = await getShapes(app)
    expect(body.data).toEqual({
      domains: 3,
      transfers: 2,
      apiKeys: 2,
      emails: 5,
      logs: 7,
      suppressions: 1,
      contacts: 4,
      segments: 2,
      topics: 3,
      broadcasts: 1,
      webhooks: 2,
      templates: 6,
    })
  })

  it("caps counts at 10", async () => {
    const app = appWith(
      {
        queries: {
          countShapes: async () => ({
            domains: 10,
            apiKeys: 10,
          }),
        } as unknown as ConsoleDeps["queries"],
        people: {
          get: async () => ({ name: "", primaryEmail: null, verifiedEmails: ["u@x"] }),
        },
        transfers: {
          incoming: async () => new Array(25).fill({}),
        } as unknown as ConsoleDeps["transfers"],
      },
      "user_cap",
    )

    const body = await getShapes(app)
    expect(body.data.transfers).toBe(10)
    expect(body.data.domains).toBe(10)
    expect(body.data.apiKeys).toBe(10)
  })

  it("omits transfers key when transfers or clerk throws", async () => {
    const app = appWith(
      {
        queries: {
          countShapes: async () => ({
            domains: 2,
            emails: 1,
          }),
        } as unknown as ConsoleDeps["queries"],
        people: {
          get: async () => {
            throw new Error("clerk rate limited")
          },
        },
        transfers: {
          incoming: async () => [{}] as never,
        } as unknown as ConsoleDeps["transfers"],
      },
      "user_throw",
    )

    const body = await getShapes(app)
    expect(body.data.domains).toBe(2)
    expect(body.data.emails).toBe(1)
    expect(body.data.transfers).toBeUndefined()
  })

  it("omits missing or failing db count keys without failing the call", async () => {
    const app = appWith({
      queries: {
        countShapes: async () => ({
          domains: 3,
          // other keys omitted
        }),
      } as unknown as ConsoleDeps["queries"],
    })

    const body = await getShapes(app)
    expect(body.data.domains).toBe(3)
    expect(body.data.transfers).toBeUndefined()
    expect(body.data.emails).toBeUndefined()
  })

  describe("the SSO, templates and billing counts", () => {
    const plan = (id: string, rank: number, entitlements: number) => ({
      id,
      name: id,
      rank,
      source: "catalog",
      entitlements: Array.from({ length: entitlements }, (_, i) => ({
        featureId: `f${i}`,
        kind: "metered",
        allowance: 1,
      })),
    })
    const catalog = [plan("free", 0, 4), plan("starter", 1, 5), plan("pro", 2, 3)]
    const billing = (sub: Record<string, unknown> | null, rank = 2) => ({
      plan: plan("pro", rank, 3),
      subscription: sub && {
        status: "active",
        plan_id: "pro",
        cancel_at_period_end: false,
        current_period_end: "2026-12-01T00:00:00.000Z",
        scheduled_plan_id: null,
        scheduled_at: null,
        polar_customer_id: "cus_1",
        ...sub,
      },
      anchor: null,
      overage_enabled: false,
      storage_bytes: null,
    })
    const withUsage = (b: unknown, over: Partial<ConsoleDeps> = {}) =>
      appWith({
        usage: {
          catalog: async () => catalog,
          billing: async () => b,
        } as unknown as ConsoleDeps["usage"],
        ...over,
      })

    it("passes the SSO and templates counts through", async () => {
      const app = appWith({
        queries: {
          countShapes: async () => ({
            ssoConnections: 5,
            ssoDirectories: 3,
            templates: 1,
            templateFolders: 5,
            trustedTemplates: 2,
            githubInstallations: 1,
            githubRepos: 2,
          }),
        } as unknown as ConsoleDeps["queries"],
      })
      const { data } = await getShapes(app)
      expect(data).toMatchObject({
        ssoConnections: 5,
        ssoDirectories: 3,
        templates: 1,
        templateFolders: 5,
        trustedTemplates: 2,
        githubInstallations: 1,
        githubRepos: 2,
      })
    })

    it("leaves an SSO count out when its read failed, so the page draws neutral rows", async () => {
      const app = appWith({
        queries: {
          countShapes: async () => ({ domains: 2, ssoConnections: 1 }),
        } as unknown as ConsoleDeps["queries"],
      })
      const { data } = await getShapes(app)
      expect(data.ssoConnections).toBe(1)
      expect(data.ssoDirectories).toBeUndefined()
    })

    it("flags whether the GitHub app is wired", async () => {
      expect((await getShapes(appWith({}))).data.githubConfigured).toBeUndefined()
      const wired = appWith({ github: {} as unknown as ConsoleDeps["github"] })
      expect((await getShapes(wired)).data.githubConfigured).toBe(1)
    })

    it("sizes the plan catalogue and its longest card", async () => {
      const { data } = await getShapes(withUsage(billing(null)))
      expect(data.plans).toBe(3)
      expect(data.planEntitlements).toBe(5)
      expect(data.planNoteCard).toBeUndefined()
    })

    it("caps the catalogue like every other count", async () => {
      const many = Array.from({ length: 14 }, (_, i) => plan(`p${i}`, i, 15))
      const app = appWith({
        usage: {
          catalog: async () => many,
          billing: async () => billing(null),
        } as unknown as ConsoleDeps["usage"],
      })
      const { data } = await getShapes(app)
      expect(data.plans).toBe(10)
      expect(data.planEntitlements).toBe(10)
    })

    it("puts a scheduled change's note on that plan's card, three lines", async () => {
      const { data } = await getShapes(
        withUsage(billing({ scheduled_plan_id: "starter" })),
      )
      expect(data.planNoteCard).toBe(1)
      expect(data.planNoteLines).toBe(3)
    })

    it("puts an ending subscription's note on the free card, two lines", async () => {
      const { data } = await getShapes(
        withUsage(billing({ cancel_at_period_end: true })),
      )
      expect(data.planNoteCard).toBe(0)
      expect(data.planNoteLines).toBe(2)
    })

    it("says no note when nothing is pending or the plan is not on offer", async () => {
      expect(
        (await getShapes(withUsage(billing({})))).data.planNoteCard,
      ).toBeUndefined()
      const gone = await getShapes(withUsage(billing({ scheduled_plan_id: "gone" })))
      expect(gone.data.planNoteCard).toBeUndefined()
    })

    it("omits the plan counts, not the call, when the catalogue read fails", async () => {
      const app = appWith({
        queries: {
          countShapes: async () => ({ domains: 2 }),
        } as unknown as ConsoleDeps["queries"],
        usage: {
          catalog: async () => {
            throw new Error("down")
          },
          billing: async () => billing(null),
        } as unknown as ConsoleDeps["usage"],
      })
      const { data } = await getShapes(app)
      expect(data.domains).toBe(2)
      expect(data.plans).toBeUndefined()
      expect(data.planEntitlements).toBeUndefined()
    })
  })

  it("returns 200 with empty data if queries is not wired", async () => {
    const app = appWith({})
    const body = await getShapes(app)
    expect(body.data).toEqual({})
  })
})
