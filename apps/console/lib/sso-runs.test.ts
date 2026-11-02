import { describe, expect, it } from "bun:test"
import { DAY_MS, groupsNote, latestPass, mfaCapabilityNote, wouldDo } from "./sso-runs"
import type { SsoCapabilities, TestRun } from "./sso-types"

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

  it("says a changed login would be relinked, or refused for an owner to approve", () => {
    expect(
      wouldDo(
        run({
          resolution: { path: "linked", wouldRelink: true, email: "a@acme.test" },
        }),
      ),
    ).toContain("move their link")
    const said = wouldDo(
      run({ outcome: "failed", resolution: { refused: "subject_changed" } }),
    )
    expect(said).toContain("refuse")
    expect(said).toContain("owner")
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

describe("group state and MFA capability notes (P0 #3 and P0 #5)", () => {
  it("explains absent and overage group states on test runs", () => {
    expect(groupsNote(run({ claims: { groupsState: "present" } }))).toBeNull()

    const overage = run({
      claims: { groupsState: "overage" },
      resolution: {
        path: "linked",
        email: "ada@acme.test",
        groupsUnavailable: "overage",
        roleKept: true,
      },
    })
    expect(groupsNote(overage)).toContain("Too many groups (overage)")
    expect(groupsNote(overage)).toContain("current workspace role would be kept")
    expect(wouldDo(overage)).toContain("keep their current role (too many groups (overage))")

    const absentJit = run({
      claims: { groupsState: "absent" },
      resolution: {
        path: "jit",
        wouldCreate: true,
        email: "new@acme.test",
        role: "member",
        groupsUnavailable: "absent",
      },
    })
    expect(groupsNote(absentJit)).toContain("No groups received")
    expect(groupsNote(absentJit)).toContain("default member role")
    expect(wouldDo(absentJit)).toContain("no groups received")
  })

  it("shows refusal reason, legacy-on warning, and with_setting guidance for MFA", () => {
    const googleCaps: SsoCapabilities = {
      label: "Google Workspace",
      canProveMfa: "no",
      mfaSetting: null,
      mfaUnprovableReason: "Google Workspace OIDC never sends amr or acr claims.",
      canProveFreshAuth: "no",
      freshAuthSetting: null,
    }
    expect(
      mfaCapabilityNote({ mfaRequired: false, capabilities: googleCaps }),
    ).toEqual({
      tone: "muted",
      text: "Google Workspace OIDC never sends amr or acr claims.",
    })
    const legacyOn = mfaCapabilityNote({ mfaRequired: true, capabilities: googleCaps })
    expect(legacyOn?.tone).toBe("warning")
    expect(legacyOn?.text).toContain("Warning:")

    const oktaSamlCaps: SsoCapabilities = {
      label: "Okta",
      canProveMfa: "with_setting",
      mfaSetting: "Send session.amr as an attribute named amr in your Okta SAML app.",
      mfaUnprovableReason: null,
      canProveFreshAuth: "with_setting",
      freshAuthSetting: "Set Honor Force Authentication to Yes in your Okta SAML app.",
    }
    expect(
      mfaCapabilityNote({ mfaRequired: false, capabilities: oktaSamlCaps }),
    ).toEqual({
      tone: "muted",
      text: "Provider setting required: Send session.amr as an attribute named amr in your Okta SAML app.",
    })
  })
})
