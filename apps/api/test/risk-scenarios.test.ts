import { describe, expect, it } from "bun:test"
import { bandFor, evaluate, leadingCategory } from "../src/risk/engine.js"
import {
  looksRandomLabel,
  registrable,
  RULES,
  RULESET_VERSION,
  subdomainOf,
  timezoneGapHours,
} from "../src/risk/rules.js"
import { bandRank, CATEGORY_TEXT } from "../src/risk/types.js"
import {
  ABUSE,
  baseFacts,
  counts,
  daysAgo,
  identity,
  LEGIT,
  NO_TRUST,
  NOW,
  peer,
} from "./risk-fixtures.js"

/**
 * The risk engine's rules against the synthetic scenarios (#170).
 *
 * ⚠ THIS FILE IS THE BAR A RULE CHANGE HAS TO CLEAR. Every abuse scenario must
 * reach its band; every legitimate one must stay LOW. A rule tuned to catch
 * one more farm that starts holding a legitimate launch day fails here, which
 * is where it should fail - not in a customer's inbox.
 */
describe("the synthetic scenarios", () => {
  for (const [name, facts] of Object.entries(LEGIT)) {
    it(`leaves alone: ${name}`, () => {
      const a = evaluate(facts())
      expect(a.band).toBe("low")
    })
  }
  for (const [name, { facts, atLeast }] of Object.entries(ABUSE)) {
    it(`catches: ${name} (at least ${atLeast})`, () => {
      const a = evaluate(facts())
      expect(bandRank(a.band)).toBeGreaterThanOrEqual(bandRank(atLeast))
    })
  }
})

/** Built from its code point, so this file never contains the character it bans. */
const EM_DASH = String.fromCharCode(0x2014)

describe("the ruleset", () => {
  it("has unique ids, a summary and a customer sentence for each rule", () => {
    const ids = RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of RULES) {
      expect(r.summary.length).toBeGreaterThan(10)
      expect(CATEGORY_TEXT[r.category]).toBeTruthy()
    }
  })

  it("is versioned", () => {
    expect(Number.isInteger(RULESET_VERSION)).toBe(true)
    expect(evaluate(baseFacts()).rulesetVersion).toBe(RULESET_VERSION)
  })

  it("never writes an em dash into anything a customer or staff member reads", () => {
    for (const r of RULES) expect(r.summary.includes(EM_DASH)).toBe(false)
    for (const t of Object.values(CATEGORY_TEXT))
      expect(t.includes(EM_DASH)).toBe(false)
  })

  it("is pure: the same facts give the same assessment", () => {
    const f =
      ABUSE["a farm: five linked free workspaces sending the same mail"]!.facts()
    expect(evaluate(f)).toEqual(evaluate(f))
  })

  it("keeps scoring when one rule throws", () => {
    const broken = [
      {
        id: "x",
        category: "trust" as const,
        summary: "a rule that breaks",
        evaluate: () => {
          throw new Error("boom")
        },
      },
      ...RULES,
    ]
    const a = evaluate(ABUSE["phishing: a link Web Risk lists"]!.facts(), broken)
    expect(a.band).toBe("critical")
  })
})

describe("scores and bands", () => {
  it("maps scores to bands at 30, 60 and 85", () => {
    expect(bandFor(0)).toBe("low")
    expect(bandFor(29)).toBe("low")
    expect(bandFor(30)).toBe("elevated")
    expect(bandFor(59)).toBe("elevated")
    expect(bandFor(60)).toBe("high")
    expect(bandFor(85)).toBe("critical")
    expect(bandFor(100)).toBe("critical")
  })

  it("clamps the score to 0-100 and never goes negative on trust", () => {
    const trusted = baseFacts({
      plan: "paid",
      paidSince: daysAgo(400),
      createdAt: daysAgo(500),
      rates: {
        day1: counts(1000),
        day7: counts(7000),
        early: { sends: 500, hardBounces: 0 },
        unsubscribes7d: 0,
        trailingDaily: [1000, 1000, 1000, 1000, 1000, 1000],
      },
      owner: { clerkUserId: "u", mfa: true, emailOnOwnDomain: true, workspaces: 1 },
    })
    expect(evaluate(trusted).score).toBe(0)
    const worst = baseFacts({
      ses: {
        current: "disabled",
        currentOrigin: "aws_managed",
        changedAt: NOW,
        pauses: [{ origin: "aws_managed", at: NOW }],
        findings: [
          { type: "complaint", impact: "high", openedAt: NOW, resolvedAt: null },
        ],
      },
      links: {
        unsafe: [{ host: "evil.example", verdict: "MALWARE", day: "2026-09-28" }],
      },
      farm: {
        peers: [peer(), peer(), peer(), peer(), peer({ held: true })],
        trusted: NO_TRUST,
      },
    })
    expect(evaluate(worst).score).toBe(100)
  })

  it("lets a floor lift the band above the points", () => {
    const f = baseFacts({
      links: { unsafe: [{ host: "x.example", verdict: "MALWARE", day: "2026-09-28" }] },
      owner: { clerkUserId: "u", mfa: true, emailOnOwnDomain: true, workspaces: 1 },
    })
    const a = evaluate(f)
    expect(a.band).toBe("critical")
  })

  it("explains itself: contributions are sorted worst first and carry evidence", () => {
    const a = evaluate(ABUSE["a bought list: first sends bounce hard"]!.facts())
    for (let i = 1; i < a.contributions.length; i++) {
      expect(a.contributions[i - 1]!.points).toBeGreaterThanOrEqual(
        a.contributions[i]!.points,
      )
    }
    expect(a.contributions.every((c) => typeof c.evidence === "object")).toBe(true)
    expect(leadingCategory(a)).toBe("bounces")
  })
})

describe("minimum volumes", () => {
  it("says nothing about a rate with too little mail behind it", () => {
    const a = evaluate(
      baseFacts({
        rates: {
          day1: counts(10, 5, 2),
          day7: counts(40, 10, 2),
          early: { sends: 40, hardBounces: 10 },
          unsubscribes7d: 20,
          trailingDaily: [0, 0, 0, 0, 0, 0],
        },
      }),
    )
    const ids = a.contributions.map((c) => c.rule)
    expect(ids).not.toContain("bounce.hard.7d")
    expect(ids).not.toContain("complaint.7d")
    expect(ids).not.toContain("list.early_bounce")
    expect(ids).not.toContain("unsubscribe.7d")
  })

  it("needs two complaints before 0.1% counts", () => {
    const one = evaluate(
      baseFacts({
        rates: {
          day1: counts(50),
          day7: counts(900, 0, 1),
          early: { sends: 500, hardBounces: 0 },
          unsubscribes7d: 0,
          trailingDaily: [120, 120, 120, 120, 120, 120],
        },
      }),
    )
    expect(one.contributions.map((c) => c.rule)).not.toContain("complaint.7d")
  })
})

describe("farm detection needs corroboration", () => {
  it("does not treat shared content alone as a farm", () => {
    const loose = peer({
      createdNear: false,
      ownerSubnet: false,
      ownerCountry: false,
      young: false,
      free: false,
    })
    const a = evaluate(
      baseFacts({
        farm: { peers: [loose, { ...loose }, { ...loose }], trusted: NO_TRUST },
      }),
    )
    expect(a.contributions.map((c) => c.rule)).not.toContain("farm.cluster")
    expect(a.band).toBe("low")
  })

  it("flags four or more linked peers at high at least", () => {
    const a = evaluate(
      baseFacts({
        farm: { peers: [peer(), peer(), peer(), peer()], trusted: NO_TRUST },
      }),
    )
    expect(bandRank(a.band)).toBeGreaterThanOrEqual(bandRank("high"))
  })
})

describe("helpers", () => {
  it("spots machine-made subdomain labels and leaves words alone", () => {
    expect(looksRandomLabel("x7kq2vd9p3")).toBe(true)
    expect(looksRandomLabel("bcdfghjklmnp")).toBe(true)
    expect(looksRandomLabel("mail")).toBe(false)
    expect(looksRandomLabel("newsletter")).toBe(false)
    expect(looksRandomLabel("notifications")).toBe(false)
  })

  it("finds the registrable parent, including multi-part suffixes", () => {
    expect(registrable("a.b.example.co.uk")).toBe("example.co.uk")
    expect(registrable("send.acme.com")).toBe("acme.com")
    expect(subdomainOf("x7.mailer.acme.com")).toBe("x7.mailer")
    expect(subdomainOf("acme.com")).toBeNull()
  })

  it("measures how far a timezone is from a country", () => {
    expect(timezoneGapHours("Europe/Berlin", "DE", NOW)).toBeLessThanOrEqual(2)
    expect(timezoneGapHours("Asia/Tokyo", "BR", NOW)).toBeGreaterThanOrEqual(6)
    expect(timezoneGapHours("Not/AZone", "DE", NOW)).toBeNull()
  })

  it("flags a timezone on the far side of the world, weakly", () => {
    const a = evaluate(
      baseFacts({
        identity: identity({ latestTimezone: "Asia/Tokyo", latestCountry: "BR" }),
      }),
    )
    const c = a.contributions.find((x) => x.rule === "identity.timezone_mismatch")
    expect(c?.points).toBe(3)
  })
})

describe("ruleset 2: velocity, similarity, behaviour and templates", () => {
  const actor = (
    over: Partial<NonNullable<ReturnType<typeof baseFacts>["actor"]>> = {},
  ) => ({
    linkedPeople: 1,
    workspaces24h: 1,
    workspaces7d: 1,
    linkedWorkspaces: 1,
    linkedTainted: 0,
    domains24h: 0,
    keys24h: 0,
    ...over,
  })
  const sim = (
    over: Partial<NonNullable<ReturnType<typeof baseFacts>["similarity"]>> = {},
  ) => ({
    model: "minilm-l6-v2-q8",
    similarPeers: 0,
    youngFreeSimilar: 0,
    taintedSimilar: 0,
    bestTaintedSimilarity: null,
    neighbours: 0,
    medianSimilarity: null,
    bestSimilarity: null,
    trusted: NO_TRUST,
    boilerplateNear: null,
    ...over,
  })

  it("catches an actor minting workspaces: six in a day across one device", () => {
    const a = evaluate(
      baseFacts({
        actor: actor({ linkedPeople: 5, workspaces24h: 6, domains24h: 12 }),
      }),
    )
    expect(a.contributions.map((c) => c.rule)).toEqual(
      expect.arrayContaining(["actor.velocity", "actor.domain_velocity"]),
    )
    expect(bandRank(a.band)).toBeGreaterThanOrEqual(bandRank("elevated"))
  })

  it("leaves one person making two workspaces alone", () => {
    expect(evaluate(baseFacts({ actor: actor({ workspaces24h: 2 }) })).band).toBe("low")
  })

  it("treats mail like a confirmed abuser's as evidence, not a verdict", () => {
    const one = evaluate(
      baseFacts({
        similarity: sim({ taintedSimilar: 1, bestTaintedSimilarity: 0.91 }),
      }),
    )
    expect(
      one.contributions.find((c) => c.rule === "content.like_confirmed_abuse")?.points,
    ).toBe(20)
    expect(one.band).toBe("low")
    const withFarm = evaluate(
      baseFacts({
        similarity: sim({ taintedSimilar: 2, bestTaintedSimilarity: 0.95 }),
        farm: { peers: [peer(), peer()], trusted: NO_TRUST },
      }),
    )
    expect(bandRank(withFarm.band)).toBeGreaterThanOrEqual(bandRank("elevated"))
  })

  it("never holds anybody on similarity alone", () => {
    const a = evaluate(
      baseFacts({
        similarity: sim({
          taintedSimilar: 5,
          youngFreeSimilar: 9,
          bestTaintedSimilarity: 0.99,
        }),
        behaviour: {
          labelled: 10,
          abuse: 10,
          legit: 0,
          meanAbuseDistance: 0.1,
          nearestDistance: 0.1,
          medianDistance: 0.1,
        },
      }),
    )
    expect(a.band).not.toBe("critical")
  })

  it("needs five labelled neighbours before behaviour speaks", () => {
    const few = evaluate(
      baseFacts({
        behaviour: {
          labelled: 3,
          abuse: 3,
          legit: 0,
          meanAbuseDistance: 0.2,
          nearestDistance: 0.2,
          medianDistance: 0.2,
        },
      }),
    )
    expect(few.contributions.map((c) => c.rule)).not.toContain("behaviour.like_abuse")
    const many = evaluate(
      baseFacts({
        behaviour: {
          labelled: 10,
          abuse: 8,
          legit: 2,
          meanAbuseDistance: 0.3,
          nearestDistance: 0.2,
          medianDistance: 0.2,
        },
      }),
    )
    expect(
      many.contributions.find((c) => c.rule === "behaviour.like_abuse")?.points,
    ).toBe(20)
  })

  it("earns trust for mail that fits the workspace's own established templates", () => {
    const a = evaluate(
      baseFacts({ templates: { established: 2, recentMatchedShare: 0.9 } }),
    )
    expect(
      a.contributions.find((c) => c.rule === "trust.known_templates")?.points,
    ).toBe(-5)
    const b = evaluate(
      baseFacts({ templates: { established: 2, recentMatchedShare: 0.4 } }),
    )
    expect(b.contributions.map((c) => c.rule)).not.toContain("trust.known_templates")
  })

  it("is ruleset version 3 (#222: trusted content left out of similarity)", () => {
    expect(RULESET_VERSION).toBe(3)
  })
})

describe("similarity evidence (#222)", () => {
  const sim = (
    over: Partial<NonNullable<ReturnType<typeof baseFacts>["similarity"]>> = {},
  ): NonNullable<ReturnType<typeof baseFacts>["similarity"]> => ({
    model: "minilm-l6-v2-q8",
    similarPeers: 8,
    youngFreeSimilar: 6,
    taintedSimilar: 5,
    bestTaintedSimilarity: 0.95,
    neighbours: 17,
    medianSimilarity: 0.912,
    bestSimilarity: 0.974,
    trusted: { template: 2, boilerplate: 1 },
    boilerplateNear: { name: "clerk/reset-password", similarity: 0.881 },
    ...over,
  })

  it("records what a content finding was based on, in the issue's shape", () => {
    const a = evaluate(baseFacts({ similarity: sim() }))
    const crowd = a.contributions.find((c) => c.rule === "content.semantic_crowd")
    expect(crowd?.detail).toEqual({
      signal: "content.semantic_crowd",
      model: "minilm-l6-v2-q8",
      neighbours: 17,
      distinct_workspaces: 8,
      median_similarity: 0.91,
      best_similarity: 0.97,
      confirmed_abuse_neighbours: 5,
      known_template_matches: 2,
      boilerplate_matches: 1,
      boilerplate_match: { name: "clerk/reset-password", similarity: 0.88 },
    })
    expect(
      a.contributions.find((c) => c.rule === "content.like_confirmed_abuse")?.detail
        ?.signal,
    ).toBe("content.like_confirmed_abuse")
  })

  it("records farm evidence as counts and closeness, never a peer's id", () => {
    const peers = [
      peer({ exactShared: 2, nearShared: 0, bestSimilarity: 1 }),
      peer({ nearShared: 3, bestSimilarity: 0.5 }),
      peer({ nearShared: 1, bestSimilarity: 0.25, held: true }),
      peer({ nearShared: 1, bestSimilarity: 0.75 }),
    ]
    const a = evaluate(
      baseFacts({ farm: { peers, trusted: { template: 0, boilerplate: 3 } } }),
    )
    const cluster = a.contributions.find((c) => c.rule === "farm.cluster")!
    expect(cluster.detail).toMatchObject({
      model: "minhash-8x4",
      neighbours: 7,
      distinct_workspaces: 4,
      median_similarity: 0.63,
      best_similarity: 1,
      confirmed_abuse_neighbours: 1,
      boilerplate_matches: 3,
    })
    const text = JSON.stringify(a.contributions)
    for (const p of peers) expect(text).not.toContain(p.peer)
  })

  it("records behaviour evidence as distances", () => {
    const a = evaluate(
      baseFacts({
        behaviour: {
          labelled: 10,
          abuse: 8,
          legit: 2,
          meanAbuseDistance: 0.3,
          nearestDistance: 0.21,
          medianDistance: 0.456,
        },
      }),
    )
    expect(
      a.contributions.find((c) => c.rule === "behaviour.like_abuse")?.detail,
    ).toMatchObject({
      model: "behaviour-v1",
      neighbours: 10,
      confirmed_abuse_neighbours: 8,
      median_distance: 0.46,
      nearest_distance: 0.21,
    })
  })

  it("leaves rules that are not about similarity without it", () => {
    const a = evaluate(
      ABUSE["a farm: five linked free workspaces sending the same mail"]!.facts(),
    )
    for (const c of a.contributions) {
      if (!c.rule.startsWith("farm.") && !c.rule.startsWith("content.like"))
        expect(c.detail).toBeUndefined()
    }
  })
})
