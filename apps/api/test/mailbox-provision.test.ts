import { describe, expect, it, mock } from "bun:test"
import type { CreateMailbox, Mailbox } from "@repo/contracts"
import {
  mailboxProvisioning,
  type MailboxDirectory,
  type MailboxIdentity,
  type ManagedMailLane,
  type ProvisionDeps,
} from "../src/mailboxes/provision.js"
import type { ClerkUser } from "../src/projection/clerk-user.js"

/**
 * Who may have a mailbox, and in what order the question is asked.
 *
 * The ordering is load-bearing rather than cosmetic - see the password test
 * below - so these assert the sequence as well as the answer.
 */

const TENANT = "3f1a0e00-0000-4000-8000-000000000001"

const clerkUser = (over: Partial<ClerkUser> = {}): ClerkUser => ({
  id: "user_1",
  primary_email_address_id: "idn_1",
  first_name: "Mohamed",
  last_name: null,
  updated_at: 1_700_000_000_000,
  email_addresses: [
    {
      id: "idn_1",
      email_address: "me@example.org",
      verification: { status: "verified" },
    },
  ],
  ...over,
})

const mailbox = (
  address = "me@i10.tech",
  displayName: string | null = "Mohamed",
): Mailbox => ({
  object: "mailbox",
  address,
  display_name: displayName,
  active: true,
  created_at: new Date(0).toISOString(),
})

function harness(
  over: {
    identity?: Partial<MailboxIdentity>
    directory?: Partial<MailboxDirectory>
    capacity?: ProvisionDeps["capacity"]
    project?: ProvisionDeps["project"]
    passwordEnabled?: boolean
    mailLane?: ManagedMailLane
  } = {},
) {
  const addVerifiedAddress = mock(async () => {})
  const activate = mock(async (_userId: string, displayName?: string) =>
    mailbox("me@i10.tech", displayName ?? "Mohamed"),
  )

  const identity: MailboxIdentity = {
    get: async () => ({
      user: clerkUser(),
      passwordEnabled: over.passwordEnabled ?? true,
    }),
    addVerifiedAddress,
    ...over.identity,
  }

  const directory: MailboxDirectory = {
    domainOwner: async () => TENANT,
    addressTaken: async () => false,
    current: async () => null,
    activate,
    ...over.directory,
  }

  const provisioning = mailboxProvisioning({
    identity,
    directory,
    capacity: over.capacity ?? { check: async () => ({ status: "allowed" }) },
    project: over.project ?? (async () => ({ email: "me@i10.tech" })),
    featureId: "mailboxes",
    ...(over.mailLane !== undefined ? { mailLane: async () => over.mailLane! } : {}),
    now: () => new Date("2026-09-08T00:00:00Z"),
  })

  return { provisioning, addVerifiedAddress, activate }
}

const create = (
  h: ReturnType<typeof harness>,
  address = "me@i10.tech",
  extra: Omit<CreateMailbox, "address"> = {},
) => h.provisioning.create("user_1", { address, ...extra })

describe("the password and SSO mail-lane precondition", () => {
  it("allows an unmanaged account with a Clerk password", async () => {
    const h = harness({ passwordEnabled: true, mailLane: "unmanaged" })
    const outcome = await create(h)

    expect(outcome.status).toBe("created")
  })

  it("refuses an unmanaged passwordless account with password_required", async () => {
    const h = harness({ passwordEnabled: false })
    const outcome = await create(h)

    expect(outcome.status).toBe("password_required")
  })

  it("allows a managed SSO account with OIDC mail lane on even without a Clerk password", async () => {
    const h = harness({ passwordEnabled: false, mailLane: "oidc" })
    const outcome = await create(h)

    expect(outcome.status).toBe("created")
  })

  it("allows a managed SSO account with LDAP pass-through lane on even without a Clerk password", async () => {
    const h = harness({ passwordEnabled: false, mailLane: "ldap" })
    const outcome = await create(h)

    expect(outcome.status).toBe("created")
  })

  it("refuses a managed SSO account with no mail lane on with mail_signin_off, naming the SSO connection page", async () => {
    const addressTaken = mock(async () => true)
    const domainOwner = mock(async () => TENANT)
    const h = harness({
      passwordEnabled: false,
      mailLane: "off",
      directory: { addressTaken, domainOwner },
    })
    const outcome = await create(h)

    expect(outcome).toEqual({
      status: "mail_signin_off",
      reason: expect.stringContaining(
        'Settings, Single sign-on, the connection, "Mail sign-in"',
      ),
    })
    expect(addressTaken).not.toHaveBeenCalled()
    expect(domainOwner).not.toHaveBeenCalled()
    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
    expect(h.activate).not.toHaveBeenCalled()
  })

  /**
   * ⚠ EVEN IF A CLERK PASSWORD EXISTS, authd never asks Clerk for a managed
   * account's password, so a managed account with no mail lane on still cannot
   * sign in to mail and must be refused with `mail_signin_off`.
   */
  it("refuses a managed SSO account with no mail lane on even if passwordEnabled is true", async () => {
    const h = harness({ passwordEnabled: true, mailLane: "off" })
    const outcome = await create(h)

    expect(outcome.status).toBe("mail_signin_off")
  })

  /**
   * ⚠ THE POINT OF THE ORDERING. A user who cannot hold a mailbox at all must
   * not learn which addresses are free on the way to being told so - checking
   * availability first would make this endpoint an address oracle for anyone
   * who can sign up.
   */
  it("asks about the password before the address", async () => {
    const addressTaken = mock(async () => true)
    const domainOwner = mock(async () => TENANT)
    const h = harness({
      passwordEnabled: false,
      directory: { addressTaken, domainOwner },
    })

    await create(h)

    expect(addressTaken).not.toHaveBeenCalled()
    expect(domainOwner).not.toHaveBeenCalled()
  })

  /** Nothing may reach Clerk before the refusal. */
  it("writes nothing when there is no password", async () => {
    const h = harness({ passwordEnabled: false })
    await create(h)

    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
    expect(h.activate).not.toHaveBeenCalled()
  })
})

describe("which domains may hold a mailbox", () => {
  it("refuses a domain no tenant has verified", async () => {
    const h = harness({ directory: { domainOwner: async () => null } })
    const outcome = await create(h, "me@microsoft.com")

    expect(outcome.status).toBe("rejected")
  })

  /**
   * ⚠ THE REFUSAL HAS TO HAPPEN BEFORE CLERK, not after. Adding a verified
   * address for a domain we do not host writes a claim into the identity
   * provider that outlives the request, where something else may trust it.
   */
  it("does not touch Clerk for a domain we do not host", async () => {
    const h = harness({ directory: { domainOwner: async () => null } })
    await create(h, "me@microsoft.com")

    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
  })
})

describe("addresses that are already spoken for", () => {
  it("refuses one held as a mailbox or an alias", async () => {
    const h = harness({ directory: { addressTaken: async () => true } })
    const outcome = await create(h)

    expect(outcome.status).toBe("conflict")
  })

  it("refuses a second mailbox for the same person", async () => {
    const h = harness({ directory: { current: async () => mailbox("first@i10.tech") } })
    const outcome = await create(h)

    expect(outcome.status).toBe("conflict")
  })
})

describe("the plan's seats", () => {
  it("refuses when the allowance is used up", async () => {
    const h = harness({
      capacity: {
        check: async () => ({ status: "exceeded", remaining: 0, shortfall: 1 }),
      },
    })
    const outcome = await create(h)

    expect(outcome.status).toBe("limit")
  })

  /**
   * ⚠ `overage` IS NOT A REFUSAL. It means the plan allows the seat and it is
   * billable; treating it as a limit would turn every metered plan into a hard
   * cap and refuse a customer who was willing to pay.
   */
  it("allows a billable overage", async () => {
    const h = harness({
      capacity: {
        check: async () => ({
          status: "overage",
          included: 1,
          billable: 1,
          resetsAt: null,
        }),
      },
    })
    const outcome = await create(h)

    expect(outcome.status).toBe("created")
  })

  it("charges the tenant that owns the domain", async () => {
    const check = mock(async () => ({ status: "allowed" as const }))
    const h = harness({ capacity: { check } })
    await create(h)

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        featureId: "mailboxes",
        requested: 1,
      }),
    )
  })
})

describe("creating the mailbox", () => {
  it("adds the address, projects it, then activates", async () => {
    const order: string[] = []
    const h = harness({
      identity: {
        addVerifiedAddress: async () => {
          order.push("clerk")
        },
      },
      directory: {
        activate: async () => {
          order.push("activate")
          return mailbox()
        },
      },
      project: async () => {
        order.push("project")
        return { email: "me@i10.tech" }
      },
    })

    const outcome = await create(h)

    expect(outcome.status).toBe("created")
    expect(order).toEqual(["clerk", "project", "activate"])
  })

  /**
   * ⚠ `active` IS WHAT MAKES THE MAILBOX EXIST AS FAR AS authd IS CONCERNED.
   * Every one of its queries filters on it, so a mailbox created without this
   * accepts no mail and refuses its owner's login - the exact state the one
   * hand-made mailbox had to be repaired out of.
   */
  it("returns an active mailbox", async () => {
    const outcome = await create(harness())

    expect(outcome).toMatchObject({ status: "created", mailbox: { active: true } })
  })

  it("passes display_name through to the account row on activate", async () => {
    const h = harness({
      passwordEnabled: false,
      mailLane: "oidc",
    })
    const outcome = await create(h, "me@i10.tech", {
      display_name: "  Ada Lovelace  ",
    })

    expect(h.activate).toHaveBeenCalledWith("user_1", "Ada Lovelace")
    expect(outcome).toEqual({
      status: "created",
      mailbox: expect.objectContaining({
        address: "me@i10.tech",
        display_name: "Ada Lovelace",
        active: true,
      }),
    })
  })

  /** The projection is the only writer, so its refusal is authoritative. */
  it("fails when the projection declines to write a row", async () => {
    const h = harness({ project: async () => ({}) })
    const outcome = await create(h)

    expect(outcome.status).toBe("rejected")
    expect(h.activate).not.toHaveBeenCalled()
  })

  it("refuses a user Clerk does not have", async () => {
    const h = harness({ identity: { get: async () => null } })
    const outcome = await create(h)

    expect(outcome.status).toBe("rejected")
  })
})
