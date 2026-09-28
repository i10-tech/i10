import { describe, expect, it } from "bun:test"
import { decide, RELAX_AFTER_DAYS, type DecisionInput } from "../src/risk/decide.js"
import type { Assessment, Band } from "../src/risk/types.js"
import { NOW } from "./risk-fixtures.js"

/**
 * What the score does about an assessment (#170): every action, and every
 * reason it declines to act.
 */
const DAY = 86_400_000

const assessment = (
  band: Band,
  score: number,
  extra: Partial<Assessment> = {},
): Assessment => ({
  band,
  score,
  rulesetVersion: 1,
  contributions: [
    { rule: "bounce.hard.7d", category: "bounces", points: score, evidence: {} },
  ],
  ...extra,
})

const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  now: NOW,
  plan: "free",
  assessment: assessment("low", 0),
  previous: null,
  tier: { tier: "normal", source: "default" },
  hold: null,
  switches: { tiers: true, holds: true, sesPolicy: true },
  ...over,
})

const kinds = (i: DecisionInput) => decide(i).actions.map((a) => a.kind)

describe("free workspaces", () => {
  it("does nothing when low", () => {
    expect(kinds(input())).toEqual([])
  })

  it("moves an elevated workspace to strict", () => {
    const { actions } = decide(input({ assessment: assessment("elevated", 40) }))
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "tier", tier: "strict" }),
    )
  })

  it("never overrides a tier staff set, and says so", () => {
    const { actions } = decide(
      input({
        assessment: assessment("high", 70),
        tier: { tier: "normal", source: "staff" },
      }),
    )
    expect(actions.find((a) => a.kind === "tier")).toBeUndefined()
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "suppressed", wanted: "tier:strict" }),
    )
  })

  it("restores normal only after the band has sat low for two weeks, and only its own demotion", () => {
    const low = assessment("low", 5)
    const recent = {
      band: "low" as Band,
      bandSince: new Date(NOW.getTime() - 3 * DAY),
      autoActionsPausedUntil: null,
      clearedAt: null,
      sesPolicy: null,
    }
    const settled = {
      ...recent,
      bandSince: new Date(NOW.getTime() - (RELAX_AFTER_DAYS + 1) * DAY),
    }
    expect(
      kinds(
        input({
          assessment: low,
          previous: recent,
          tier: { tier: "strict", source: "score" },
        }),
      ),
    ).not.toContain("tier")
    expect(
      decide(
        input({
          assessment: low,
          previous: settled,
          tier: { tier: "strict", source: "score" },
        }),
      ).actions,
    ).toContainEqual(expect.objectContaining({ kind: "tier", tier: "normal" }))
    expect(
      kinds(
        input({
          assessment: low,
          previous: settled,
          tier: { tier: "strict", source: "staff" },
        }),
      ),
    ).not.toContain("tier")
  })

  it("holds a critical workspace", () => {
    expect(kinds(input({ assessment: assessment("critical", 95) }))).toContain("hold")
  })

  it("does not hold twice", () => {
    const hold = { reviewDueAt: new Date(NOW.getTime() + DAY), reviewAlertedAt: null }
    expect(
      kinds(input({ assessment: assessment("critical", 95), hold })),
    ).not.toContain("hold")
  })
})

describe("paid workspaces", () => {
  it("never gets a tier", () => {
    expect(
      kinds(input({ plan: "paid", assessment: assessment("high", 70) })),
    ).not.toContain("tier")
  })

  it("moves SES to strict at high, once", () => {
    const first = decide(input({ plan: "paid", assessment: assessment("high", 70) }))
    expect(first.actions).toContainEqual({ kind: "ses_policy", policy: "strict" })
    const previous = {
      band: "high" as Band,
      bandSince: NOW,
      autoActionsPausedUntil: null,
      clearedAt: null,
      sesPolicy: "strict",
    }
    expect(
      kinds(input({ plan: "paid", assessment: assessment("high", 70), previous })),
    ).not.toContain("ses_policy")
  })

  it("relaxes SES back to standard after two weeks below high", () => {
    const previous = {
      band: "low" as Band,
      bandSince: new Date(NOW.getTime() - 20 * DAY),
      autoActionsPausedUntil: null,
      clearedAt: null,
      sesPolicy: "strict",
    }
    expect(
      decide(input({ plan: "paid", assessment: assessment("low", 0), previous }))
        .actions,
    ).toContainEqual({ kind: "ses_policy", policy: "standard" })
  })

  it("holds a critical paid workspace too", () => {
    expect(
      kinds(input({ plan: "paid", assessment: assessment("critical", 90) })),
    ).toContain("hold")
  })
})

describe("a staff release pauses the score's hand", () => {
  const paused = {
    band: "critical" as Band,
    bandSince: new Date(NOW.getTime() - DAY),
    autoActionsPausedUntil: new Date(NOW.getTime() + 10 * DAY),
    clearedAt: new Date(NOW.getTime() - DAY),
    sesPolicy: null,
  }

  it("does not re-hold on the evidence a person just dismissed", () => {
    const { actions } = decide(
      input({ assessment: assessment("critical", 95), previous: paused }),
    )
    expect(actions.find((a) => a.kind === "hold")).toBeUndefined()
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "suppressed", wanted: "hold" }),
    )
  })

  it("re-holds on fresh critical evidence from after the release", () => {
    const fresh = assessment("critical", 90, {
      contributions: [
        {
          rule: "links.unsafe",
          category: "unsafe_links",
          points: 90,
          evidence: {},
          floor: "critical",
          freshAt: NOW.toISOString(),
        },
      ],
    })
    expect(kinds(input({ assessment: fresh, previous: paused }))).toContain("hold")
  })

  it("ignores 'fresh' evidence that predates the release", () => {
    const stale = assessment("critical", 90, {
      contributions: [
        {
          rule: "links.unsafe",
          category: "unsafe_links",
          points: 90,
          evidence: {},
          floor: "critical",
          freshAt: new Date(NOW.getTime() - 5 * DAY).toISOString(),
        },
      ],
    })
    expect(kinds(input({ assessment: stale, previous: paused }))).not.toContain("hold")
  })
})

describe("switches", () => {
  it("records what it would have done when an action is switched off", () => {
    const off = { tiers: false, holds: false, sesPolicy: false }
    const free = decide(
      input({ assessment: assessment("critical", 95), switches: off }),
    )
    expect(free.actions.filter((a) => a.kind === "suppressed")).toHaveLength(2)
    const paid = decide(
      input({ plan: "paid", assessment: assessment("critical", 95), switches: off }),
    )
    expect(
      paid.actions.map((a) => (a.kind === "suppressed" ? a.wanted : a.kind)),
    ).toEqual(expect.arrayContaining(["hold", "ses:strict"]))
  })
})

describe("alerts and reviews", () => {
  it("alerts on a rise, not on a steady state", () => {
    expect(kinds(input({ assessment: assessment("high", 70) }))).toContain("alert")
    const previous = {
      band: "high" as Band,
      bandSince: NOW,
      autoActionsPausedUntil: null,
      clearedAt: null,
      sesPolicy: null,
    }
    expect(
      kinds(input({ assessment: assessment("high", 72), previous })),
    ).not.toContain("alert")
  })

  it("alerts on elevated only for paying customers", () => {
    expect(kinds(input({ assessment: assessment("elevated", 40) }))).not.toContain(
      "alert",
    )
    expect(
      kinds(input({ plan: "paid", assessment: assessment("elevated", 40) })),
    ).toContain("alert")
  })

  it("raises an overdue review once (GDPR Article 22)", () => {
    const overdue = { reviewDueAt: new Date(NOW.getTime() - 1), reviewAlertedAt: null }
    expect(kinds(input({ hold: overdue }))).toContain("review_overdue")
    expect(kinds(input({ hold: { ...overdue, reviewAlertedAt: NOW } }))).not.toContain(
      "review_overdue",
    )
  })

  it("tells the owner about a possibly leaked key when the signal starts, not every hour", () => {
    const a = assessment("low", 10, {
      contributions: [
        {
          rule: "api.key_geo_spread",
          category: "account_security",
          points: 10,
          evidence: {},
        },
      ],
    })
    expect(kinds(input({ assessment: a }))).toContain("key_spread_notice")
    expect(
      kinds(input({ assessment: a, previousRules: ["api.key_geo_spread"] })),
    ).not.toContain("key_spread_notice")
  })

  it("keeps band_since while the band holds and resets it on a change", () => {
    const since = new Date(NOW.getTime() - 5 * DAY)
    const previous = {
      band: "elevated" as Band,
      bandSince: since,
      autoActionsPausedUntil: null,
      clearedAt: null,
      sesPolicy: null,
    }
    expect(
      decide(input({ assessment: assessment("elevated", 45), previous })).bandSince,
    ).toEqual(since)
    expect(
      decide(input({ assessment: assessment("high", 65), previous })).bandSince,
    ).toEqual(NOW)
  })

  it("never outputs termination, whatever the score", () => {
    const all = decide(
      input({ plan: "paid", assessment: assessment("critical", 100) }),
    ).actions
    expect(all.map((a) => a.kind).join(" ")).not.toMatch(/terminat/)
  })
})
