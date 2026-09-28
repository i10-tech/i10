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
      farm: { peers: [peer(), peer(), peer(), peer(), peer({ held: true })] },
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
      baseFacts({ farm: { peers: [loose, { ...loose }, { ...loose }] } }),
    )
    expect(a.contributions.map((c) => c.rule)).not.toContain("farm.cluster")
    expect(a.band).toBe("low")
  })

  it("flags four or more linked peers at high at least", () => {
    const a = evaluate(baseFacts({ farm: { peers: [peer(), peer(), peer(), peer()] } }))
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
