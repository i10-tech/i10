import { describe, expect, it } from "bun:test"
import {
  addAliasBlock,
  ALIAS_LIMIT,
  aliasAddress,
  aliasCountLine,
  aliasLocalProblem,
  aliasRefusal,
  aliasRefusalTitle,
  aliasSourceNote,
  consoleAliasCount,
  defaultAliasDomain,
  type MailboxAlias,
} from "../lib/mailbox-aliases"

const refusal = (name: string, status: number, error = "") => ({
  name,
  status,
  error,
})

describe("the part before the @", () => {
  it("accepts letters, digits and single separators in any case", () => {
    for (const ok of [
      "sales",
      "Sales",
      "a",
      "a1",
      "first.last",
      "a_b",
      "a-b",
      "a__b",
      "a--b",
    ]) {
      expect(aliasLocalProblem(ok)).toBeNull()
    }
  })

  it("accepts what the API accepts and the create dialog does not", () => {
    // The API only refuses `..`, so a doubled underscore or hyphen is an alias.
    expect(aliasLocalProblem("team__ops")).toBeNull()
  })

  it("refuses a plus with its own reason, not a generic one", () => {
    const problem = aliasLocalProblem("sales+eu")
    expect(problem).toContain("plus sign")
    expect(problem).toContain("never arrive")
  })

  it("refuses an edge separator, two dots, a space and a whole address", () => {
    for (const bad of [
      ".sales",
      "sales.",
      "-sales",
      "sales_",
      "a..b",
      "a b",
      "a@b.dev",
    ]) {
      expect(aliasLocalProblem(bad)).not.toBeNull()
    }
    expect(aliasLocalProblem("a..b")).toBe("No two dots in a row.")
    expect(aliasLocalProblem("a@acme.dev")).toContain("Only the part before the @")
  })

  it("allows 64 characters and refuses 65", () => {
    expect(aliasLocalProblem("a".repeat(64))).toBeNull()
    expect(aliasLocalProblem("a".repeat(65))).toContain("64 characters")
  })

  it("makes the address lowercase and trimmed", () => {
    expect(aliasAddress("  Sales ", "acme.dev")).toBe("sales@acme.dev")
  })
})

describe("where an alias came from", () => {
  it("says it in plain words and, for the ones that are not removable, why", () => {
    expect(aliasSourceNote("console")).toBe("Added here")
    expect(aliasSourceNote("clerk")).toContain("person's account")
    expect(aliasSourceNote("directory")).toContain("your directory")
    for (const source of ["clerk", "directory"] as const) {
      expect(aliasSourceNote(source).toLowerCase()).toContain("it there")
    }
  })

  it("counts only the ones added here, which is what the limit counts", () => {
    const aliases: MailboxAlias[] = [
      { address: "a@acme.dev", source: "console" },
      { address: "b@acme.dev", source: "clerk" },
      { address: "c@acme.dev", source: "directory" },
      { address: "d@acme.dev", source: "console" },
    ]
    expect(consoleAliasCount(aliases)).toBe(2)
  })
})

describe("the count against the limit", () => {
  it("is silent while there is plenty of room", () => {
    expect(aliasCountLine(0, ALIAS_LIMIT)).toBeNull()
    expect(aliasCountLine(ALIAS_LIMIT - 6, ALIAS_LIMIT)).toBeNull()
  })

  it("speaks when it is close, and says so at the limit", () => {
    expect(aliasCountLine(ALIAS_LIMIT - 5, ALIAS_LIMIT)).toBe(
      "25 of 30 aliases added here.",
    )
    expect(aliasCountLine(ALIAS_LIMIT, ALIAS_LIMIT)).toBe(
      "30 of 30 aliases added here.",
    )
  })

  it("follows the limit the API sent, not the one copied here", () => {
    expect(aliasCountLine(3, 3)).toBe("3 of 3 aliases added here.")
  })
})

describe("whether adding is open", () => {
  const open = {
    status: "active",
    added: 2,
    limit: ALIAS_LIMIT,
    domains: ["acme.dev"],
  }

  it("is open for a live mailbox with room and a domain", () => {
    expect(addAliasBlock(open)).toBeNull()
  })

  it("is closed during a deletion grace, and says removing still works", () => {
    const reason = addAliasBlock({ ...open, status: "deleting" })
    expect(reason).toContain("being deleted")
    expect(reason).toContain("Removing an alias still works")
  })

  it("is closed at the limit, and says what to do", () => {
    expect(addAliasBlock({ ...open, added: ALIAS_LIMIT })).toContain("Remove one")
  })

  it("is closed with no hosted domain", () => {
    expect(addAliasBlock({ ...open, domains: [] })).toContain("Turn it on for a domain")
  })

  it("gives the deletion reason first when several apply", () => {
    expect(addAliasBlock({ ...open, status: "deleting", domains: [] })).toContain(
      "being deleted",
    )
  })

  it("stays open for a suspended mailbox, which the API accepts", () => {
    expect(addAliasBlock({ ...open, status: "suspended" })).toBeNull()
  })
})

describe("the domain the dialog starts on", () => {
  it("is the mailbox's own when it is hosted", () => {
    expect(defaultAliasDomain(["a.dev", "acme.dev"], "acme.dev")).toBe("acme.dev")
  })

  it("is the first hosted one otherwise, and empty when there is none", () => {
    expect(defaultAliasDomain(["a.dev", "b.dev"], "acme.dev")).toBe("a.dev")
    expect(defaultAliasDomain([], "acme.dev")).toBe("")
  })
})

describe("a refusal in words", () => {
  it("never shows a raw code", () => {
    const cases: [string, number][] = [
      ["alias_taken", 409],
      ["alias_limit_reached", 409],
      ["alias_not_removable", 409],
      ["mailbox_deleting", 409],
      ["forbidden", 403],
      ["not_found", 404],
      ["internal_server_error", 501],
    ]
    for (const [name, status] of cases) {
      for (const action of ["add", "remove"] as const) {
        const text = aliasRefusal(refusal(name, status), action)
        expect(text).not.toContain(name)
        expect(text).not.toMatch(/\b(409|403|404|501)\b/)
        expect(text.endsWith(".")).toBe(true)
      }
    }
  })

  it("says an address is taken and what to do", () => {
    const text = aliasRefusal(
      refusal("alias_taken", 409, "That address is already taken."),
      "add",
    )
    expect(text).toContain("already in use")
    expect(text).toContain("Choose a different one")
  })

  it("gives the limit as a number from one place", () => {
    expect(aliasRefusal(refusal("alias_limit_reached", 409), "add")).toContain(
      `${ALIAS_LIMIT} aliases`,
    )
  })

  it("says a directory's alias is removed there, not that the request failed", () => {
    const text = aliasRefusal(refusal("alias_not_removable", 409), "remove")
    expect(text).toContain("removed there")
    expect(text).toContain("account")
    expect(text).toContain("directory")
  })

  it("keeps the API's sentence for a domain that is not hosted, ending in one full stop", () => {
    const text = aliasRefusal(
      refusal(
        "validation_error",
        422,
        "This workspace does not host mailboxes on that domain. Turn on mailboxes for the domain first.",
      ),
      "add",
    )
    expect(text).toBe(
      "This workspace does not host mailboxes on that domain. Turn on mailboxes for the domain first.",
    )
    expect(aliasRefusal(refusal("validation_error", 422, "Too long"), "add")).toBe(
      "Too long.",
    )
  })

  it("tells the two missing things apart by the action", () => {
    expect(aliasRefusal(refusal("not_found", 404), "remove")).toContain(
      "no longer an alias",
    )
    expect(aliasRefusal(refusal("not_found", 404), "add")).toContain("no longer exists")
  })

  it("says an ended session and a busy server in their own words", () => {
    expect(aliasRefusal(refusal("invalid_access", 401), "add")).toContain(
      "Sign in again",
    )
    expect(aliasRefusal(refusal("x", 429), "add")).toContain("too fast")
    const down = aliasRefusal(refusal("internal_server_error", 501), "remove")
    expect(down).toContain("problem on our side")
    expect(down).toContain("remove the alias")
  })

  it("titles the alert by what was being done", () => {
    expect(aliasRefusalTitle("add")).toBe("Could not add the alias")
    expect(aliasRefusalTitle("remove")).toBe("Could not remove the alias")
  })
})
