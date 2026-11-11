import { describe, expect, it } from "bun:test"
import { loadEnv } from "../src/env.js"
import { decide, type DecisionInput } from "../src/risk/decide.js"
import { evaluate, forceShadow } from "../src/risk/engine.js"
import { formatReport, replay, replaySnapshot } from "../src/risk/replay.js"
import { RULES } from "../src/risk/rules.js"
import { reviveFacts, serialiseFacts, type FactSnapshot } from "../src/risk/snapshot.js"
import type {
  Contribution,
  Facts,
  Rule,
  ShadowContribution,
} from "../src/risk/types.js"
import { ABUSE, baseFacts, daysAgo, LEGIT, NOW, peer } from "./risk-fixtures.js"

/**
 * Fact snapshots, replay and shadow rules (#170). See docs/decisions/risk.md,
 * "Snapshots, replay and shadow rules".
 */
const FIXTURES: [string, () => Facts][] = [
  ...Object.entries(LEGIT),
  ...Object.entries(ABUSE).map(([name, s]) => [name, s.facts] as [string, () => Facts]),
]

/** Through JSON text, the way jsonb hands it back. */
const throughJsonb = (f: Facts) =>
  JSON.parse(JSON.stringify(serialiseFacts(f))) as unknown

/** A snapshot as the runner would have written it for these facts. */
function snapshotOf(facts: Facts, rules: readonly Rule[] = RULES, n = 0): FactSnapshot {
  const e = evaluate(facts, rules)
  return {
    id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    tenantId: facts.tenantId,
    takenAt: facts.now,
    rulesetVersion: e.rulesetVersion,
    trigger: "hourly",
    score: e.score,
    band: e.band,
    contributions: JSON.parse(JSON.stringify(e.contributions)) as Contribution[],
    shadow: JSON.parse(JSON.stringify(e.shadow)) as ShadowContribution[],
    facts: throughJsonb(facts),
  }
}

/** A test-only shadow rule as loud as a rule can be: 100 points and a critical floor. */
const LOUD_SHADOW: Rule = {
  id: "test.shadow_critical",
  category: "content",
  summary: "Test-only: always fires at critical, in shadow",
  mode: "shadow",
  fresh: true,
  evaluate: (f) => ({
    points: 100,
    evidence: { test: true },
    floor: "critical",
    freshAt: f.now,
  }),
}

describe("serialising facts", () => {
  for (const [name, facts] of FIXTURES) {
    it(`round-trips, and scores the same: ${name}`, () => {
      const f = facts()
      const back = reviveFacts(throughJsonb(f))
      expect(back).toEqual(f)
      expect(evaluate(back)).toEqual(evaluate(f))
    })
  }

  it("revives every date as a Date, wherever it sits", () => {
    const f = baseFacts({
      paidSince: daysAgo(70),
      ses: {
        current: "disabled",
        currentOrigin: "aws",
        changedAt: daysAgo(1),
        pauses: [{ origin: "aws", at: daysAgo(2) }],
        findings: [
          { type: "x", impact: "high", openedAt: daysAgo(3), resolvedAt: null },
        ],
      },
      content: { probability: 0.8, at: daysAgo(0.1) },
    })
    const back = reviveFacts(throughJsonb(f))
    expect(back.now).toBeInstanceOf(Date)
    expect(back.ses.pauses[0]!.at).toBeInstanceOf(Date)
    expect(back.ses.findings[0]!.openedAt.getTime()).toBe(daysAgo(3).getTime())
    expect(back.content!.at).toBeInstanceOf(Date)
    expect(back.links.unsafe).toEqual([])
  })
})

describe("replay", () => {
  const snapshots = FIXTURES.map(([, f], i) =>
    snapshotOf({ ...f(), tenantId: `t-${i}` }, RULES, i),
  )

  it("reproduces every stored band and contribution with the same rules", () => {
    const { report, snapshots: out } = replay(snapshots, RULES)
    expect(report.snapshots).toBe(FIXTURES.length)
    expect(report.bandChanges).toEqual([])
    for (const r of out) expect(r.replayed).toEqual(r.stored)
    for (const r of report.rules) expect(r).toMatchObject({ differs: 0, failed: 0 })
    const off = Object.entries(report.transitions).flatMap(([from, row]) =>
      Object.entries(row).filter(([to, n]) => to !== from && n > 0),
    )
    expect(off).toEqual([])
  })

  it("shows the transitions a changed rule causes, and names the workspace", () => {
    // trust.mfa turned from -5 into +40: an MFA owner is now suspicious.
    const changed = RULES.map((r) =>
      r.id === "trust.mfa"
        ? {
            ...r,
            evaluate: (f: Facts) => (f.owner.mfa ? { points: 40, evidence: {} } : null),
          }
        : r,
    )
    const quiet = baseFacts({ tenantId: "t-quiet" })
    const mfa = baseFacts({
      tenantId: "t-mfa",
      owner: { ...baseFacts().owner, mfa: true },
    })
    expect(evaluate(quiet).band).toBe("low")
    expect(evaluate(mfa).band).toBe("low")
    const { report } = replay(
      [snapshotOf(quiet, RULES, 1), snapshotOf(mfa, RULES, 2)],
      changed,
    )

    expect(report.transitions.low).toEqual({
      low: 1,
      elevated: 1,
      high: 0,
      critical: 0,
    })
    expect(report.bandChanges).toHaveLength(1)
    const [c] = report.bandChanges
    expect(c!.tenantId).toBe("t-mfa")
    expect(c!.latest.from).toEqual({ score: evaluate(mfa).score, band: "low" })
    expect(c!.latest.to).toEqual({
      score: evaluate(mfa, changed).score,
      band: "elevated",
    })
    expect(report.rules.find((r) => r.rule === "trust.mfa")).toMatchObject({
      differs: 1,
      failed: 0,
    })
    expect(report.rules.filter((r) => r.differs > 0).map((r) => r.rule)).toEqual([
      "trust.mfa",
    ])
    expect(formatReport(report)).toContain("t-mfa  low")
  })

  it("counts a rule that was removed as differing wherever it had fired", () => {
    const bought = ABUSE["a bought list: first sends bounce hard"]!.facts()
    const without = RULES.filter((r) => r.id !== "list.early_bounce")
    const { report } = replay([snapshotOf(bought)], without)
    expect(report.rules.find((r) => r.rule === "list.early_bounce")).toEqual({
      rule: "list.early_bounce",
      mode: "removed",
      differs: 1,
      failed: 0,
    })
  })

  it("reports a shadow rule: where it fired and where it would have moved the band", () => {
    const withShadow = [...RULES, LOUD_SHADOW]
    const { report } = replay(snapshots, withShadow)
    // Shadow changes nothing that was stored...
    expect(report.bandChanges).toEqual([])
    // ...but it is a contribution that was not there before.
    expect(report.rules.find((r) => r.rule === LOUD_SHADOW.id)).toMatchObject({
      mode: "shadow",
      differs: snapshots.length,
    })
    const alreadyCritical = snapshots.filter((s) => s.band === "critical").length
    expect(report.shadow).toEqual([
      {
        rule: LOUD_SHADOW.id,
        fired: snapshots.length,
        wouldChangeBand: snapshots.length - alreadyCritical,
      },
    ])
    expect(formatReport(report)).toContain("no effect on score, band or actions")
  })

  it("replays a snapshot of an older shape: the rules that cannot read it fail, the rest score", () => {
    const f = baseFacts({
      farm: { peers: [peer(), peer()], trusted: { template: 0, boilerplate: 0 } },
    })
    const s = snapshotOf(f)
    // An older ruleset, before `farm` existed.
    const old = { ...(s.facts as Record<string, unknown>) }
    delete old.farm
    const r = replaySnapshot({ ...s, rulesetVersion: 1, facts: old }, RULES)
    expect(r.failed.sort()).toEqual(["farm.cluster", "farm.with_held"])
    expect(r.replayed.band).toBe("low")

    const { report } = replay([{ ...s, facts: old }, s], RULES)
    expect(report.rules.find((x) => x.rule === "farm.cluster")!.failed).toBe(1)
    expect(report.rules.find((x) => x.rule === "farm.with_held")!.failed).toBe(1)
  })

  it("does not crash on a snapshot whose facts are unreadable", () => {
    const r = replaySnapshot({ ...snapshotOf(baseFacts()), facts: null }, RULES)
    expect(r.failed.length).toBe(RULES.length)
  })
})

describe("shadow rules", () => {
  const input = (assessment: DecisionInput["assessment"]): DecisionInput => ({
    now: NOW,
    plan: "free",
    assessment,
    previous: null,
    tier: { tier: "normal", source: "default" },
    hold: null,
    switches: { tiers: true, holds: true, sesPolicy: true },
  })

  it("a shadow rule with a critical floor changes no score, band, contribution or action", () => {
    for (const [, facts] of FIXTURES) {
      const f = facts()
      const live = evaluate(f)
      const withShadow = evaluate(f, [...RULES, LOUD_SHADOW])
      expect(withShadow.shadow.map((c) => c.rule)).toEqual([LOUD_SHADOW.id])
      expect(withShadow.shadow[0]).toEqual({
        rule: LOUD_SHADOW.id,
        category: "content",
        wouldAdd: 100,
        wouldFloor: "critical",
        evidence: { test: true },
      })
      expect({ ...withShadow, shadow: [] }).toEqual({ ...live, shadow: [] })
      // Even handed the whole evaluation, shadow field and all, decide acts the same.
      expect(decide(input(withShadow))).toEqual(decide(input(live)))
    }
  })

  it("is not a contribution, so it cannot be scored or decided on", () => {
    const s: ShadowContribution = {
      rule: "x",
      category: "content",
      wouldAdd: 100,
      wouldFloor: "critical",
      evidence: {},
    }
    // @ts-expect-error a shadow contribution has no points or floor
    const c: Contribution = s
    // The proof is the compiler's; at run time there is no `points` to sum.
    expect((c as { points?: number }).points).toBeUndefined()
  })

  it("the brake moves a live rule into shadow and out of the score", () => {
    const bought = ABUSE["a bought list: first sends bounce hard"]!.facts()
    const live = evaluate(bought)
    const fired = live.contributions.find((c) => c.rule === "list.early_bounce")!
    expect(fired).toBeDefined()

    const braked = evaluate(bought, forceShadow(RULES, ["list.early_bounce"]))
    expect(braked.contributions.map((c) => c.rule)).not.toContain("list.early_bounce")
    expect(braked.shadow.map((c) => c.rule)).toEqual(["list.early_bounce"])
    expect(braked.shadow[0]!.wouldAdd).toBe(fired.points)
    // Braking scores exactly as if the rule did not exist.
    const without = evaluate(
      bought,
      RULES.filter((r) => r.id !== "list.early_bounce"),
    )
    expect({ score: braked.score, band: braked.band }).toEqual({
      score: without.score,
      band: without.band,
    })
    expect(RULES.find((r) => r.id === "list.early_bounce")!.mode).toBeUndefined()
  })

  it("the brake setting takes live rule ids and refuses anything else", () => {
    const env = (v: string | undefined) =>
      loadEnv({
        DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
        REDIS_URL: "redis://localhost:6379",
        CLERK_WEBHOOK_SECRET: "whsec_test",
        CLERK_SECRET_KEY: "sk_test_abc",
        MAIL_DOMAINS: "i10.tech",
        SES_CONFIGURATION_SET: "i10-events",
        ...(v === undefined ? {} : { RISK_SHADOW_RULES: v }),
      })
    expect(env(undefined).RISK_SHADOW_RULES).toEqual([])
    expect(env("").RISK_SHADOW_RULES).toEqual([])
    expect(
      env(" bounce.hard.7d , links.unsafe,bounce.hard.7d").RISK_SHADOW_RULES,
    ).toEqual(["bounce.hard.7d", "links.unsafe"])
    expect(() => env("bounce.hard.7d,bounce.typo")).toThrow(
      /not a live rule: bounce\.typo/,
    )
  })

  it("no rule in the shipped ruleset is in shadow", () => {
    expect(RULES.filter((r) => r.mode === "shadow")).toEqual([])
  })
})
