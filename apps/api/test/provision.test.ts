import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import { tenantProvisioning } from "../src/tenants/provision.js"

const log = { info: () => {}, warn: () => {}, error: () => {} }

const deps = (over: Record<string, unknown> = {}) => ({
  tenants: { provision: mock(async () => ({ id: "ten-1", created: true })) },
  entitlements: { ensureCustomer: mock(async () => {}) },
  log,
  ...over,
})

const org = {
  id: "org_xyz98765432",
  name: "Mohamed",
  slug: "mohamed-12345678",
  created_by: "user_abc12345678",
}

// ⚠ NOTHING IS MADE FOR A NEW USER ANY MORE (#325): no organization, no
// tenant. A workspace exists only once somebody names one or picks Personal.
describe("a new user", () => {
  it("is given no workspace", () => {
    expect("onUserCreated" in tenantProvisioning(deps())).toBe(false)
  })
})

describe("a new organization", () => {
  it("becomes a tenant, on the free plan", async () => {
    const d = deps()
    const outcome = await tenantProvisioning(d).onOrganizationCreated(org)

    expect(outcome).toBe("tenant_created")
    expect(d.tenants.provision).toHaveBeenCalledWith({
      clerkOrgId: org.id,
      slug: org.slug,
      name: org.name,
      ownerClerkUserId: org.created_by,
    })
    expect(d.entitlements.ensureCustomer).toHaveBeenCalledWith({
      tenantId: "ten-1",
      name: "Mohamed",
    })
  })

  it("does not re-register a tenant that already existed", async () => {
    const d = deps({
      tenants: { provision: mock(async () => ({ id: "ten-1", created: false })) },
    })

    expect(await tenantProvisioning(d).onOrganizationCreated(org)).toBe(
      "already_provisioned",
    )
    expect(d.entitlements.ensureCustomer).not.toHaveBeenCalled()
  })

  // ⚠ A TENANT THAT EXISTS AND CANNOT YET SEND IS RECOVERABLE - the reconciler's
  // `missingCustomers()` finds it. A sign-up that fails outright is not.
  it("still provisions the tenant when Autumn is unreachable", async () => {
    const d = deps({
      entitlements: {
        ensureCustomer: mock(async () => {
          throw new Error("autumn is down")
        }),
      },
    })

    expect(await tenantProvisioning(d).onOrganizationCreated(org)).toBe(
      "tenant_created",
    )
  })

  it("ignores an organization with no creator", async () => {
    const outcome = await tenantProvisioning(deps()).onOrganizationCreated({
      ...org,
      created_by: null,
    })
    expect(outcome).toBe("ignored")
  })
})

describe("the Clerk webhook route", () => {
  // ⚠ PROVISIONING CREATES ORGANIZATIONS IN CLERK AND TENANTS IN OUR DATABASE,
  // so an unsigned request must not reach it - otherwise anyone who learns the
  // URL can mint tenants. The signature gate runs before anything else.
  //
  // What this file cannot cover is the ordering that matters most: that
  // provisioning still runs when `applyClerkEvent` answers `duplicate`, so a
  // redelivery repairs a sign-up that failed the first time. That needs a
  // database, and belongs in an integration test we do not have yet.
  it("does not provision anything for an unsigned request", async () => {
    const onOrganizationCreated = mock(async () => "tenant_created" as const)
    const app = createApp({
      clerkWebhooks: {
        db: null as never,
        signingSecret: "whsec_test",
        hostedDomains: ["i10.tech"],
        provisioning: { onOrganizationCreated },
        log,
      },
    })

    const res = await app.request("/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "organization.created", data: org }),
    })

    expect(res.status).toBe(401)
    expect(onOrganizationCreated).not.toHaveBeenCalled()
  })
})
