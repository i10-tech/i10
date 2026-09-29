import { describe, expect, it, mock } from "bun:test"
import type { ResolvedEmail } from "../src/send/accept.js"
import { act, type ActDeps } from "../src/risk/act.js"
import { recordContent, type TripwireRedis } from "../src/risk/content.js"
import type { Database } from "../src/db/client.js"
import { riskTrigger } from "../src/risk/trigger.js"
import type { RiskDeps } from "../src/risk/runner.js"

/**
 * Carrying out decisions, re-scoring on demand, and the accept-time tripwire
 * (#170).
 */
const NOW = new Date("2026-09-28T12:00:00Z")

function deps(over: Partial<ActDeps> = {}) {
  const tiers = {
    current: mock(async () => ({
      tier: "normal" as const,
      source: "default" as const,
      reason: null,
      changedAt: null,
    })),
    set: mock(async () => ({ changed: true, from: "normal" as const })),
  }
  const holds = {
    current: mock(async () => null),
    hold: mock(async () => ({ canceled: 3 })),
    release: mock(async () => true),
    markNotified: mock(async () => {}),
    markReviewAlerted: mock(async () => {}),
  }
  const assessments = {
    current: mock(async () => null),
    save: mock(async () => ({ event: true })),
    setSesPolicy: mock(async () => {}),
    markAlerted: mock(async () => {}),
    pause: mock(async () => true),
    history: mock(async () => []),
  }
  const alert = mock(() => {})
  const d: ActDeps = {
    tiers,
    holds,
    assessments,
    alert,
    log: { error: mock(() => {}) },
    ...over,
  } as unknown as ActDeps
  return { d, tiers, holds, assessments, alert }
}

describe("acting", () => {
  it("moves a tier through the one door, as the score, respecting staff", async () => {
    const { d, tiers } = deps()
    const done = await act(
      "t",
      [{ kind: "tier", tier: "strict", reason: "why" }],
      d,
      NOW,
    )
    expect(done).toEqual(["tier:strict"])
    expect(tiers.set).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "score",
        setBy: "risk-score",
        respectStaff: true,
      }),
    )
  })

  it("records a staff refusal as such", async () => {
    const { d, tiers } = deps()
    tiers.set.mockImplementation((async () => ({
      changed: false,
      from: "normal",
      refused: "staff",
    })) as never)
    expect(
      await act("t", [{ kind: "tier", tier: "strict", reason: "r" }], d, NOW),
    ).toEqual(["tier:strict:refused-staff"])
  })

  it("holds, alerts, emails the owner and marks it notified", async () => {
    const held = mock(async () => {})
    const { d, holds, alert } = deps({ notice: { held } })
    const done = await act(
      "t",
      [{ kind: "hold", category: "bounces", reason: "r" }],
      d,
      NOW,
    )
    expect(done).toEqual(["hold:canceled=3"])
    expect(alert).toHaveBeenCalled()
    expect(held).toHaveBeenCalledWith({
      tenantId: "t",
      category: "bounces",
      canceled: 3,
    })
    expect(holds.markNotified).toHaveBeenCalled()
  })

  it("keeps the hold when the email fails", async () => {
    const { d, holds } = deps({
      notice: {
        held: async () => {
          throw new Error("smtp")
        },
      },
    })
    const done = await act(
      "t",
      [{ kind: "hold", category: "bounces", reason: "r" }],
      d,
      NOW,
    )
    expect(done).toEqual(["hold:canceled=3"])
    expect(holds.markNotified).not.toHaveBeenCalled()
  })

  it("does not hold twice", async () => {
    const { d, holds } = deps()
    holds.hold.mockImplementation((async () => null) as never)
    expect(
      await act("t", [{ kind: "hold", category: "bounces", reason: "r" }], d, NOW),
    ).toEqual(["hold:already"])
  })

  it("records a failed SES call as failed and carries on with the rest", async () => {
    const { d } = deps({
      sesPolicy: async () => {
        throw new Error("AccessDenied")
      },
    })
    const done = await act(
      "t",
      [
        { kind: "ses_policy", policy: "strict" },
        { kind: "alert", level: "warning", message: "m" },
      ],
      d,
      NOW,
    )
    expect(done).toEqual(["failed:ses_policy", "alert:warning"])
  })

  it("says when SES is unavailable rather than pretending", async () => {
    const { d } = deps()
    expect(await act("t", [{ kind: "ses_policy", policy: "strict" }], d, NOW)).toEqual([
      "ses:strict:unavailable",
    ])
  })

  it("records suppressed actions for staff", async () => {
    const { d } = deps()
    expect(
      await act("t", [{ kind: "suppressed", wanted: "hold", why: "off" }], d, NOW),
    ).toEqual(["suppressed:hold:off"])
  })
})

describe("the event-driven trigger", () => {
  function trigger(score: (id: string) => Promise<void>, opts = {}) {
    const redis = { sadd: mock(async () => 1) }
    const t = riskTrigger(
      {
        switches: { enabled: true, tiers: true, holds: true, sesPolicy: true },
        redis,
        exempt: new Set<string>(),
        // scoreTenant is replaced through its dependency on `act` - the lock and
        // switches still run - so the fake below stands in for the whole score.
        act: {} as never,
        log: { error: () => {}, warn: () => {} },
      } as unknown as RiskDeps,
      opts,
    )
    return { t, redis }
  }

  it("marks every requested workspace dirty, even when it drops them", async () => {
    const { t, redis } = trigger(async () => {}, { concurrency: 1, maxQueued: 1 })
    t.rescore(["a", "b", "c"], "test")
    expect(redis.sadd).toHaveBeenCalledWith("risk:dirty", "a", "b", "c")
    await t.idle()
  })

  it("does nothing when the engine is off", () => {
    const redis = { sadd: mock(async () => 1) }
    const t = riskTrigger({
      switches: { enabled: false, tiers: true, holds: true, sesPolicy: true },
      redis,
    } as unknown as RiskDeps)
    t.rescore(["a"], "test")
    expect(redis.sadd).not.toHaveBeenCalled()
  })
})

describe("the accept-time recorder and tripwire", () => {
  function fakeDb() {
    const statements: string[] = []
    const tx = {
      execute: mock(async (q: { queryChunks?: unknown[] }) => {
        statements.push(JSON.stringify(q.queryChunks ?? q))
        return []
      }),
    }
    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Database
    return { db, statements }
  }

  function fakeRedis(
    start = 0,
  ): TripwireRedis & { sets: Map<string, Set<string>>; tripped: Set<string> } {
    const sets = new Map<string, Set<string>>()
    const tripped = new Set<string>()
    return {
      sets,
      tripped,
      pipeline() {
        const ops: (() => unknown)[] = []
        const p = {
          sadd(key: string, member: string) {
            ops.push(() => {
              const s =
                sets.get(key) ??
                new Set(Array.from({ length: start }, (_, i) => `peer-${i}`))
              s.add(member)
              sets.set(key, s)
              return 1
            })
            return p
          },
          expire() {
            ops.push(() => 1)
            return p
          },
          scard(key: string) {
            ops.push(() => sets.get(key)?.size ?? 0)
            return p
          },
          async exec() {
            return ops.map((f) => [null, f()] as [null, unknown])
          },
        }
        return p
      },
      async smembers(key: string) {
        return [...(sets.get(key) ?? [])]
      },
      async set(key: string) {
        if (tripped.has(key)) return null
        tripped.add(key)
        return "OK"
      },
    }
  }

  const promo = (i: number): ResolvedEmail =>
    ({
      from: "a@x.top",
      to: `r${i}@example.com`,
      subject: "Exclusive offer",
      html: `<p>Claim your reward today, recipient ${i}. Limited stock, act now before the offer ends at https://deals.example.top/c?u=${i}</p>`,
    }) as ResolvedEmail

  it("stores one fingerprint for a batch of personalised copies, and the link host", async () => {
    const { db, statements } = fakeDb()
    await recordContent("t1", [promo(1), promo(2), promo(3)], { db, threshold: 5 })
    const fingerprints = statements.filter((s) => s.includes("content_fingerprints"))
    const links = statements.filter((s) => s.includes("link_hosts"))
    expect(fingerprints).toHaveLength(1)
    expect(links).toHaveLength(1)
    expect(links[0]).toContain("deals.example.top")
    expect(links[0]).not.toContain("u=")
  })

  it("stamps a stored body in the same transaction as its sightings", async () => {
    const { db, statements } = fakeDb()
    await recordContent(
      "t1",
      [
        {
          ...promo(1),
          messageId: crypto.randomUUID(),
          createdAt: "2026-09-29 10:00:00.123456+00",
        },
      ],
      { db, threshold: 5 },
    )
    expect(statements.some((s) => s.includes("fingerprinted_at"))).toBe(true)
    expect(statements.some((s) => s.includes("content_fingerprints"))).toBe(true)
  })

  it("re-scores the cluster when a fingerprint reaches the threshold, once per hour", async () => {
    const { db } = fakeDb()
    const redis = fakeRedis(4)
    const rescore = mock(() => {})
    await recordContent("t1", [promo(1)], { db, redis, threshold: 5, rescore })
    const calls = rescore.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    expect((rescore.mock.calls[0] as unknown as [string[], string])[0]).toContain("t1")
    await recordContent("t1", [promo(2)], { db, redis, threshold: 5, rescore })
    expect(rescore.mock.calls.length).toBe(calls)
  })

  it("stays quiet below the threshold", async () => {
    const { db } = fakeDb()
    const rescore = mock(() => {})
    await recordContent("t1", [promo(1)], {
      db,
      redis: fakeRedis(0),
      threshold: 5,
      rescore,
    })
    expect(rescore).not.toHaveBeenCalled()
  })

  it("skips mail too short to fingerprint", async () => {
    const { db, statements } = fakeDb()
    await recordContent(
      "t1",
      [{ from: "a@b.c", to: "x@y.z", subject: "hi", text: "test" } as ResolvedEmail],
      { db, threshold: 5 },
    )
    expect(statements).toHaveLength(0)
  })
})
