import { describe, expect, it } from "bun:test"
import { decide } from "../src/risk/decide.js"
import {
  concernsFor,
  decisionCases,
  disagrees,
  type StoredDecision,
} from "../src/risk/decisions.js"
import { DECISION_MEMORY_DAYS, evaluate } from "../src/risk/engine.js"
import { replaySnapshot } from "../src/risk/replay.js"
import { digest, RULES } from "../src/risk/rules.js"
import { serialiseFacts, type FactSnapshot } from "../src/risk/snapshot.js"
import type {
  ClearedContribution,
  Contribution,
  Facts,
  Rule,
  StaffDecision,
} from "../src/risk/types.js"
import {
  ABUSE,
  baseFacts,
  counts,
  daysAgo,
  LEGIT,
  NO_TRUST,
  NOW,
  peer,
} from "./risk-fixtures.js"

/**
 * Decision memory (docs/decisions/risk.md, "Decision memory"): a concern staff
 * cleared stays cleared for the same evidence, and counts in full for new.
 */
const DAY = 86_400_000

const link = (host: string, day = "2026-09-27") => ({
  host,
  verdict: "webrisk=SOCIAL_ENGINEERING",
  day,
})
const phishing = (...hosts: string[]) =>
  baseFacts({ links: { unsafe: hosts.map((h) => link(h)) } })

/** A release made a day before NOW, covering every live concern in `seen`. */
function releasedOn(seen: Facts, over: Partial<StaffDecision> = {}): StaffDecision {
  const decidedAt = daysAgo(1)
  return {
    id: "00000000-0000-7000-8000-00000000d001",
    kind: "release",
    decidedAt,
    expiresAt: new Date(decidedAt.getTime() + DECISION_MEMORY_DAYS * DAY),
    revokedAt: null,
    covers: concernsFor(evaluate({ ...seen, now: decidedAt }).contributions),
    ...over,
  }
}

const later = (facts: Facts, decisions: StaffDecision[]) =>
  evaluate({ ...facts, decisions })
const live = (e: ReturnType<typeof evaluate>) => e.contributions.map((c) => c.rule)
const cleared = (e: ReturnType<typeof evaluate>) => e.cleared.map((c) => c.rule)

describe("decision memory: what a release clears", () => {
  it("clears the same evidence: worth zero, recorded, and named by the decision", () => {
    const seen = phishing("login-verify.example")
    const d = releasedOn(seen)
    const e = later(seen, [d])
    expect(live(e)).not.toContain("links.unsafe")
    expect(cleared(e)).toEqual(["links.unsafe"])
    expect(e.cleared[0]).toMatchObject({
      wouldAdd: 90,
      wouldFloor: "critical",
      keys: ["host:login-verify.example"],
      clearedBy: d.id,
      decidedAt: d.decidedAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
    })
    expect(e.band).toBe(evaluate(baseFacts()).band)
    expect(e.score).toBe(evaluate(baseFacts()).score)
  })

  it("counts in full a host that was not cleared, even beside one that was", () => {
    const d = releasedOn(phishing("a.example"))
    const e = later(phishing("a.example", "b.example"), [d])
    expect(cleared(e)).toEqual([])
    const c = e.contributions.find((x) => x.rule === "links.unsafe")!
    expect(c.points).toBe(90)
    expect(c.keys).toEqual(["host:a.example", "host:b.example"])
    expect(e.band).toBe("critical")
  })

  it("does not cover a different host seen later", () => {
    const d = releasedOn(phishing("a.example"))
    expect(later(phishing("b.example"), [d]).band).toBe("critical")
  })

  it("counts the same key again when the rule now scores it higher", () => {
    const oneList = baseFacts({
      links: {
        unsafe: [
          { host: "x.example", verdict: "cloudflare=blocked", day: "2026-09-27" },
        ],
      },
    })
    const d = releasedOn(oneList)
    expect(d.covers).toEqual([
      { rule: "links.unsafe", points: 45, keys: ["host:x.example"] },
    ])
    const e = later(phishing("x.example"), [d])
    expect(e.contributions.find((x) => x.rule === "links.unsafe")?.points).toBe(90)
  })

  it("clears a keyless rule at the same points, and counts it at higher points", () => {
    const at = (complaints: number) =>
      baseFacts({
        rates: {
          day1: counts(20),
          day7: counts(1500, 3, complaints),
          early: { sends: 500, hardBounces: 2 },
          unsubscribes7d: 0,
          trailingDaily: [200, 200, 200, 200, 200, 200],
        },
      })
    const d = releasedOn(at(2))
    expect(d.covers.find((c) => c.rule === "complaint.7d")).toEqual({
      rule: "complaint.7d",
      points: 25,
    })
    expect(cleared(later(at(2), [d]))).toEqual(["complaint.7d"])
    // Fewer complaints, still firing lower: the same concern, lighter.
    const lighter = baseFacts({
      rates: { ...at(2).rates, day7: counts(15000, 3, 12) },
    })
    expect(cleared(later(lighter, [d]))).toContain("complaint.7d")
    const worse = later(at(6), [d])
    expect(worse.contributions.find((c) => c.rule === "complaint.7d")?.points).toBe(45)
    expect(cleared(worse)).toEqual([])
  })

  it("counts a keyless fresh rule whose evidence is newer than the decision", () => {
    const at = { value: daysAgo(3) }
    const fresh: Rule = {
      id: "test.fresh",
      category: "provider_flag",
      summary: "Test-only: a fresh rule with no keys",
      fresh: true,
      evaluate: () => ({ points: 40, evidence: {}, freshAt: at.value }),
    }
    const rules = [...RULES, fresh]
    const d: StaffDecision = {
      ...releasedOn(baseFacts()),
      covers: [{ rule: "test.fresh", points: 40 }],
    }
    const facts = { ...baseFacts(), decisions: [d] }
    expect(evaluate(facts, rules).cleared.map((c) => c.rule)).toEqual(["test.fresh"])
    at.value = daysAgo(0.5)
    const e = evaluate(facts, rules)
    expect(e.cleared).toEqual([])
    expect(e.contributions.map((c) => c.rule)).toContain("test.fresh")
  })

  it("an upheld hold, and a staff hold, clear nothing", () => {
    const seen = phishing("a.example")
    for (const kind of ["uphold", "hold"] as const)
      expect(later(seen, [releasedOn(seen, { kind })]).band).toBe("critical")
  })

  it("expires: a cleared concern counts again after DECISION_MEMORY_DAYS", () => {
    const seen = phishing("a.example")
    const d = releasedOn(seen)
    const justBefore = new Date(d.expiresAt.getTime() - 1)
    expect(evaluate({ ...seen, now: justBefore, decisions: [d] }).band).not.toBe(
      "critical",
    )
    expect(evaluate({ ...seen, now: d.expiresAt, decisions: [d] }).band).toBe(
      "critical",
    )
  })

  it("stops clearing once revoked, and still cleared at a moment before the revocation", () => {
    const seen = phishing("a.example")
    const revoked = releasedOn(seen, { revokedAt: daysAgo(0.5) })
    expect(later(seen, [revoked]).band).toBe("critical")
    expect(
      evaluate({ ...seen, now: daysAgo(0.75), decisions: [revoked] }).cleared.map(
        (c) => c.rule,
      ),
    ).toEqual(["links.unsafe"])
  })

  it("clears only the subset staff named", () => {
    const seen = baseFacts({
      links: { unsafe: [link("a.example")] },
      farm: { peers: [peer(), peer()], trusted: NO_TRUST },
    })
    const all = evaluate(seen)
    expect(live(all)).toEqual(expect.arrayContaining(["links.unsafe", "farm.cluster"]))
    const d: StaffDecision = {
      ...releasedOn(seen),
      covers: concernsFor(all.contributions, ["farm.cluster"]),
    }
    const e = later(seen, [d])
    expect(cleared(e)).toEqual(["farm.cluster"])
    expect(live(e)).toContain("links.unsafe")
    expect(e.band).toBe("critical")
  })

  it("refuses to name a rule that is not a live concern", () => {
    expect(() =>
      concernsFor(evaluate(phishing("a.example")).contributions, ["no.such"]),
    ).toThrow(RangeError)
  })

  it("does not cover a rule that was not firing when the release happened", () => {
    const d = releasedOn(phishing("a.example"))
    const now = phishing("a.example")
    now.rates = {
      ...now.rates,
      day7: counts(1500, 3, 6),
    }
    const e = later(now, [d])
    expect(cleared(e)).toEqual(["links.unsafe"])
    expect(live(e)).toContain("complaint.7d")
  })

  it("still holds a workspace cleared for one reason for an unrelated new one", () => {
    const d = releasedOn(phishing("a.example"))
    const farm = phishing("a.example")
    farm.farm = {
      peers: [peer({ held: true }), peer(), peer(), peer()],
      trusted: NO_TRUST,
    }
    const e = later(farm, [d])
    expect(cleared(e)).toEqual(["links.unsafe"])
    expect(e.band).toBe("critical")
    const { actions } = decide({
      now: NOW,
      plan: "free",
      assessment: {
        score: e.score,
        band: e.band,
        contributions: e.contributions,
        rulesetVersion: e.rulesetVersion,
      },
      previous: null,
      tier: { tier: "normal", source: "default" },
      hold: null,
      switches: { tiers: true, holds: true, sesPolicy: true },
    })
    expect(actions.map((a) => a.kind)).toContain("hold")
  })

  it("keys farm peers by digest, so a new peer is new evidence and no id is stored", () => {
    const [a, b, c] = [peer(), peer(), peer()]
    const d = releasedOn(baseFacts({ farm: { peers: [a!, b!], trusted: NO_TRUST } }))
    expect(d.covers[0]!.keys).toEqual(
      [`peer:${digest(a!.peer)}`, `peer:${digest(b!.peer)}`].sort(),
    )
    expect(JSON.stringify(d.covers)).not.toContain(a!.peer)
    const more = later(
      baseFacts({ farm: { peers: [a!, b!, c!], trusted: NO_TRUST } }),
      [d],
    )
    expect(live(more)).toContain("farm.cluster")
  })

  it("keys identity rules by the people they matched", () => {
    const held = (keys: string[]) =>
      baseFacts({
        identity: {
          ...baseFacts().identity!,
          heldDevicePeers: keys.length,
          devicePeers: keys.length,
          devicePeerKeys: keys,
          heldPeerKeys: keys,
        },
      })
    const d = releasedOn(held(["user:aaaa"]))
    expect(cleared(later(held(["user:aaaa"]), [d]))).toEqual(
      expect.arrayContaining(["identity.ban_evasion"]),
    )
    // The same count, a different person: new evidence.
    expect(live(later(held(["user:bbbb"]), [d]))).toContain("identity.ban_evasion")
  })

  it("never clears earned trust", () => {
    const seen = baseFacts({ owner: { ...baseFacts().owner, mfa: true } })
    const trust = evaluate(seen).contributions.find((c) => c.rule === "trust.mfa")!
    const d: StaffDecision = {
      ...releasedOn(seen),
      covers: [{ rule: "trust.mfa", points: trust.points }],
    }
    expect(concernsFor([trust])).toEqual([])
    expect(live(later(seen, [d]))).toContain("trust.mfa")
  })

  it("leaves every scenario's band alone when there are no decisions", () => {
    for (const f of Object.values(LEGIT))
      expect(evaluate({ ...f(), decisions: [] }).band).toBe("low")
    for (const { facts } of Object.values(ABUSE)) {
      const f = facts()
      expect(evaluate({ ...f, decisions: [] })).toEqual(evaluate(f))
    }
  })
})

describe("decision memory: cleared contributions move nothing", () => {
  it("a cleared critical-floor contribution moves no score, band or action", () => {
    const seen = phishing("a.example")
    const e = later(seen, [releasedOn(seen)])
    const baseline = evaluate(baseFacts())
    expect({ score: e.score, band: e.band, contributions: e.contributions }).toEqual({
      score: baseline.score,
      band: baseline.band,
      contributions: baseline.contributions,
    })
    const input = {
      now: NOW,
      plan: "free" as const,
      previous: null,
      tier: { tier: "normal" as const, source: "default" as const },
      hold: null,
      switches: { tiers: true, holds: true, sesPolicy: true },
    }
    // Even handed the whole evaluation, cleared field and all, decide acts as on the baseline.
    expect(decide({ ...input, assessment: e }).actions).toEqual(
      decide({ ...input, assessment: baseline }).actions,
    )
  })

  it("is not a contribution to the type checker", () => {
    const c: ClearedContribution = {
      rule: "links.unsafe",
      category: "unsafe_links",
      wouldAdd: 90,
      evidence: {},
      clearedBy: "d",
      decidedAt: NOW.toISOString(),
      expiresAt: NOW.toISOString(),
    }
    // @ts-expect-error a cleared contribution has no points or floor
    const asLive: Contribution = c
    expect(asLive).toBeDefined()
  })
})

describe("decision memory: replay", () => {
  it("reproduces cleared contributions from a snapshot's facts alone", () => {
    const seen = phishing("a.example")
    const facts = { ...seen, decisions: [releasedOn(seen)] }
    const e = evaluate(facts)
    const snapshot: FactSnapshot = {
      id: "00000000-0000-7000-8000-000000000001",
      tenantId: facts.tenantId,
      takenAt: facts.now,
      rulesetVersion: e.rulesetVersion,
      trigger: "staff:release",
      score: e.score,
      band: e.band,
      contributions: JSON.parse(JSON.stringify(e.contributions)) as Contribution[],
      shadow: [],
      cleared: JSON.parse(JSON.stringify(e.cleared)) as ClearedContribution[],
      facts: JSON.parse(JSON.stringify(serialiseFacts(facts))) as unknown,
    }
    const r = replaySnapshot(snapshot, RULES)
    expect(r.cleared).toEqual(["links.unsafe"])
    expect(r.replayed).toEqual(r.stored)
    expect(r.differs).toEqual([])
    // The same facts stored as live (no decision then) differ as cleared now.
    expect(
      replaySnapshot(
        { ...snapshot, cleared: [], contributions: evaluate(seen).contributions },
        RULES,
      ).differs,
    ).toEqual(["links.unsafe"])
  })

  it("replays a snapshot taken before decision memory as having no decisions", () => {
    const seen = phishing("a.example")
    const json = JSON.parse(JSON.stringify(serialiseFacts(seen))) as Record<
      string,
      unknown
    >
    delete json.decisions
    const e = evaluate(seen)
    const r = replaySnapshot(
      {
        id: "00000000-0000-7000-8000-000000000002",
        tenantId: seen.tenantId,
        takenAt: seen.now,
        rulesetVersion: 5,
        trigger: "hourly",
        score: e.score,
        band: e.band,
        contributions: e.contributions,
        shadow: [],
        cleared: [],
        facts: json,
      },
      RULES,
    )
    expect(r.replayed.band).toBe("critical")
    expect(r.failed).toEqual([])
  })
})

describe("decision cases", () => {
  const stored = (over: Partial<StoredDecision>): StoredDecision => ({
    id: "d",
    tenantId: "t",
    kind: "release",
    decidedBy: "mo",
    note: "n",
    decidedAt: NOW,
    score: 0,
    band: "low",
    rulesetVersion: 6,
    held: false,
    inView: [],
    covers: [],
    expiresAt: NOW,
    snapshotId: "s",
    revokedAt: null,
    revokedBy: null,
    revokeNote: null,
    ...over,
  })

  it("marks where staff and the engine disagree", () => {
    expect(disagrees(stored({ kind: "release", held: true, band: "critical" }))).toBe(
      true,
    )
    expect(disagrees(stored({ kind: "pin", band: "high" }))).toBe(true)
    expect(disagrees(stored({ kind: "pin", band: "elevated" }))).toBe(false)
    expect(disagrees(stored({ kind: "uphold", band: "low" }))).toBe(true)
    expect(disagrees(stored({ kind: "hold", band: "low" }))).toBe(true)
    expect(disagrees(stored({ kind: "uphold", band: "critical", held: true }))).toBe(
      false,
    )
  })

  it("puts disagreements first, then the newest", () => {
    const cases = decisionCases([
      stored({ id: "agree-new", kind: "uphold", band: "critical", decidedAt: NOW }),
      stored({
        id: "disagree-old",
        held: true,
        band: "critical",
        decidedAt: daysAgo(9),
      }),
      stored({ id: "disagree-new", kind: "hold", band: "low", decidedAt: daysAgo(1) }),
      stored({ id: "agree-old", kind: "uphold", band: "high", decidedAt: daysAgo(20) }),
    ])
    expect(cases.map((c) => c.decision)).toEqual([
      "disagree-new",
      "disagree-old",
      "agree-new",
      "agree-old",
    ])
    expect(cases[0]).toEqual({
      decision: "disagree-new",
      tenantId: "t",
      snapshotId: "s",
      decidedAt: daysAgo(1).toISOString(),
      engine: { score: 0, band: "low", held: false, rulesetVersion: 6 },
      staff: { kind: "hold", by: "mo", note: "n" },
      disagree: true,
      revoked: false,
    })
  })
})
