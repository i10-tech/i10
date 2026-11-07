import { describe, expect, it } from "bun:test"
import { gateRefusal, sessionEndedCopy } from "./identity-gate"

describe("reading a gate refusal off an API error", () => {
  it("knows the network and second-factor refusals", () => {
    expect(gateRefusal({ name: "ip_not_allowed" })).toEqual({ kind: "ip_not_allowed" })
    expect(gateRefusal({ name: "mfa_required" })).toEqual({ kind: "mfa_required" })
  })

  it("carries the reason a session ended", () => {
    expect(gateRefusal({ name: "session_expired", reason: "idle" })).toEqual({
      kind: "session_expired",
      reason: "idle",
    })
    expect(gateRefusal({ name: "session_expired", reason: "max_age" })).toEqual({
      kind: "session_expired",
      reason: "max_age",
    })
  })

  it("treats a missing or unknown reason as an ended session", () => {
    expect(gateRefusal({ name: "session_expired" })).toEqual({
      kind: "session_expired",
      reason: "revoked",
    })
    expect(gateRefusal({ name: "session_expired", reason: "later" })).toEqual({
      kind: "session_expired",
      reason: "revoked",
    })
  })

  it("leaves every other failure alone, including the SSO gates", () => {
    expect(gateRefusal({ name: "passkey_required" })).toBeNull()
    expect(gateRefusal({ name: "sso_required" })).toBeNull()
    expect(gateRefusal({ name: "internal_server_error" })).toBeNull()
  })
})

describe("saying why a session ended", () => {
  it("has different words for each reason", () => {
    const bodies = new Set(
      (["idle", "max_age", "revoked"] as const).map((r) => sessionEndedCopy(r).body),
    )
    expect(bodies.size).toBe(3)
  })

  it("never uses an em dash", () => {
    for (const reason of ["idle", "max_age", "revoked"] as const) {
      const { title, body } = sessionEndedCopy(reason)
      expect(title + body).not.toContain(String.fromCharCode(0x2014))
    }
  })
})
