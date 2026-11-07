import { describe, expect, it, mock } from "bun:test"
import { onMailAccessEvent } from "../src/mailboxes/revoke.js"

/**
 * The Clerk event behind "a member who leaves loses their mail login"
 * (mailboxes/revoke.ts). What the suspension itself does to `authd.accounts` is
 * proved against a real database in mail-signin-gaps-db.test.ts; this is the
 * part that reads the event.
 */

const deleted = (over: Record<string, unknown> = {}) => ({
  id: "orgmem_1",
  organization: { id: "org_acme" },
  public_user_data: { user_id: "user_ada" },
  ...over,
})

const world = (
  outcome: "suspended" | "already" | "no_mailbox" | "still_member" = "suspended",
) => {
  const memberLeft = mock(async () => outcome)
  const info = mock(() => {})
  return {
    memberLeft,
    info,
    deps: {
      revocation: { memberLeft },
      tenantOf: async (org: string) => (org === "org_acme" ? "ten-1" : null),
      log: { info },
    },
  }
}

describe("organizationMembership.deleted", () => {
  it("suspends the person's mailbox in the workspace that lost them", async () => {
    const w = world()
    expect(
      await onMailAccessEvent(w.deps, "organizationMembership.deleted", deleted()),
    ).toBe("mailbox:suspended")
    expect(w.memberLeft).toHaveBeenCalledWith("ten-1", "user_ada", "membership_removed")
  })

  it("says nothing for somebody with no mailbox here, or one who is a member again", async () => {
    for (const outcome of ["no_mailbox", "still_member", "already"] as const) {
      const w = world(outcome)
      expect(
        await onMailAccessEvent(w.deps, "organizationMembership.deleted", deleted()),
      ).toBeNull()
    }
  })

  it("does nothing for an organization we hold no workspace for", async () => {
    const w = world()
    expect(
      await onMailAccessEvent(
        w.deps,
        "organizationMembership.deleted",
        deleted({ organization: { id: "org_other" } }),
      ),
    ).toBeNull()
    expect(w.memberLeft).not.toHaveBeenCalled()
  })

  it("does nothing for a payload without a person or an organization", async () => {
    const w = world()
    for (const data of [
      null,
      {},
      deleted({ public_user_data: {} }),
      deleted({ organization: {} }),
    ])
      expect(
        await onMailAccessEvent(w.deps, "organizationMembership.deleted", data),
      ).toBeNull()
    expect(w.memberLeft).not.toHaveBeenCalled()
  })

  it("ignores every other event, including a membership created or changed", async () => {
    const w = world()
    for (const type of [
      "organizationMembership.created",
      "organizationMembership.updated",
      "organization.deleted",
      "user.updated",
    ])
      expect(await onMailAccessEvent(w.deps, type, deleted())).toBeNull()
    expect(w.memberLeft).not.toHaveBeenCalled()
  })

  // ⚠ THROWN, NOT SWALLOWED: the webhook answers 500 and Svix retries.
  it("lets a failure out", async () => {
    const w = world()
    w.memberLeft.mockRejectedValueOnce(new Error("database down"))
    await expect(
      onMailAccessEvent(w.deps, "organizationMembership.deleted", deleted()),
    ).rejects.toThrow("database down")
  })
})
