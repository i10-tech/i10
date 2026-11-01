import { describe, expect, it } from "bun:test"
import { ssoStartHref, ssoStepUpOf } from "../lib/sso-start"

const AUTH = "https://auth.i10.localhost"
const HERE = "https://dash.i10.localhost/settings/security/abc?tab=setup"

describe("ssoStartHref", () => {
  it("follows apps/auth's step-up route and returns here", () => {
    const href = ssoStartHref(
      `${AUTH}/sso/step-up?connection=c1`,
      AUTH,
      "/sso/step-up",
      HERE,
    )
    const url = new URL(href!)
    expect(url.origin).toBe(AUTH)
    expect(url.pathname).toBe("/sso/step-up")
    expect(url.searchParams.get("connection")).toBe("c1")
    expect(url.searchParams.get("redirect_url")).toBe(HERE)
  })

  it("refuses another origin, a look-alike, another route and junk", () => {
    for (const startUrl of [
      "https://evil.example/sso/step-up",
      `${AUTH}.evil.example/sso/step-up`,
      `${AUTH}/sso/start?connection=c1`,
      `${AUTH}/sign-in`,
      "not a url",
      42,
      null,
    ])
      expect(ssoStartHref(startUrl, AUTH, "/sso/step-up", HERE)).toBeNull()
  })

  it("refuses everything when apps/auth's origin is unknown", () => {
    expect(ssoStartHref(`${AUTH}/sso/start`, null, "/sso/start", HERE)).toBeNull()
  })
})

describe("ssoStepUpOf", () => {
  it("reads the API's SSO step-up refusal", () => {
    expect(
      ssoStepUpOf({
        name: "sso_step_up_required",
        message: "Sign in again.",
        startUrl: `${AUTH}/sso/step-up?connection=c1`,
      }),
    ).toEqual({
      message: "Sign in again.",
      startUrl: `${AUTH}/sso/step-up?connection=c1`,
    })
  })

  it("ignores every other answer", () => {
    for (const body of [
      null,
      undefined,
      "x",
      { name: "forbidden" },
      { clerk_error: {} },
    ])
      expect(ssoStepUpOf(body)).toBeNull()
  })
})
