import { describe, expect, it } from "bun:test"
import {
  featureLabel,
  planRequiredOf,
  remoteFailure,
  upgradeSentence,
} from "../lib/plan-required"

describe("the plan_required refusal", () => {
  it("is recognised by name and carries the feature", () => {
    expect(
      planRequiredOf({ name: "plan_required", body: { feature: "siem_export" } }),
    ).toEqual({ feature: "siem_export" })
  })

  it("is still the refusal when the body names no feature", () => {
    expect(planRequiredOf({ name: "plan_required" })).toEqual({ feature: null })
    expect(planRequiredOf({ name: "plan_required", body: { feature: 3 } })).toEqual({
      feature: null,
    })
  })

  it("is not any other refusal", () => {
    expect(planRequiredOf({ name: "forbidden", body: { feature: "scim" } })).toBeNull()
  })

  it("makes a remote failure the screen can branch on", () => {
    const failure = remoteFailure({
      error: "Your plan does not include this feature.",
      name: "plan_required",
      body: { feature: "ip_allowlist" },
    })
    expect(failure.upgrade).toEqual({ feature: "ip_allowlist" })
    expect(remoteFailure({ error: "Nope", name: "forbidden" }).upgrade).toBeNull()
  })

  it("names features for people, and only the ones it knows", () => {
    expect(featureLabel("siem_export")).toBe("SIEM export")
    expect(featureLabel("something_new")).toBeNull()
    expect(upgradeSentence("siem_export")).toBe(
      "SIEM export is not included in your plan.",
    )
    expect(upgradeSentence(null)).toBe("This is not included in your plan.")
  })
})
