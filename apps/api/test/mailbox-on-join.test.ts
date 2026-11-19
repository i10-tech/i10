import { describe, expect, it, mock } from "bun:test"
import type { MailboxCreationMode } from "@repo/contracts"
import { deriveLocalPart, onMailJoinEvent } from "../src/mailboxes/on-join.js"
import type { MailJoinDeps } from "../src/mailboxes/on-join.js"
import type { ProvisionOutcome } from "../src/mailboxes/provision.js"
import type { ClerkUser } from "../src/projection/clerk-user.js"

/**
 * `on_join`: what a new membership does to the mailbox side, and everything it
 * must leave alone. The join itself is never at stake here, so the cases are
 * about what is skipped and that nothing throws.
 */

const TENANT = "3f1a0e00-0000-4000-8000-000000000001"

const event = (orgId = "org_acme", userId = "user_pat") => ({
  organization: { id: orgId },
  public_user_data: { user_id: userId },
})

const user = (email: string | null, verified = true): ClerkUser => ({
  id: "user_pat",
  primary_email_address_id: email ? "idn_1" : null,
  first_name: "Pat",
  last_name: null,
  updated_at: 1_700_000_000_000,
  email_addresses: email
    ? [
        {
          id: "idn_1",
          email_address: email,
          verification: { status: verified ? "verified" : "unverified" },
        },
      ]
    : [],
})

function harness(
  over: {
    mode?: MailboxCreationMode
    domains?: string[]
    email?: string | null
    verified?: boolean
    existing?: boolean
    outcome?: ProvisionOutcome
    tenant?: string | null
    throws?: boolean
  } = {},
) {
  const create = mock<MailJoinDeps["provisioning"]["create"]>(async () => {
    if (over.throws) throw new Error("clerk is down")
    return (
      over.outcome ?? {
        status: "created" as const,
        mailbox: {
          object: "mailbox" as const,
          address: "pat@acme.test",
          display_name: null,
          active: true,
          created_at: new Date(0).toISOString(),
        },
      }
    )
  })
  const log = { info: mock(() => {}), warn: mock(() => {}) }
  const deps: MailJoinDeps = {
    tenantOf: async () => (over.tenant === undefined ? TENANT : over.tenant),
    mode: async () => over.mode ?? "on_join",
    hostedDomains: async () => over.domains ?? ["acme.test"],
    identity: {
      get: async () => ({
        user: user(
          over.email === undefined ? "Pat@Example.org" : over.email,
          over.verified ?? true,
        ),
        passwordEnabled: true,
      }),
    },
    provisioning: {
      create,
      current: async () =>
        over.existing
          ? {
              object: "mailbox" as const,
              address: "pat@acme.test",
              display_name: null,
              active: true,
              created_at: new Date(0).toISOString(),
            }
          : null,
    },
    log,
  }
  const run = (type = "organizationMembership.created", data: unknown = event()) =>
    onMailJoinEvent(deps, type, data)
  return { run, create, log }
}

describe("deriveLocalPart", () => {
  it("lowercases and drops a +tag, and nothing else", () => {
    expect(deriveLocalPart("Pat.Smith+news@example.org")).toBe("pat.smith")
    expect(deriveLocalPart("pat_smith-2@example.org")).toBe("pat_smith-2")
  })

  it("gives up on anything it would have to repair", () => {
    for (const email of [
      "pat..smith@example.org",
      ".pat@example.org",
      "pat.@example.org",
      "+tag@example.org",
      "päť@example.org",
      '"pat smith"@example.org',
      `${"a".repeat(65)}@example.org`,
      "no-at-sign",
      "@example.org",
    ]) {
      expect(deriveLocalPart(email)).toBeNull()
    }
  })
})

describe("a new membership in on_join mode", () => {
  it("makes the mailbox on the one hosted domain from the primary address's local part", async () => {
    const h = harness()

    expect(await h.run()).toBe("mailbox:created")
    expect(h.create).toHaveBeenCalledWith(
      "user_pat",
      { address: "pat@acme.test" },
      { tenantId: TENANT },
    )
  })

  it("is idempotent: a redelivery finds the mailbox and makes nothing", async () => {
    const h = harness({ existing: true })

    expect(await h.run()).toBe("mailbox:skipped:has_mailbox")
    expect(h.create).not.toHaveBeenCalled()
  })

  it("skips, and says why, on a collision or any other refusal - it never tries a second address", async () => {
    for (const status of [
      "conflict",
      "limit",
      "password_required",
      "rejected",
    ] as const) {
      const h = harness({ outcome: { status, reason: "no" } })

      expect(await h.run()).toBe(`mailbox:skipped:${status}`)
      expect(h.create).toHaveBeenCalledTimes(1)
    }
  })

  it("does nothing with several hosted domains, or none", async () => {
    const many = harness({ domains: ["acme.test", "acme.io"] })
    const none = harness({ domains: [] })

    expect(await many.run()).toBe("mailbox:skipped:many_domains")
    expect(await none.run()).toBe("mailbox:skipped:no_domain")
    expect(many.create).not.toHaveBeenCalled()
    expect(none.create).not.toHaveBeenCalled()
  })

  it("does nothing when there is no verified primary address or no clean local part", async () => {
    for (const over of [
      { email: null },
      { email: "pat@example.org", verified: false },
      { email: "pat..x@example.org" },
    ]) {
      const h = harness(over)
      expect(await h.run()).toMatch(/^mailbox:skipped:/)
      expect(h.create).not.toHaveBeenCalled()
    }
  })
})

describe("everything else is left alone", () => {
  it("ignores the other modes without even looking at domains", async () => {
    for (const mode of ["admins", "members"] as const) {
      const h = harness({ mode })
      expect(await h.run()).toBeNull()
      expect(h.create).not.toHaveBeenCalled()
    }
  })

  it("ignores other events, other workspaces and malformed payloads", async () => {
    const h = harness()

    expect(await h.run("organizationMembership.deleted")).toBeNull()
    expect(await h.run("user.created")).toBeNull()
    expect(await h.run("organizationMembership.created", {})).toBeNull()
    expect(await h.run("organizationMembership.created", null)).toBeNull()
    expect(await harness({ tenant: null }).run()).toBeNull()
    expect(h.create).not.toHaveBeenCalled()
  })

  it("never throws, so it cannot fail the join", async () => {
    const h = harness({ throws: true })

    expect(await h.run()).toBe("mailbox:error")
    expect(h.log.warn).toHaveBeenCalledTimes(1)
  })
})
