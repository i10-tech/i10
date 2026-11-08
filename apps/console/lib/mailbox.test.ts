import { describe, expect, it } from "bun:test"
import { daysInRange, deletionDate, nextSummary, resumeNote } from "./mailbox"

describe("the date a deletion lands on", () => {
  it("is the chosen number of days from now", () => {
    const from = new Date("2026-10-28T10:00:00.000Z")
    expect(deletionDate(30, from).toISOString()).toBe("2026-11-27T10:00:00.000Z")
    expect(deletionDate(7, from).toISOString()).toBe("2026-11-04T10:00:00.000Z")
  })

  it("does not move the date it was given", () => {
    const from = new Date("2026-10-28T10:00:00.000Z")
    deletionDate(30, from)
    expect(from.toISOString()).toBe("2026-10-28T10:00:00.000Z")
  })
})

describe("days against the API's bounds", () => {
  const limits = { minDays: 7, maxDays: 365 }
  it("accepts the ends and nothing past them", () => {
    expect(daysInRange(7, limits)).toBe(true)
    expect(daysInRange(365, limits)).toBe(true)
    expect(daysInRange(6, limits)).toBe(false)
    expect(daysInRange(366, limits)).toBe(false)
  })
  it("wants a whole number", () => {
    expect(daysInRange(7.5, limits)).toBe(false)
    expect(daysInRange(Number.NaN, limits)).toBe(false)
  })
})

describe("one line on a suspended mailbox", () => {
  const name = (id: string) => `Person ${id}`
  it("names the delegate", () => {
    expect(
      nextSummary(
        { next: "delegate", deleteAfterDays: null, targetUserId: "u1" },
        name,
      ),
    ).toBe("Open to Person u1.")
  })
  it("says how long until a deletion", () => {
    expect(
      nextSummary({ next: "delete", deleteAfterDays: 30, targetUserId: null }, name),
    ).toContain("30 days")
  })
  it("does not fail on a delete with no days or a delegate with no target", () => {
    expect(
      nextSummary({ next: "delete", deleteAfterDays: null, targetUserId: null }, name),
    ).toBe("To be deleted.")
    expect(
      nextSummary(
        { next: "delegate", deleteAfterDays: null, targetUserId: null },
        name,
      ),
    ).toBe("Open to a delegate.")
  })
})

describe("what an owner is told after resuming a mailbox", () => {
  it("says the person can sign in when nothing else refuses them", () => {
    expect(resumeNote("ada@acme.dev", [])).toBe("ada@acme.dev can sign in again.")
  })
  it("says what a resume did not lift, so nobody has to find out from the person", () => {
    expect(resumeNote("ada@acme.dev", ["payment_hold"])).toBe(
      "ada@acme.dev is resumed, but it cannot sign in yet: the workspace's plan is unpaid.",
    )
    expect(resumeNote("ada@acme.dev", ["banned", "locked"])).toBe(
      "ada@acme.dev is resumed, but it cannot sign in yet: the account is banned and the account is locked.",
    )
  })
  it("lists three reasons with commas and a last and", () => {
    expect(resumeNote("a@b.dev", ["payment_hold", "banned", "locked"])).toContain(
      "unpaid, the account is banned and the account is locked.",
    )
  })
})
