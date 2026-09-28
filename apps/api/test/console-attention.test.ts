import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { mountDomains } from "../src/routes/console/domains.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"

/**
 * The count behind the sidebar's mark on "Domains".
 *
 * ⚠ THE FAILURE WORTH GUARDING IS A LOUD ONE. This is fetched on every page, so
 * a reason that throws must drop out quietly rather than fail the shell, and
 * the Clerk lookup must not be repeated on every navigation.
 */

function appWith(over: Partial<ConsoleDeps>, userId = "user_1") {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: "ten-1", scopes: [], mode: "live" })
    c.set("user", { userId })
    await next()
  })
  // Cast: the route touches four fields - see console-rename.test.ts.
  mountDomains(app, {
    log: { error() {}, warn() {} },
    ...over,
  } as unknown as ConsoleDeps)
  return app
}

const read = async (app: Hono) =>
  (
    (await (await app.request("/attention")).json()) as {
      domains: Record<string, unknown>
    }
  ).domains

describe("GET /attention", () => {
  it("adds up unverified, losing proof, offers and reputation", async () => {
    const app = appWith(
      {
        domains: {
          needsAttention: async () => ({ unverified: 2, proofMissing: 1 }),
        } as never,
        people: {
          get: async () => ({ name: "", primaryEmail: null, verifiedEmails: ["a@x"] }),
        },
        transfers: { incoming: async () => [{}, {}] } as never,
        sesStatus: {
          current: async () => ({
            status: "enabled" as const,
            cause: null,
            origin: null,
            changedAt: new Date(),
            notifiedAt: null,
          }),
        },
        sesReputation: {
          openFindings: async () => [
            {
              id: "f",
              type: "bounce",
              impact: "high" as const,
              description: null,
              openedAt: new Date(),
              lastSeenAt: new Date(),
              notifiedAt: null,
            },
          ],
          counts: async () => ({
            sends: 0,
            hardBounces: 0,
            softBounces: 0,
            complaints: 0,
          }),
        },
      },
      "user_sum",
    )
    expect(await read(app)).toEqual({
      total: 6,
      unverified: 2,
      proof_missing: 1,
      transfers: 2,
      reputation: "at_risk",
    })
  })

  it("drops a reason that throws instead of failing", async () => {
    const app = appWith(
      {
        domains: {
          needsAttention: async () => ({ unverified: 1, proofMissing: 0 }),
        } as never,
        people: {
          get: async () => {
            throw new Error("clerk is down")
          },
        },
        transfers: { incoming: async () => [{}] } as never,
      },
      "user_throw",
    )
    const res = await app.request("/attention")
    expect(res.status).toBe(200)
    expect(
      ((await res.json()) as { domains: { total: number } }).domains,
    ).toMatchObject({
      total: 1,
      transfers: 0,
      reputation: "healthy",
    })
  })

  // ⚠ One Clerk call per person per minute, not one per page.
  it("remembers a person's verified addresses between navigations", async () => {
    const get = mock(async () => ({ name: "", primaryEmail: null, verifiedEmails: [] }))
    const app = appWith(
      { people: { get }, transfers: { incoming: async () => [] } as never },
      "user_cache",
    )
    await read(app)
    await read(app)
    expect(get).toHaveBeenCalledTimes(1)
  })
})
