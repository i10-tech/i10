import { describe, expect, it, mock } from "bun:test"
import type { Mailbox, MailboxCreationMode } from "@repo/contracts"
import {
  mailboxProvisioning,
  type MailboxDirectory,
  type MailboxIdentity,
} from "../src/mailboxes/provision.js"
import type { ClerkUser } from "../src/projection/clerk-user.js"

/**
 * Who may create a mailbox, by the workspace's mode, and an admin creating one
 * for a member. The core only: the routes are in console-mailbox-admin.test.ts.
 */

const ACME = "3f1a0e00-0000-4000-8000-000000000001"
const OTHER = "3f1a0e00-0000-4000-8000-000000000002"

const person = (id: string, passwordEnabled = true) => ({
  user: {
    id,
    primary_email_address_id: "idn_1",
    first_name: "Pat",
    last_name: null,
    updated_at: 1_700_000_000_000,
    email_addresses: [
      {
        id: "idn_1",
        email_address: "pat@example.org",
        verification: { status: "verified" },
      },
    ],
  } satisfies ClerkUser,
  passwordEnabled,
})

const mailbox = (address: string): Mailbox => ({
  object: "mailbox",
  address,
  display_name: null,
  active: true,
  created_at: new Date(0).toISOString(),
})

function harness(
  over: {
    mode?: MailboxCreationMode
    admins?: string[]
    owners?: Record<string, string | null>
    passwordEnabled?: boolean
    wireMode?: boolean
  } = {},
) {
  const addVerifiedAddress = mock<MailboxIdentity["addVerifiedAddress"]>(async () => {})
  const addressTaken = mock(async () => false)
  const identity: MailboxIdentity = {
    get: async (id) => person(id, over.passwordEnabled ?? true),
    addVerifiedAddress,
  }
  const directory: MailboxDirectory = {
    domainOwner: async (domain) =>
      (over.owners ?? { "acme.test": ACME })[domain] ?? null,
    addressTaken,
    current: async () => null,
    activate: async () => mailbox("pat@acme.test"),
  }
  const provisioning = mailboxProvisioning({
    identity,
    directory,
    capacity: { check: async () => ({ status: "allowed" }) },
    project: async () => ({ email: "pat@acme.test" }),
    featureId: "mailboxes",
    // `admins` administer ACME and nothing else.
    canAllocate: async (userId, tenantId) =>
      tenantId === ACME && (over.admins ?? []).includes(userId),
    ...(over.wireMode === false
      ? {}
      : { creationMode: async () => over.mode ?? "admins" }),
  })
  return { provisioning, addVerifiedAddress, addressTaken }
}

const input = { address: "pat@acme.test" }

describe("creating your own mailbox, by mode", () => {
  it("refuses a member while the mode is admins, before looking at the address", async () => {
    const h = harness({ mode: "admins" })
    const outcome = await h.provisioning.create("user_member", input)

    expect(outcome).toMatchObject({ status: "forbidden" })
    expect(h.addressTaken).not.toHaveBeenCalled()
    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
  })

  it("lets an admin create their own while the mode is admins", async () => {
    const h = harness({ mode: "admins", admins: ["user_admin"] })
    expect((await h.provisioning.create("user_admin", input)).status).toBe("created")
  })

  for (const mode of ["members", "on_join"] as const) {
    it(`lets a member create their own in ${mode} mode`, async () => {
      const h = harness({ mode })
      expect((await h.provisioning.create("user_member", input)).status).toBe("created")
    })
  }

  it("enforces nothing when no mode is wired", async () => {
    const h = harness({ wireMode: false })
    expect((await h.provisioning.create("user_member", input)).status).toBe("created")
  })

  it("refuses a member a role address in any mode, tag or case aside", async () => {
    for (const address of ["postmaster@acme.test", "Admin+x@acme.test"]) {
      const h = harness({ mode: "members" })
      const outcome = await h.provisioning.create("user_member", { address })
      expect(outcome.status).toBe("forbidden")
      expect(h.addVerifiedAddress).not.toHaveBeenCalled()
    }
  })

  it("lets an admin take a role address, for themselves or for a member", async () => {
    const h = harness({ mode: "members", admins: ["user_admin"] })
    const role = { address: "billing@acme.test" }
    expect((await h.provisioning.create("user_admin", role)).status).toBe("created")
    const forMember = await h.provisioning.create("user_member", role, {
      actorId: "user_admin",
      tenantId: ACME,
    })
    expect(forMember.status).toBe("created")
  })

  it("asks about the workspace that owns the domain, not the caller's", async () => {
    // An admin of ACME is nobody's admin on a domain OTHER hosts.
    const h = harness({
      mode: "admins",
      admins: ["user_admin"],
      owners: { "other.test": OTHER },
    })
    const outcome = await h.provisioning.create("user_admin", {
      address: "pat@other.test",
    })
    expect(outcome.status).toBe("forbidden")
  })
})

describe("an admin creating a mailbox for a member", () => {
  const byAdmin = { actorId: "user_admin", tenantId: ACME }

  it("creates it, and the address goes on the member's Clerk user", async () => {
    const h = harness({ mode: "admins", admins: ["user_admin"] })
    const outcome = await h.provisioning.create("user_member", input, byAdmin)

    expect(outcome.status).toBe("created")
    expect(h.addVerifiedAddress).toHaveBeenCalledWith({
      userId: "user_member",
      address: "pat@acme.test",
    })
  })

  it("works in every mode, including members", async () => {
    for (const mode of ["admins", "members", "on_join"] as const) {
      const h = harness({ mode, admins: ["user_admin"] })
      expect((await h.provisioning.create("user_member", input, byAdmin)).status).toBe(
        "created",
      )
    }
  })

  it("refuses an actor who does not administer the workspace, even from a route that forgot to check", async () => {
    const h = harness({ mode: "members", admins: [] })
    const outcome = await h.provisioning.create("user_member", input, byAdmin)

    expect(outcome.status).toBe("forbidden")
    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
  })

  it("answers an address on another workspace's domain like one nobody hosts", async () => {
    const h = harness({
      admins: ["user_admin"],
      owners: { "acme.test": ACME, "other.test": OTHER },
    })
    const other = await h.provisioning.create(
      "user_member",
      { address: "pat@other.test" },
      byAdmin,
    )
    const nobody = await h.provisioning.create(
      "user_member",
      { address: "pat@nowhere.test" },
      byAdmin,
    )

    expect(other.status).toBe("rejected")
    expect(nobody.status).toBe("rejected")
    expect(h.addVerifiedAddress).not.toHaveBeenCalled()
  })

  it("lets the admin size the inbox, which the member could not", async () => {
    // No storage is wired here, so a request for one is refused for that reason,
    // and only after the admin check has passed.
    const h = harness({ admins: ["user_admin"] })
    const outcome = await h.provisioning.create(
      "user_member",
      { ...input, storage_allocation: 1024 },
      byAdmin,
    )
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("not configured"),
    })
  })

  it("names the member, not the admin, when the member cannot sign in to mail", async () => {
    const h = harness({ admins: ["user_admin"], passwordEnabled: false })
    const outcome = await h.provisioning.create("user_member", input, byAdmin)

    expect(outcome).toMatchObject({
      status: "password_required",
      reason: expect.stringContaining("This person"),
    })
  })
})
