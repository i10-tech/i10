import { describe, expect, it } from "bun:test"
import { NOT_MANAGED } from "../src/managed.js"
import { decide, findAllow, findDeny } from "../src/policy.js"
import { ALLOW, compile, DENY, type Method } from "../src/routes.js"
import { form, request, sample, SESSION } from "./helpers.js"

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const options = { development: true, managed: NOT_MANAGED }

/** The body and query each entry needs to pass on its own merits. */
function passing(entry: (typeof ALLOW)[number]) {
  const search = entry.guard === "self_service" ? `?_clerk_session_id=${SESSION}` : ""
  const body =
    entry.method === "GET" ? ({ kind: "none" } as const) : form({ any: "value" })
  return { search, body }
}

describe("the allowlist", () => {
  it.each(ALLOW.map((e) => [e.name, e] as const))("%s passes", async (_, entry) => {
    const decision = await decide(
      request(entry.method, sample(entry.path), passing(entry)),
      options,
    )
    expect(decision).toMatchObject({ outcome: "pass", route: entry.name })
  })

  it("names every entry once", () => {
    const names = ALLOW.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("gives every entry a reason", () => {
    for (const entry of ALLOW) expect(entry.why.length).toBeGreaterThan(10)
  })

  it("never has two entries for one request", () => {
    for (const entry of ALLOW) {
      const path = sample(entry.path)
      const matches = ALLOW.filter(
        (other) => other.method === entry.method && compile(other.path).test(path),
      )
      expect(matches.map((m) => m.name)).toEqual([entry.name])
    }
  })

  it("never overlaps the explicit deny list", () => {
    for (const entry of ALLOW) {
      expect(findDeny(entry.method, sample(entry.path))).toBeNull()
    }
  })

  it("keeps dev-only entries closed on production", async () => {
    for (const entry of ALLOW.filter((e) => e.devOnly)) {
      const decision = await decide(
        request(entry.method, sample(entry.path), passing(entry)),
        { development: false, managed: NOT_MANAGED },
      )
      expect(decision).toMatchObject({ outcome: "deny", reason: "dev_only" })
    }
  })
})

describe("the explicit deny list", () => {
  it.each(DENY.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s is refused with its reason",
    async (_, entry) => {
      const methods = entry.method === "*" ? METHODS : [entry.method]
      for (const method of methods) {
        const decision = await decide(
          request(method, sample(entry.path), { body: form({ a: "b" }) }),
          options,
        )
        expect(decision).toMatchObject({ outcome: "deny", reason: entry.reason })
        expect(findAllow(method, sample(entry.path))).toBeNull()
      }
    },
  )

  it("covers what sso.md 1.3 and the issue name", async () => {
    const org = sample(":org")
    const cases: [Method, string, string][] = [
      ["POST", "/v1/organizations", "org_create_via_api"],
      ["PATCH", `/v1/organizations/${org}`, "org_admin_via_api"],
      ["DELETE", `/v1/organizations/${org}`, "org_admin_via_api"],
      ["PUT", `/v1/organizations/${org}/logo`, "org_admin_via_api"],
      ["POST", `/v1/organizations/${org}/invitations`, "org_admin_via_api"],
      ["POST", `/v1/organizations/${org}/invitations/bulk`, "org_admin_via_api"],
      ["GET", `/v1/organizations/${org}/invitations/pending`, "org_admin_via_api"],
      [
        "POST",
        `/v1/organizations/${org}/invitations/${sample(":orginv")}/revoke`,
        "org_admin_via_api",
      ],
      ["POST", `/v1/organizations/${org}/memberships`, "org_admin_via_api"],
      ["PATCH", `/v1/organizations/${org}/memberships/user_123`, "org_admin_via_api"],
      ["DELETE", `/v1/organizations/${org}/memberships/user_123`, "org_admin_via_api"],
      [
        "POST",
        `/v1/organizations/${org}/membership_requests/orgmbr_1/accept`,
        "org_admin_via_api",
      ],
      [
        "POST",
        `/v1/organizations/${org}/membership_requests/orgmbr_1/reject`,
        "org_admin_via_api",
      ],
      ["POST", `/v1/organizations/${org}/domains`, "org_admin_via_api"],
      [
        "POST",
        `/v1/organizations/${org}/domains/orgdmn_1/update_enrollment_mode`,
        "org_admin_via_api",
      ],
      [
        "POST",
        `/v1/organizations/${org}/sso_bypass_allowlist_users/bulk`,
        "sso_bypass_ours",
      ],
      [
        "POST",
        `/v1/organizations/${org}/enterprise_connections`,
        "enterprise_connections_not_used",
      ],
      ["GET", "/v1/me/enterprise_connections", "enterprise_connections_not_used"],
      ["DELETE", "/v1/me", "user_delete_via_api"],
      ["POST", "/oauth/register", "oauth_provider_not_used"],
      ["GET", "/oauth/authorize", "oauth_provider_not_used"],
      ["POST", "/oauth/token", "oauth_provider_not_used"],
      ["GET", "/oauth/userinfo", "oauth_provider_not_used"],
      ["GET", "/.well-known/jwks.json", "oauth_provider_not_used"],
      ["GET", "/.well-known/openid-configuration", "oauth_provider_not_used"],
      ["GET", `/v1/me/oauth/consent/${sample(":client")}`, "oauth_provider_not_used"],
      ["POST", `/v1/me/oauth/consent/${sample(":client")}`, "oauth_provider_not_used"],
      ["POST", "/api_keys", "api_keys_ours"],
      ["POST", "/v1/me/billing/checkouts", "billing_not_clerk"],
    ]
    for (const [method, path, reason] of cases) {
      const decision = await decide(
        request(method, path, { body: form({ a: "b" }) }),
        options,
      )
      expect(decision).toMatchObject({ outcome: "deny", reason })
    }
  })

  it("refuses DELETE /v1/me in clerk-js's own shape too", async () => {
    const decision = await decide(
      request("POST", "/v1/me", {
        search: `?_method=DELETE&_clerk_session_id=${SESSION}`,
      }),
      options,
    )
    expect(decision).toMatchObject({
      outcome: "deny",
      method: "DELETE",
      reason: "user_delete_via_api",
    })
  })
})

describe("everything else", () => {
  it.each([
    ["GET", "/"],
    ["GET", "/v1"],
    ["GET", "/v1/client/sync"],
    ["GET", "/v1/client/link"],
    ["PUT", "/v1/client"],
    ["DELETE", "/v1/client"],
    ["GET", "/v1/me/sessions"],
    ["POST", "/v1/me/remove_password"],
    ["PATCH", "/v1/me/metadata"],
    ["POST", "/v1/me/phone_numbers"],
    ["POST", "/v1/me/web3_wallets"],
    ["GET", "/v1/verify"],
    ["POST", "/v1/waitlist"],
    ["POST", `/v1/client/sessions/${SESSION}/tokens/supabase`],
    ["GET", "/v1/organizations"],
    ["GET", "/npm/@clerk/other@6/dist/x.js"],
    ["GET", "/npm/@clerk/clerk-js@6/dist/../../evil.js"],
  ])("%s %s is a 404", async (method, path) => {
    const decision = await decide(
      request(method, path, { body: form({ a: "b" }) }),
      options,
    )
    expect(decision.outcome).toBe("deny")
  })
})
