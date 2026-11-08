import { describe, expect, it } from "bun:test"
import {
  DEFAULT_GOOGLE_SCOPES,
  describeGoogleError,
  isGoogleDirectoryErrorCode,
} from "./google-directory-errors"
import { GOOGLE_DIRECTORY_ERRORS } from "./sso-types"

describe("google-directory-errors", () => {
  it("has copy for all 17 GoogleDirectoryErrorCode values", () => {
    for (const code of GOOGLE_DIRECTORY_ERRORS) {
      expect(isGoogleDirectoryErrorCode(code)).toBe(true)
      const message = describeGoogleError(code, {
        clientId: "123456789.apps.googleusercontent.com",
        scopes: ["https://www.googleapis.com/auth/admin.directory.user.readonly"],
        missingScopes: [
          "https://www.googleapis.com/auth/admin.directory.group.readonly",
        ],
        removedUsers: 10,
        existingUsers: 20,
        canConfirmRemovals: true,
      })
      expect(message).toBeString()
      expect(message.length).toBeGreaterThan(10)
      // Never print a raw error code in user-facing copy
      expect(message).not.toContain(code)
      // Never use em dash
      expect(message).not.toContain(String.fromCodePoint(0x2014))
    }
  })

  it("never prints an em dash in any error copy branch", () => {
    for (const code of GOOGLE_DIRECTORY_ERRORS) {
      const emptyCtxMsg = describeGoogleError(code, {})
      expect(emptyCtxMsg).not.toContain(String.fromCodePoint(0x2014))

      const populatedCtxMsg = describeGoogleError(code, {
        clientId: "test-client",
        scopes: DEFAULT_GOOGLE_SCOPES,
        missingScopes: ["scope-a"],
        removedUsers: 1,
        existingUsers: 1,
        canConfirmRemovals: true,
      })
      expect(populatedCtxMsg).not.toContain(String.fromCodePoint(0x2014))
    }
  })

  it("falls back gracefully when code is unknown, empty or undefined without printing raw code", () => {
    const unknown = describeGoogleError("some_weird_code")
    expect(unknown).toBe(
      "Google refused the request; check the delegation in your Google Admin console, then try again.",
    )
    expect(unknown).not.toContain("some_weird_code")

    const empty = describeGoogleError(null)
    expect(empty).toBe(
      "Google refused the request; check the delegation in your Google Admin console, then try again.",
    )

    const undef = describeGoogleError(undefined)
    expect(undef).toBe(
      "Google refused the request; check the delegation in your Google Admin console, then try again.",
    )
  })

  it("handles unauthorized_client with and without clientId", () => {
    const withId = describeGoogleError("unauthorized_client", {
      clientId: "client-abc",
    })
    expect(withId).toContain("Client ID client-abc")

    const withoutId = describeGoogleError("unauthorized_client", {})
    expect(withoutId).toContain("our Client ID")
  })

  it("handles delegation_missing with custom scopes and default scopes", () => {
    const custom = describeGoogleError("delegation_missing", {
      clientId: "client-xyz",
      scopes: ["https://scope/one"],
    })
    expect(custom).toContain("Client ID client-xyz")
    expect(custom).toContain("https://scope/one")

    const defaults = describeGoogleError("delegation_missing", {})
    expect(defaults).toContain("our Client ID")
    expect(defaults).toContain(DEFAULT_GOOGLE_SCOPES[0])
  })

  it("handles large_drop correctly based on owner ability and count", () => {
    const ownerKnown = describeGoogleError("large_drop", {
      removedUsers: 5,
      existingUsers: 10,
      canConfirmRemovals: true,
    })
    expect(ownerKnown).toContain("5 of 10 people would be removed")
    expect(ownerKnown).toContain("confirm them below")

    const nonOwnerKnown = describeGoogleError("large_drop", {
      removedUsers: 1,
      existingUsers: 1,
      canConfirmRemovals: false,
    })
    expect(nonOwnerKnown).toContain("1 of 1 person would be removed")
    expect(nonOwnerKnown).not.toContain("confirm them below")

    const unknownCounts = describeGoogleError("large_drop", {})
    expect(unknownCounts).toContain("A large share of your people would be removed")
    expect(unknownCounts).not.toContain("confirm them below")
  })
})
