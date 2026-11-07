import { describe, expect, it } from "bun:test"
import { healthLabel } from "../lib/connection-health"
import type { ConnectionHealth } from "../lib/sso-types"

const base: ConnectionHealth = {
  lastSuccessAt: "2026-10-30T10:00:00.000Z",
  failuresLastHour: 0,
  failuresLast24Hours: 0,
  failing: false,
  reason: null,
}

describe("a connection's health label", () => {
  it("shows nothing when the API could not read it", () => {
    expect(healthLabel(null, "active")).toBeNull()
    expect(healthLabel(undefined, "active")).toBeNull()
  })

  it("shows nothing for a connection that is not live", () => {
    for (const status of ["draft", "testing", "disabled"] as const)
      expect(healthLabel(base, status)).toBeNull()
  })

  it("is healthy with nothing wrong", () => {
    expect(healthLabel(base, "active")?.state).toBe("healthy")
  })

  it("says so when nobody has signed in yet", () => {
    expect(healthLabel({ ...base, lastSuccessAt: null }, "active")?.reason).toBe(
      "No sign-ins yet.",
    )
  })

  it("is degraded with failures in the last hour but no spike", () => {
    const label = healthLabel({ ...base, failuresLastHour: 1 }, "active")
    expect(label?.state).toBe("degraded")
    expect(label?.reason).toBe("1 sign-in failed in the last hour.")
  })

  it("is failing, with the reason, when the API says so", () => {
    expect(
      healthLabel({ ...base, failing: true, reason: "failure_spike" }, "active")
        ?.reason,
    ).toContain("much more than usual")
    expect(
      healthLabel({ ...base, failing: true, reason: "no_success" }, "active")?.reason,
    ).toContain("for a day")
  })
})
