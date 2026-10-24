import { describe, expect, it } from "bun:test"
import { DAY_MS, latestPass, wouldDo } from "./sso-runs"
import type { TestRun } from "./sso-types"

const run = (over: Partial<TestRun>): TestRun => ({
  id: "r",
  connectionId: "c",
  outcome: "passed",
  reason: null,
  claims: {},
  resolution: {},
  createdAt: "2026-10-24T12:00:00.000Z",
  ...over,
})

describe("what a test run says we would do", () => {
  it("names the refusal and its reason first", () => {
    const said = wouldDo(
      run({ outcome: "failed", resolution: { refused: "email_unverified" } }),
    )
    expect(said).toContain("refuse")
    expect(said).toContain("did not vouch")
  })

  it("does not invent a reason for one it does not know", () => {
    expect(wouldDo(run({ resolution: { refused: "something_new" } }))).toContain(
      "not accepted",
    )
  })

  it("warns when a new account would lack a name", () => {
    const said = wouldDo(
      run({
        resolution: {
          path: "jit",
          wouldCreate: true,
          email: "a@acme.test",
          role: "member",
          names: { given: true, family: false },
        },
      }),
    )
    expect(said).toContain("create an account for a@acme.test")
    expect(said).toContain("needs both")
  })

  it("says which existing account would be used", () => {
    expect(
      wouldDo(
        run({ resolution: { path: "claimed", email: "a@acme.test", role: "admin" } }),
      ),
    ).toContain("linking it")
  })
})

describe("a passed run counts for a day", () => {
  const now = new Date("2026-10-24T18:00:00.000Z").getTime()
  it("ignores a failed run and one older than 24 hours", () => {
    expect(latestPass([run({ outcome: "failed" })], now)).toBeNull()
    expect(
      latestPass([run({ createdAt: new Date(now - DAY_MS - 1).toISOString() })], now),
    ).toBeNull()
  })
  it("finds the newest within the day", () => {
    const fresh = run({
      id: "fresh",
      createdAt: new Date(now - 3600_000).toISOString(),
    })
    expect(latestPass([fresh], now)?.id).toBe("fresh")
  })
})
