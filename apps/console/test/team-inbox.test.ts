import { describe, expect, it } from "bun:test"
import type { ConsoleMailbox } from "../lib/mailbox-view"
import {
  DELETE_EFFECT,
  HOW_MEMBERS_USE_IT,
  MEMBER_LIMIT,
  candidatesFrom,
  hostedDomainNames,
  inboxName,
  memberCount,
  membersProblem,
  refusalTitle,
  removedMembers,
  sameMembers,
  teamInboxRefusal,
  withMember,
  withoutMember,
} from "../lib/team-inbox"
import type { DomainSummary } from "../lib/types"

const mailbox = (
  address: string,
  status: string,
  owner: { name: string | null } = { name: null },
  displayName: string | null = null,
): ConsoleMailbox =>
  ({
    address,
    displayName,
    owner: { userId: `user_${address}`, name: owner.name, email: address },
    status,
  }) as ConsoleMailbox

const refuse = (name: string, status: number, error = "") => ({ name, status, error })

describe("who can be picked", () => {
  it("leaves out a mailbox that was never set up and one being deleted, which the API refuses or will lose", () => {
    const picked = candidatesFrom([
      mailbox("a@acme.dev", "active", { name: "Ann" }),
      mailbox("b@acme.dev", "inactive", { name: "Ben" }),
      mailbox("c@acme.dev", "deleting", { name: "Cy" }),
    ])
    expect(picked.map((c) => c.address)).toEqual(["a@acme.dev"])
  })

  it("keeps a suspended or payment-held mailbox, because the API accepts them", () => {
    const picked = candidatesFrom([
      mailbox("s@acme.dev", "suspended"),
      mailbox("p@acme.dev", "payment_hold"),
      mailbox("o@acme.dev", "sso_required"),
    ])
    expect(picked).toHaveLength(3)
  })

  it("names a person by their name, then the mailbox's display name, then the address", () => {
    const named = Object.fromEntries(
      candidatesFrom([
        mailbox("x@acme.dev", "active", { name: "Xavier" }, "Shown"),
        mailbox("y@acme.dev", "active", { name: null }, "Why"),
        mailbox("z@acme.dev", "active"),
      ]).map((c) => [c.address, c.name]),
    )
    expect(named).toEqual({
      "x@acme.dev": "Xavier",
      "y@acme.dev": "Why",
      "z@acme.dev": "z@acme.dev",
    })
  })

  it("sorts by name, not by who was created first", () => {
    const picked = candidatesFrom([
      mailbox("1@acme.dev", "active", { name: "Zed" }),
      mailbox("2@acme.dev", "active", { name: "Amy" }),
    ])
    expect(picked.map((c) => c.name)).toEqual(["Amy", "Zed"])
  })

  it("answers the same empty list for no mailboxes, so a view can default to it", () => {
    expect(candidatesFrom([])).toBe(candidatesFrom([]))
  })
})

describe("hosted domains", () => {
  const domain = (name: string, mailboxes?: { enabled: boolean; owned: boolean }) =>
    ({ name, ...(mailboxes ? { mailboxes } : {}) }) as unknown as DomainSummary

  it("offers only domains that host mailboxes and that this workspace proved", () => {
    expect(
      hostedDomainNames([
        domain("a.dev", { enabled: true, owned: true }),
        domain("b.dev", { enabled: true, owned: false }),
        domain("c.dev", { enabled: false, owned: true }),
        domain("d.dev"),
      ]),
    ).toEqual(["a.dev"])
  })
})

describe("the member list", () => {
  it("compares as a set, in any order", () => {
    expect(sameMembers(["a", "b"], ["b", "a"])).toBe(true)
    expect(sameMembers(["a"], ["a", "b"])).toBe(false)
    expect(sameMembers(["a", "b"], ["a", "c"])).toBe(false)
  })

  it("needs at least one member and stops at the limit", () => {
    expect(membersProblem([])).toBe("A team inbox needs at least one member.")
    expect(membersProblem(["a"])).toBeNull()
    expect(
      membersProblem(Array.from({ length: MEMBER_LIMIT }, (_, i) => `${i}`)),
    ).toBeNull()
    expect(
      membersProblem(Array.from({ length: MEMBER_LIMIT + 1 }, (_, i) => `${i}`)),
    ).toContain(`${MEMBER_LIMIT}`)
  })

  it("adds once and removes cleanly, without changing what it was given", () => {
    const before = ["a", "b"]
    expect(withMember(before, "c")).toEqual(["a", "b", "c"])
    expect(withMember(before, "a")).toEqual(["a", "b"])
    expect(withoutMember(before, "a")).toEqual(["b"])
    expect(before).toEqual(["a", "b"])
  })

  it("lists who a save would take out, for the line that says they lose access", () => {
    expect(removedMembers(["a", "b", "c"], ["b", "d"])).toEqual(["a", "c"])
    expect(removedMembers(["a"], ["a", "b"])).toEqual([])
  })
})

describe("names and counts", () => {
  it("shows the display name, else the address", () => {
    expect(inboxName({ address: "s@acme.dev", display_name: "Support" })).toBe(
      "Support",
    )
    expect(inboxName({ address: "s@acme.dev", display_name: null })).toBe("s@acme.dev")
    expect(inboxName({ address: "s@acme.dev", display_name: "  " })).toBe("s@acme.dev")
  })

  it("counts in the singular for one", () => {
    expect(memberCount(1)).toBe("1 member")
    expect(memberCount(0)).toBe("0 members")
    expect(memberCount(12)).toBe("12 members")
  })
})

describe("refusals, in words", () => {
  it("tells an admin an address is taken and what to do", () => {
    const text = teamInboxRefusal(
      refuse("team_inbox_already_exists", 409, "That address is already taken."),
      "create",
    )
    expect(text).toContain("already taken")
    expect(text).toContain("Choose a different address")
  })

  it("gives the next step for a member whose mailbox is not active", () => {
    const text = teamInboxRefusal(
      refuse("validation_error", 422, "dan@acme.dev is not an active mailbox."),
      "members",
    )
    expect(text).toContain("dan@acme.dev")
    expect(text).toContain("Remove them from the list")
  })

  it("says a person outside the workspace cannot be in one", () => {
    const text = teamInboxRefusal(
      refuse("validation_error", 422, "x@acme.dev is not a member of this workspace."),
      "members",
    )
    expect(text).toContain("x@acme.dev")
    expect(text).toContain("not a member of this workspace")
  })

  it("points an unverified domain at the Domains page", () => {
    const text = teamInboxRefusal(
      refuse("validation_error", 422, "This workspace has not verified acme.com."),
      "create",
    )
    expect(text).toContain("acme.com")
    expect(text).toContain("Domains page")
  })

  it("explains that a team inbox needs a team workspace", () => {
    const text = teamInboxRefusal(
      refuse("validation_error", 422, "Team inboxes need a team workspace."),
      "create",
    )
    expect(text).toContain("team workspace")
  })

  it("keeps an unrecognised 422 as the API said it, ending in one full stop", () => {
    expect(
      teamInboxRefusal(refuse("validation_error", 422, "Something else"), "create"),
    ).toBe("Something else.")
  })

  it("says plainly that only an owner or admin manages them, for the member's 403", () => {
    for (const action of ["create", "members", "delete"] as const) {
      expect(teamInboxRefusal(refuse("forbidden", 403, "x"), action)).toContain(
        "Only an owner or admin",
      )
      expect(teamInboxRefusal(refuse("invalid_access", 403, "x"), action)).toContain(
        "Only an owner or admin",
      )
    }
  })

  it("tells a signed-out session to sign in, not that it lacks permission", () => {
    expect(teamInboxRefusal(refuse("invalid_access", 401, "x"), "members")).toContain(
      "Sign in again",
    )
  })

  it("says a vanished inbox is gone, and a missing domain is not available", () => {
    expect(teamInboxRefusal(refuse("not_found", 404, "x"), "delete")).toContain(
      "no longer exists",
    )
    expect(teamInboxRefusal(refuse("not_found", 404, "x"), "create")).toContain(
      "not available",
    )
  })

  it("says what a server failure left behind, per action", () => {
    expect(
      teamInboxRefusal(refuse("service_unavailable", 503, "x"), "create"),
    ).toContain("Nothing was created")
    expect(
      teamInboxRefusal(refuse("service_unavailable", 503, "x"), "delete"),
    ).toContain("Nothing was deleted")
    expect(
      teamInboxRefusal(refuse("service_unavailable", 503, "x"), "members"),
    ).toContain("not saved")
  })

  it("never shows a status code, a field name or a bare error name", () => {
    const cases = [
      refuse("team_inbox_already_exists", 409, "x"),
      refuse("validation_error", 422, "a@b.c is not an active mailbox."),
      refuse("forbidden", 403, "x"),
      refuse("not_found", 404, "x"),
      refuse("invalid_access", 401, "x"),
      refuse("internal_server_error", 501, "Team inboxes are not configured."),
      refuse("service_unavailable", 503, "x"),
      refuse("rate_limited", 429, "x"),
      refuse("weird", 418, ""),
    ]
    for (const failure of cases) {
      for (const action of ["create", "members", "delete"] as const) {
        const text = teamInboxRefusal(failure, action)
        expect(text).not.toMatch(/\b(401|403|404|409|422|429|501|503|418)\b/)
        expect(text).not.toMatch(/validation_error|invalid_access|team_inbox_/)
        expect(text.endsWith(".")).toBe(true)
      }
    }
  })

  it("titles each alert by what was being done", () => {
    expect(refusalTitle("create")).toBe("Could not create the team inbox")
    expect(refusalTitle("members")).toBe("Could not save the members")
    expect(refusalTitle("delete")).toBe("Could not delete the team inbox")
  })
})

describe("the copy", () => {
  it("says exactly what delete does to the mail", () => {
    expect(DELETE_EFFECT).toContain("destroys")
    expect(DELETE_EFFECT).toContain("Sent folder")
    expect(DELETE_EFFECT).toContain("bounce")
    expect(DELETE_EFFECT).toContain("cannot be undone")
  })

  it("says how members read it and send as it", () => {
    expect(HOW_MEMBERS_USE_IT).toContain("mail app")
    expect(HOW_MEMBERS_USE_IT).toContain("sender")
    expect(HOW_MEMBERS_USE_IT).toContain("Sent folder")
  })

  it("has no em dash in any of it", () => {
    // Built from its code point: the character itself may not appear in the repo.
    const dash = String.fromCodePoint(0x2014)
    expect(DELETE_EFFECT).not.toContain(dash)
    expect(HOW_MEMBERS_USE_IT).not.toContain(dash)
  })
})
