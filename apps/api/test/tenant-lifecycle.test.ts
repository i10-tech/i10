import { describe, expect, it, mock } from "bun:test"
import { tenantLifecycle } from "../src/tenants/lifecycle.js"

/**
 * Deleting an account used to leave the subscription running.
 *
 * ⚠ `organization.deleted` REACHED NOTHING AT ALL. `provision.ts` handled
 * `organization.created` and there was no other half — so deleting an account
 * in Clerk removed the identity and left `core.tenants` saying `active`, the
 * plan assignment on Pro, and Polar charging a card every month for a workspace
 * nobody could sign in to. The only way to stop it was to find the subscription
 * in Polar's dashboard by hand, which is what was actually happening.
 */

const log = { info: () => {}, warn: () => {}, error: () => {} }

const deps = (over: Record<string, unknown> = {}) => ({
  tenants: {
    isLive: mock(async () => true),
    terminate: mock(async () => ({
      tenantId: "ten-1",
      polarSubscriptionId: "sub_1",
      alreadyDead: false,
    })),
    ownedBy: mock(async () => []),
  },
  polar: { revokeSubscription: mock(async () => "revoked" as const) },
  domains: { releaseDomains: mock(async () => ({ released: 2, failed: 0 })) },
  organizations: { exists: mock(async () => false) },
  freePlanId: "free",
  log,
  ...over,
})

/**
 * ⚠ A TERMINATED WORKSPACE USED TO KEEP ITS SES IDENTITIES AND ITS NAMESERVERS.
 * Termination marks the tenant `deleted` rather than deleting the row, so the
 * `on delete cascade` on `domains.tenant_id` never fires and nothing tore
 * anything down: a verified SES identity per domain, and our own PowerDNS
 * still answering for every delegated name — serving DKIM keys and return
 * paths for an account that no longer exists, with no way to find them except
 * by reading the database.
 */
describe("what a terminated workspace gives back", () => {
  it("releases its domains", async () => {
    const d = deps()
    await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })
    expect(d.domains.releaseDomains).toHaveBeenCalledWith("ten-1")
  })

  /*
   * ⚠ THE TEARDOWN HANGS OFF EVERY EXIT, NOT OFF THE ONE WITH A SUBSCRIPTION.
   * Most deleted workspaces are on the free plan and leave through the "no
   * subscription to cancel" branch, so a release attached to the Polar path
   * would have skipped exactly the accounts it was written for.
   */
  it("releases them for a workspace that never had a subscription", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => ({
          tenantId: "ten-1",
          polarSubscriptionId: null,
          alreadyDead: false,
        })),
        ownedBy: mock(async () => []),
      },
    })

    await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })
    expect(d.domains.releaseDomains).toHaveBeenCalledWith("ten-1")
  })

  /*
   * ⚠ AND ON A REDELIVERY TOO. `alreadyDead` says we have seen the deletion
   * before; it does not say the teardown finished. Re-running it is how a
   * partial one repairs itself, and it costs one empty query when there is
   * nothing left.
   */
  it("releases them again on a redelivery", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => ({
          tenantId: "ten-1",
          polarSubscriptionId: null,
          alreadyDead: true,
        })),
        ownedBy: mock(async () => []),
      },
    })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "already_terminated",
    )
    expect(d.domains.releaseDomains).toHaveBeenCalledWith("ten-1")
  })

  /*
   * ⚠ THE BILLING STOP IS THE PART WITH A DEADLINE, AND THE TEARDOWN MUST NOT
   * BE ABLE TO UNDO IT. A failing SES call or an unreachable nameserver would
   * otherwise throw out of the webhook, answer 500, and have Svix redeliver a
   * deletion whose only outstanding work is cleanup.
   */
  it("does not fail the termination when the teardown throws", async () => {
    const shouted: string[] = []
    const error = mock((...args: unknown[]) => {
      shouted.push(String(args[1]))
    })

    const d = deps({
      domains: {
        releaseDomains: mock(async () => {
          throw new Error("pdns unreachable")
        }),
      },
      log: { ...log, error },
    })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "terminated",
    )
    expect(d.polar.revokeSubscription).toHaveBeenCalledWith("sub_1")
    expect(shouted.join(" ")).toContain("could not be released")
  })

  /*
   * ⚠ AND A DEPLOYMENT WITH NO RELEASER SAYS SO AT `error`, on the same rule as
   * the missing Polar client. This is not an absent feature — it is our
   * nameservers going on answering for a deleted customer's domains.
   */
  it("shouts when it can delete the workspace but not its domains", async () => {
    const shouted: string[] = []
    const error = mock((...args: unknown[]) => {
      shouted.push(String(args[1]))
    })

    const d = deps({ domains: undefined, log: { ...log, error } })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "terminated",
    )
    expect(shouted.join(" ")).toContain("STILL LIVE")
  })
})

describe("a deleted organization", () => {
  it("has its subscription ended immediately, not at the period end", async () => {
    const d = deps()
    const outcome = await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })

    expect(outcome).toBe("terminated")
    expect(d.tenants.terminate).toHaveBeenCalledWith("org_1", "free")
    // ⚠ `revoke`, NOT `cancel`. Every other downgrade in the product defers to
    // the period end because the customer has paid for it; there is nobody left
    // to use the remainder here, and continuing to charge a deleted account is
    // the one billing failure nobody accepts an explanation for.
    expect(d.polar.revokeSubscription).toHaveBeenCalledWith("sub_1")
  })

  // ⚠ THE ROW MOVES BEFORE POLAR IS CALLED, so a failure here leaves the
  // workspace switched off on our side and lets Svix retry the revoke. The
  // other order would leave us believing a deleted tenant is still entitled.
  it("is already switched off on our side when Polar refuses", async () => {
    const d = deps({
      polar: {
        revokeSubscription: mock(async () => {
          throw new Error("polar subscription revoke failed: 409")
        }),
      },
    })

    await expect(
      tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" }),
    ).rejects.toThrow("409")
    expect(d.tenants.terminate).toHaveBeenCalled()
  })

  // Svix redelivers. A second delivery must not read as a failure.
  it("is idempotent across a redelivery", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => ({
          tenantId: "ten-1",
          polarSubscriptionId: "sub_1",
          alreadyDead: true,
        })),
        ownedBy: mock(async () => []),
      },
    })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "already_terminated",
    )
  })

  it("is not an error when no tenant was ever provisioned for it", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => null),
        ownedBy: mock(async () => []),
      },
    })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "no_tenant",
    )
  })

  // ⚠ A FREE WORKSPACE HAS NOTHING TO CANCEL, and calling Polar about a
  // customer it has never heard of would be an error over an ordinary deletion.
  it("calls Polar about nothing when there was no subscription", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => ({
          tenantId: "ten-1",
          polarSubscriptionId: null,
          alreadyDead: false,
        })),
        ownedBy: mock(async () => []),
      },
    })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "terminated",
    )
    expect(d.polar.revokeSubscription).not.toHaveBeenCalled()
  })

  /*
   * ⚠ THE DEPLOYMENT WITH NO POLAR CLIENT STILL DELETES THE WORKSPACE AND SAYS
   * LOUDLY WHAT IT COULD NOT DO. This is the only consequence of a missing
   * Polar client that costs money rather than merely disabling a feature, so it
   * is an `error` line naming the subscription somebody has to cancel by hand.
   */
  it("shouts when it can delete the workspace but not stop the billing", async () => {
    const shouted: string[] = []
    const error = mock((...args: unknown[]) => {
      shouted.push(String(args[1]))
    })
    const d = deps({ polar: undefined, log: { ...log, error } })

    expect(await tenantLifecycle(d).onOrganizationDeleted({ id: "org_1" })).toBe(
      "terminated",
    )
    expect(shouted[0]).toContain("STILL ACTIVE")
  })
})

/*
 * ⚠ THE SWEEP EXISTS BECAUSE CLERK'S CASCADE IS NOT SOMETHING WE CAN ASSERT.
 * Deleting an account from the profile panel is a `user.deleted`; whether the
 * personal organization behind the workspace goes with it — and fires its own
 * webhook — is not stated anywhere citable. Guessing either way is dangerous,
 * so this asks Clerk.
 */
describe("a deleted user who owned workspaces", () => {
  const owned = [{ tenantId: "ten-1", clerkOrgId: "org_1" }]

  it("ends the subscription of a workspace that went with them", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => ({
          tenantId: "ten-1",
          polarSubscriptionId: "sub_1",
          alreadyDead: false,
        })),
        ownedBy: mock(async () => owned),
      },
      // Clerk no longer has it: the cascade happened.
      organizations: { exists: mock(async () => false) },
    })

    expect(await tenantLifecycle(d).onUserDeleted({ id: "user_1" })).toBe("terminated")
    expect(d.polar.revokeSubscription).toHaveBeenCalledWith("sub_1")
  })

  /*
   * ⚠ OWNING A TENANT IS NOT THE SAME AS BEING THE LAST PERSON IN IT, AND THIS
   * IS THE FAILURE THAT WOULD BE WORSE THAN THE BUG. A team whose founder
   * deletes their own account still has members, mailboxes and mail in flight;
   * terminating on ownership alone would switch all of that off.
   */
  it("leaves a team alone when its organization is still there", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => null),
        ownedBy: mock(async () => owned),
      },
      organizations: { exists: mock(async () => true) },
    })

    expect(await tenantLifecycle(d).onUserDeleted({ id: "user_1" })).toBe("ignored")
    expect(d.tenants.terminate).not.toHaveBeenCalled()
    expect(d.polar.revokeSubscription).not.toHaveBeenCalled()
  })

  // ⚠ AN UNREACHABLE CLERK IS NOT AN ANSWER. Only a 404 says "gone"; anything
  // else must leave the workspace running.
  it("terminates nothing when Clerk cannot be asked", async () => {
    const d = deps({
      tenants: {
        isLive: mock(async () => true),
        terminate: mock(async () => null),
        ownedBy: mock(async () => owned),
      },
      organizations: {
        exists: mock(async () => {
          throw new Error("clerk is down")
        }),
      },
    })

    expect(await tenantLifecycle(d).onUserDeleted({ id: "user_1" })).toBe("ignored")
    expect(d.tenants.terminate).not.toHaveBeenCalled()
  })

  it("does nothing for somebody who owned no workspace", async () => {
    const d = deps()
    expect(await tenantLifecycle(d).onUserDeleted({ id: "user_1" })).toBe("ignored")
    expect(d.organizations.exists).not.toHaveBeenCalled()
  })
})
