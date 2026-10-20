import { describe, expect, it } from "bun:test"
import { NOT_MANAGED, type ManagedAccounts } from "../src/managed.js"
import { decide, pathProblem } from "../src/policy.js"
import { form, request, SESSION } from "./helpers.js"

const prod = { development: false, managed: NOT_MANAGED }

describe("path tricks never reach a denied route", () => {
  it.each([
    ["/v1/client/../organizations", "dot_segment"],
    ["/v1/client/./sign_ins", "dot_segment"],
    ["/v1/me/..", "dot_segment"],
    ["/v1//organizations", "empty_segment"],
    ["//v1/organizations", "empty_segment"],
    ["/v1/client%2F..%2Forganizations", "encoded_path"],
    ["/v1/client/%2e%2e/organizations", "encoded_path"],
    ["/v1/organization%73", "encoded_path"],
    ["/v1/client\\..\\organizations", "bad_character"],
    ["/v1/organizations;x=1", "bad_character"],
    ["/v1/client\u0000/organizations", "bad_character"],
    ["v1/client", "bad_path"],
    [`/${"a/".repeat(600)}`, "path_too_long"],
  ])("%s → %s", async (path, reason) => {
    expect(pathProblem(path)).toBe(reason)
    const decision = await decide(
      request("POST", path, { body: form({ a: "b" }) }),
      prod,
    )
    expect(decision).toMatchObject({ outcome: "deny", reason })
  })

  it("does not match case-insensitively", async () => {
    for (const path of ["/V1/ORGANIZATIONS", "/v1/Organizations", "/V1/client"]) {
      const decision = await decide(
        request("POST", path, { body: form({ a: "b" }) }),
        prod,
      )
      expect(decision).toMatchObject({ outcome: "deny", reason: "not_allowlisted" })
    }
    const upper = await decide(request("GET", "/V1/ENVIRONMENT"), prod)
    expect(upper.outcome).toBe("deny")
  })

  it("strips exactly one trailing slash, as clerk-js sends for backup codes", async () => {
    const search = `?_clerk_session_id=${SESSION}`
    const one = await decide(
      request("POST", "/v1/me/backup_codes/", { search, body: { kind: "none" } }),
      prod,
    )
    expect(one).toMatchObject({ outcome: "pass", route: "me.backup_codes.create" })
    const two = await decide(request("POST", "/v1/me/backup_codes//", { search }), prod)
    expect(two).toMatchObject({ outcome: "deny", reason: "empty_segment" })
    const denied = await decide(
      request("POST", "/v1/organizations/", { body: form({ name: "x" }) }),
      prod,
    )
    expect(denied).toMatchObject({ outcome: "deny", reason: "org_create_via_api" })
  })

  it("ignores the query string for routing", async () => {
    const decision = await decide(
      request("GET", "/v1/environment", { search: "?path=/v1/organizations&x=%2F" }),
      prod,
    )
    expect(decision).toMatchObject({ outcome: "pass", route: "environment.read" })
  })
})

describe("the effective method", () => {
  it("follows clerk-js's _method override", async () => {
    const decision = await decide(
      request("POST", "/v1/client/sessions", { search: "?_method=DELETE" }),
      prod,
    )
    expect(decision).toMatchObject({
      outcome: "pass",
      method: "DELETE",
      route: "client.sessions.remove_all",
    })
  })

  it("treats a real DELETE the same as the override", async () => {
    const decision = await decide(request("DELETE", "/v1/client/sessions"), prod)
    expect(decision).toMatchObject({
      outcome: "pass",
      route: "client.sessions.remove_all",
    })
  })

  it.each([
    ["?_method=DELETE&_method=PATCH", "ambiguous_method_override"],
    ["?_METHOD=DELETE", "ambiguous_method_override"],
    ["?_method=DELETE&_Method=PATCH", "ambiguous_method_override"],
    ["?_method=GET", "bad_method_override"],
    ["?_method=OPTIONS", "bad_method_override"],
    ["?_method=", "bad_method_override"],
  ])("refuses %s", async (search, reason) => {
    const decision = await decide(
      request("POST", "/v1/client/sessions", { search }),
      prod,
    )
    expect(decision).toMatchObject({ outcome: "deny", reason })
  })

  it("refuses an override on anything but POST", async () => {
    const decision = await decide(
      request("GET", "/v1/environment", { search: "?_method=DELETE" }),
      prod,
    )
    expect(decision).toMatchObject({ outcome: "deny", reason: "bad_method_override" })
  })

  it("refuses an override in the body", async () => {
    const decision = await decide(
      request("POST", `/v1/client/sessions/${SESSION}/touch`, {
        body: form({ _method: "DELETE" }),
      }),
      prod,
    )
    expect(decision).toMatchObject({
      outcome: "deny",
      reason: "method_override_in_body",
    })
  })

  it.each(["HEAD", "TRACE", "CONNECT", "PROPFIND"])("refuses %s", async (method) => {
    const decision = await decide(request(method, "/v1/environment"), prod)
    expect(decision).toMatchObject({ outcome: "deny", reason: "method_not_allowed" })
  })

  it("routes a preflight by the method it asks about", async () => {
    const ok = await decide(
      request("OPTIONS", "/v1/me/profile_image", { preflightMethod: "POST" }),
      prod,
    )
    expect(ok).toMatchObject({ outcome: "pass", method: "OPTIONS" })
    const denied = await decide(
      request("OPTIONS", "/v1/organizations", { preflightMethod: "POST" }),
      prod,
    )
    expect(denied).toMatchObject({ outcome: "deny", reason: "org_create_via_api" })
    const none = await decide(request("OPTIONS", "/v1/environment"), prod)
    expect(none).toMatchObject({ outcome: "deny", reason: "method_not_allowed" })
  })
})

describe("bodies", () => {
  it("lets an upload through only where a file belongs", async () => {
    const search = `?_clerk_session_id=${SESSION}`
    const photo = await decide(
      request("POST", "/v1/me/profile_image", { search, body: { kind: "upload" } }),
      prod,
    )
    expect(photo).toMatchObject({ outcome: "pass" })
    const elsewhere = await decide(
      request("POST", "/v1/client/sign_ins", { body: { kind: "upload" } }),
      prod,
    )
    expect(elsewhere).toMatchObject({
      outcome: "deny",
      reason: "unsupported_content_type",
    })
  })

  it("refuses other content types and oversized forms", async () => {
    const json = await decide(
      request("POST", "/v1/client/sign_ins", { body: { kind: "other" } }),
      prod,
    )
    expect(json).toMatchObject({ outcome: "deny", reason: "unsupported_content_type" })
    const big = await decide(
      request("POST", "/v1/client/sign_ins", { body: { kind: "too_large" } }),
      prod,
    )
    expect(big).toMatchObject({ outcome: "deny", reason: "body_too_large" })
  })
})

/** A hook that says everybody is managed, and remembers what it was asked. */
function everyoneManaged() {
  const asked: string[] = []
  const managed: ManagedAccounts = {
    async byIdentifier(identifier) {
      asked.push(`identifier:${identifier}`)
      return true
    },
    async bySession(session) {
      asked.push(`session:${session}`)
      return true
    },
  }
  return { asked, options: { development: false, managed } }
}

describe("managed accounts", () => {
  const selfService: [string, string][] = [
    ["PATCH", "/v1/me"],
    ["POST", "/v1/me/email_addresses"],
    ["POST", "/v1/me/change_password"],
    ["POST", "/v1/me/passkeys"],
    ["POST", "/v1/me/totp"],
    ["DELETE", "/v1/me/totp"],
    ["POST", "/v1/me/backup_codes"],
    ["POST", "/v1/me/external_accounts"],
    ["GET", "/v1/me/sessions/active"],
    ["POST", `/v1/me/sessions/${SESSION}/revoke`],
  ]

  it.each(selfService)("refuses %s %s for a managed session", async (method, path) => {
    const { asked, options } = everyoneManaged()
    const decision = await decide(
      request(method, path, {
        search: `?_clerk_session_id=${SESSION}`,
        body: method === "GET" ? { kind: "none" } : form({ a: "b" }),
      }),
      options,
    )
    expect(decision).toMatchObject({ outcome: "managed", reason: "managed_account" })
    expect(asked).toEqual([`session:${SESSION}`])
  })

  it("refuses self-service without exactly one session id", async () => {
    for (const search of [
      "",
      `?_clerk_session_id=${SESSION}&_clerk_session_id=${SESSION}`,
      "?_clerk_session_id=user_123",
    ]) {
      const decision = await decide(request("POST", "/v1/me/totp", { search }), prod)
      expect(decision).toMatchObject({ outcome: "deny", reason: "session_required" })
    }
  })

  it.each([
    [{ identifier: "Ada@Example.COM " }],
    [{ identifier: "ada@example.com", password: "x" }],
    [{ identifier: "ada@example.com", strategy: "password", password: "x" }],
    [{ identifier: "ada@example.com", strategy: "email_code" }],
    [{ identifier: "ada@example.com", strategy: "email_link" }],
    [{ identifier: "ada@example.com", strategy: "reset_password_email_code" }],
    [{ identifier: "ada@example.com", strategy: "oauth_google" }],
  ])("refuses a non-ticket sign-in %o", async (fields) => {
    const { asked, options } = everyoneManaged()
    const decision = await decide(
      request("POST", "/v1/client/sign_ins", { body: form(fields) }),
      options,
    )
    expect(decision).toMatchObject({ outcome: "managed", reason: "sso_required" })
    expect(asked).toEqual(["identifier:ada@example.com"])
  })

  it("lets a ticket through without asking", async () => {
    const { asked, options } = everyoneManaged()
    const decision = await decide(
      request("POST", "/v1/client/sign_ins", {
        body: form({ strategy: "ticket", ticket: "t", identifier: "ada@example.com" }),
      }),
      options,
    )
    expect(decision).toMatchObject({ outcome: "pass", route: "sign_in.create" })
    expect(asked).toEqual([])
  })

  it("refuses duplicate strategy or identifier fields", async () => {
    const { options } = everyoneManaged()
    for (const fields of [
      [
        ["strategy", "ticket"],
        ["strategy", "password"],
      ],
      [
        ["identifier", "a@example.com"],
        ["identifier", "b@example.com"],
      ],
    ] as [string, string][][]) {
      const decision = await decide(
        request("POST", "/v1/client/sign_ins", { body: form(fields) }),
        options,
      )
      expect(decision).toMatchObject({ outcome: "deny", reason: "ambiguous_form" })
    }
  })

  it("passes a non-managed person and asks nothing on unguarded routes", async () => {
    const { asked, options } = everyoneManaged()
    const token = await decide(
      request("POST", `/v1/client/sessions/${SESSION}/tokens`),
      options,
    )
    expect(token).toMatchObject({ outcome: "pass" })
    expect(asked).toEqual([])
    const fine = await decide(
      request("POST", "/v1/client/sign_ins", {
        body: form({ identifier: "ada@example.com" }),
      }),
      prod,
    )
    expect(fine).toMatchObject({ outcome: "pass" })
  })

  it("answers unavailable, not 'no', when the lookup fails", async () => {
    const failing: ManagedAccounts = {
      byIdentifier: () => Promise.reject(new Error("api down")),
      bySession: () => Promise.reject(new Error("api down")),
    }
    const options = { development: false, managed: failing }
    const signIn = await decide(
      request("POST", "/v1/client/sign_ins", { body: form({ identifier: "a@b.co" }) }),
      options,
    )
    expect(signIn).toMatchObject({
      outcome: "unavailable",
      reason: "managed_lookup_failed",
    })
    const self = await decide(
      request("PATCH", "/v1/me", { search: `?_clerk_session_id=${SESSION}` }),
      options,
    )
    expect(self).toMatchObject({ outcome: "unavailable" })
  })
})
