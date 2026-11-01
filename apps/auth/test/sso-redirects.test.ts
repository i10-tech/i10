import { beforeEach, describe, expect, it, mock } from "bun:test"
import { NextRequest } from "next/server"

mock.module("server-only", () => ({}))

let token: string | null = null
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ getToken: async () => token }),
}))
mock.module("../app/_lib/devices-server", () => ({
  callApi: async () => Response.json({ message: "No." }, { status: 403 }),
  FINISH_SIGN_IN_MS: 30_000,
}))

const { failedUrl, redirectHere } = await import("../app/_lib/sso-server")
const { leave, outcomeRedirect } = await import("../app/_lib/sso-callback")
const testRun = await import("../app/sso/test-run/route")
const connection = await import("../app/sso/[connection]/route")

/** The bind address Next reports, which is NOT the host the browser used. */
const BIND = "https://localhost:3004"
const ID = "0b9f6a52-3c1e-4c1a-9d57-2f6a4a0f1c11"

function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${BIND}${path}`, { headers })
}

function expectRelative(response: Response) {
  const location = response.headers.get("location") ?? ""
  expect(response.status).toBe(303)
  expect(location.startsWith("/")).toBe(true)
  expect(location.startsWith("//")).toBe(false)
  expect(location).not.toContain("localhost")
  expect(location).not.toMatch(/^[a-z][a-z0-9+.-]*:/i)
  return location
}

describe("same-app SSO redirects are relative", () => {
  beforeEach(() => {
    token = null
  })

  it("failedUrl is a path with the reason in the hash", () => {
    const url = failedUrl("Start again.")
    expect(url).toBe("/sso/continue#error=Start+again.")
  })

  it("redirectHere answers with the path as given and no caching", () => {
    const response = redirectHere("/sign-in")
    expect(response.headers.get("location")).toBe("/sign-in")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(redirectHere("/x", 302).status).toBe(302)
  })

  it("leave keeps a relative path and an absolute IdP URL as they are", () => {
    expect(leave("/sign-in", true).headers.get("location")).toBe("/sign-in")
    expect(leave("https://idp.example/slo?x=1", true).headers.get("location")).toBe(
      "https://idp.example/slo?x=1",
    )
  })

  it("outcomeRedirect lands on the continue page without a host", () => {
    const signedIn = outcomeRedirect({ outcome: "signed_in", code: "abc" })
    expect(expectRelative(signedIn)).toBe("/sso/continue#code=abc")
    const tested = outcomeRedirect({ outcome: "tested", passed: true })
    expect(expectRelative(tested)).toBe("/sso/continue#sso_test=passed")
    expect(expectRelative(outcomeRedirect({ outcome: "nope" }))).toContain(
      "/sso/continue#error=",
    )
  })

  it("test-run refuses a cross-site start with a relative Location", async () => {
    const response = await testRun.GET(
      get(`/sso/test-run?connection=${ID}`, { "sec-fetch-site": "cross-site" }),
    )
    expect(expectRelative(response)).toStartWith("/sso/continue#error=")
  })

  it("lets a cross-site start in only when our console is the referer", async () => {
    const saved = process.env.AUTH_ALLOWED_REDIRECT_ORIGINS
    process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = "https://dash.i10.localhost"
    try {
      const from = (referer?: string) =>
        testRun.GET(
          get(`/sso/test-run?connection=${ID}`, {
            "sec-fetch-site": "cross-site",
            ...(referer ? { referer } : {}),
          }),
        )
      expect(expectRelative(await from("https://dash.i10.localhost/"))).toBe("/sign-in")
      for (const referer of [
        undefined,
        "https://evil.example/",
        "https://dash.i10.localhost.evil.example/",
        "not a url",
      ])
        expect(expectRelative(await from(referer))).toStartWith("/sso/continue#error=")
    } finally {
      process.env.AUTH_ALLOWED_REDIRECT_ORIGINS = saved
    }
  })

  it("test-run sends a signed-out admin to a relative /sign-in", async () => {
    const response = await testRun.GET(
      get(`/sso/test-run?connection=${ID}`, { "sec-fetch-site": "same-site" }),
    )
    expect(expectRelative(response)).toBe("/sign-in")
  })

  it("test-run reports an API refusal with a relative Location", async () => {
    token = "session-token"
    const response = await testRun.GET(get(`/sso/test-run?connection=${ID}`))
    expect(expectRelative(response)).toStartWith("/sso/continue#error=No.")
  })

  it("the tidy /sso/<id> link hands over to /sso/start relatively", async () => {
    const response = await connection.GET(
      get(`/sso/${ID}?redirect_url=https%3A%2F%2Fdash.example%2Fx`),
      { params: Promise.resolve({ connection: ID }) },
    )
    const location = expectRelative(response)
    expect(location).toStartWith(`/sso/start?connection=${ID}&redirect_url=`)
  })
})
