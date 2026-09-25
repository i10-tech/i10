import { beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * ⚠ THESE PIN WHICH CALL THE WATCH MAKES, BECAUSE THAT WAS THE BUG. It used to
 * poll `refresh` only — and `refresh` writes nothing for a domain with no SES
 * identity. So a domain whose one verify after publishing arrived before DNS was
 * serving was polled seven times by a call that could never change it, and sat
 * at `not_started` until somebody pressed Verify by hand.
 */

const calls: string[] = []
let answers: Record<"verify" | "refresh", string[]>

const reply = (kind: "verify" | "refresh") => {
  calls.push(kind)
  const status = answers[kind].shift() ?? "pending"
  return Promise.resolve({ ok: true, data: { id: "dom_1", status } })
}

mock.module("@/lib/actions", () => ({
  verifyDomain: () => reply("verify"),
  refreshDomain: () => reply("refresh"),
  publishDnsRecords: () => Promise.resolve({ ok: true, data: { created: [] } }),
}))

const { watchUntilVerified } = await import("@/lib/domain-activation")

const fast = [0, 0, 0, 0]

beforeEach(() => {
  calls.length = 0
  answers = { verify: [], refresh: [] }
})

describe("watching a domain after its records are published", () => {
  // The reported bug: records up, first verify missed, nobody pressed anything.
  it("re-proves a domain that has no identity yet, until it has one", async () => {
    answers.verify = ["not_started", "not_started", "pending"]
    answers.refresh = ["verified"]

    const result = await watchUntilVerified({ domainId: "dom_1", schedule: fast })

    expect(calls).toEqual(["verify", "verify", "verify", "refresh"])
    expect(result.verified).toBe(true)
  })

  // ⚠ AND IT STOPS RE-PROVING ONCE AMAZON HAS THE IDENTITY. From there the
  // only thing outstanding is Amazon's own check, which `refresh` reads — a
  // proof per tick would be DNS lookups against the customer's nameservers for
  // an answer we already have.
  it("switches to refresh as soon as the identity exists", async () => {
    answers.verify = ["pending"]
    answers.refresh = ["pending", "pending", "verified"]

    await watchUntilVerified({ domainId: "dom_1", schedule: fast })

    expect(calls).toEqual(["verify", "refresh", "refresh", "refresh"])
  })

  it("stops as soon as the domain is verified", async () => {
    answers.verify = ["verified"]

    const result = await watchUntilVerified({ domainId: "dom_1", schedule: fast })

    expect(calls).toEqual(["verify"])
    expect(result.verified).toBe(true)
  })
})
