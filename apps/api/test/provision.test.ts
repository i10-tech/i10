import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import { tenantProvisioning } from "../src/tenants/provision.js"

const log = { info: () => {}, warn: () => {}, error: () => {} }

const deps = (over: Record<string, unknown> = {}) => ({
  organizations: {
    membershipCount: mock(async () => 0),
    create: mock(async () => {}),
  },
  tenants: { provision: mock(async () => ({ id: "ten-1", created: true })) },
  entitlements: { ensureCustomer: mock(async () => {}) },
  log,
  ...over,
})

const user = {
  id: "user_abc12345678",
  first_name: "Mohamed",
  email_addresses: [{ email_address: "mohamed@i10.tech" }],
}

const org = {
  id: "org_xyz98765432",
  name: "Mohamed",
  slug: "mohamed-12345678",
  created_by: "user_abc12345678",
}

describe("a new user", () => {
  it("gets a personal organization, because a user with none cannot send", async () => {
    const d = deps()
    const outcome = await tenantProvisioning(d).onUserCreated(user)

    expect(outcome).toBe("organization_created")
    expect(d.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mohamed", createdBy: user.id }),
    )
  })

  // ⚠ THE COMMON CASE IS THE RETRY. Svix redelivers, and a second organization
  // would be a second tenant and a second bill for one person.
  it("gets nothing when they already belong to one", async () => {
    const d = deps({
      organizations: {
        membershipCount: mock(async () => 1),
        create: mock(async () => {}),
      },
    })

    expect(await tenantProvisioning(d).onUserCreated(user)).toBe("already_provisioned")
    expect(d.organizations.create).not.toHaveBeenCalled()
  })

  // Clerk slugs are unique across the instance, so two people with the same
  // name would collide on the second sign-up — a 500 in somebody's first minute.
  it("gets a slug that cannot collide with another person of the same name", async () => {
    const d = deps()
    await tenantProvisioning(d).onUserCreated(user)

    // The name, then the last eight characters of the user id — lowercase,
    // alphanumeric and hyphens, which is all Clerk accepts.
    expect(d.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "mohamed-12345678" }),
    )
  })

  it("falls back to the email local part when there is no first name", async () => {
    const d = deps()
    await tenantProvisioning(d).onUserCreated({ ...user, first_name: null })

    expect(d.organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mohamed" }),
    )
  })

  it("ignores a payload with no user id rather than throwing", async () => {
    expect(await tenantProvisioning(deps()).onUserCreated({})).toBe("ignored")
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

  // ⚠ A TENANT THAT EXISTS AND CANNOT YET SEND IS RECOVERABLE — the reconciler's
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
  // so an unsigned request must not reach it — otherwise anyone who learns the
  // URL can mint tenants. The signature gate runs before anything else.
  //
  // What this file cannot cover is the ordering that matters most: that
  // provisioning still runs when `applyClerkEvent` answers `duplicate`, so a
  // redelivery repairs a sign-up that failed the first time. That needs a
  // database, and belongs in an integration test we do not have yet.
  it("does not provision anything for an unsigned request", async () => {
    const onUserCreated = mock(async () => "organization_created" as const)
    const app = createApp({
      clerkWebhooks: {
        db: null as never,
        signingSecret: "whsec_test",
        hostedDomains: ["i10.tech"],
        provisioning: { onUserCreated, onOrganizationCreated: mock() },
        log,
      },
    })

    const res = await app.request("/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "user.created", data: user }),
    })

    expect(res.status).toBe(401)
    expect(onUserCreated).not.toHaveBeenCalled()
  })
})
