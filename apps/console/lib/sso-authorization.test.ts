import { describe, expect, test } from "bun:test"
import {
  connectionWriteNeedsStepUp,
  SCIM_SESSION_LIMIT_NOTE,
  scimSessionLimitNote,
} from "./sso-authorization"

const connection = (status: "draft" | "testing" | "active" | "disabled") => ({
  status,
  enforcement: "off" as const,
})

describe("connection step-up policy", () => {
  test("allows setup writes on draft and testing connections", () => {
    expect(connectionWriteNeedsStepUp(connection("draft"))).toBe(false)
    expect(connectionWriteNeedsStepUp(connection("testing"))).toBe(false)
  })

  test("protects active and disabled connections", () => {
    expect(connectionWriteNeedsStepUp(connection("active"))).toBe(true)
    expect(connectionWriteNeedsStepUp(connection("disabled"))).toBe(true)
  })

  test("protects activation and required enforcement", () => {
    expect(connectionWriteNeedsStepUp(connection("draft"), { status: "active" })).toBe(
      true,
    )
    expect(
      connectionWriteNeedsStepUp(connection("testing"), {
        enforcement: "required_domain",
      }),
    ).toBe(true)
  })
})

describe("SCIM session note", () => {
  test("only shows when directory state proves no enabled directory", () => {
    expect(scimSessionLimitNote("none")).toBe(SCIM_SESSION_LIMIT_NOTE)
    expect(scimSessionLimitNote("enabled")).toBeNull()
    expect(scimSessionLimitNote(null)).toBeNull()
    expect(scimSessionLimitNote(undefined)).toBeNull()
  })
})
