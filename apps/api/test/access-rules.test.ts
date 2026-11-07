import { describe, expect, test } from "bun:test"
import {
  cleanRules,
  coveringNames,
  isFreeMail,
  matchAccess,
  patternMatches,
  patternProblem,
  ruleFor,
  specificity,
  type AccessDomain,
} from "../src/console/access-rules.js"
import type { JoinRule } from "../src/db/core.js"

/**
 * Team access rules (#326): which rule an address falls under, and which
 * names and patterns may be used at all. Pure, so no database.
 */

const rule = (
  pattern: string,
  mode: JoinRule["mode"],
  role: JoinRule["role"] = "member",
): JoinRule => ({
  pattern,
  mode,
  role,
})

describe("patternMatches", () => {
  test("an exact pattern is that name only", () => {
    expect(patternMatches("pslhq.app", "pslhq.app")).toBe(true)
    expect(patternMatches("pslhq.app", "dev.pslhq.app")).toBe(false)
  })
  test("a wildcard is any subdomain at any depth, never the name itself", () => {
    expect(patternMatches("*.pslhq.app", "dev.pslhq.app")).toBe(true)
    expect(patternMatches("*.pslhq.app", "a.b.c.pslhq.app")).toBe(true)
    expect(patternMatches("*.pslhq.app", "pslhq.app")).toBe(false)
  })
  test("never a name that merely ends in the same letters", () => {
    expect(patternMatches("*.pslhq.app", "notpslhq.app")).toBe(false)
  })
})

describe("specificity", () => {
  test("exact beats wildcard at the same level; deeper beats shallower", () => {
    const order = ["dev.pslhq.app", "*.dev.pslhq.app", "pslhq.app", "*.pslhq.app"]
    const scores = order.map(specificity)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })
})

describe("ruleFor", () => {
  const rules = [
    rule("pslhq.app", "suggest"),
    rule("*.pslhq.app", "auto"),
    rule("dev.pslhq.app", "off"),
    rule("*.dev.pslhq.app", "auto", "admin"),
  ]
  test("the most specific rule wins", () => {
    expect(ruleFor(rules, "pslhq.app")?.mode).toBe("suggest")
    expect(ruleFor(rules, "eu.pslhq.app")?.mode).toBe("auto")
    // `off` on dev beats `auto` on *.pslhq.app.
    expect(ruleFor(rules, "dev.pslhq.app")?.mode).toBe("off")
    expect(ruleFor(rules, "x.dev.pslhq.app")?.role).toBe("admin")
  })
  test("nothing for a name no rule covers", () => {
    expect(ruleFor(rules, "other.app")).toBeNull()
  })
})

describe("patternProblem", () => {
  test("a pattern may be the domain, beneath it, or a wildcard beneath it", () => {
    expect(patternProblem("pslhq.app", "pslhq.app")).toBeNull()
    expect(patternProblem("dev.pslhq.app", "pslhq.app")).toBeNull()
    expect(patternProblem("*.pslhq.app", "pslhq.app")).toBeNull()
    expect(patternProblem("*.dev.pslhq.app", "pslhq.app")).toBeNull()
  })
  // ⚠ A PROOF COVERS ITS NAME AND SUBDOMAINS, NEVER ITS PARENT.
  test("never the parent of the proven name, or another name", () => {
    expect(patternProblem("pslhq.app", "notifications.pslhq.app")).not.toBeNull()
    expect(patternProblem("*.pslhq.app", "notifications.pslhq.app")).not.toBeNull()
    expect(patternProblem("other.app", "pslhq.app")).not.toBeNull()
    expect(patternProblem("*", "pslhq.app")).not.toBeNull()
    expect(patternProblem("*.app", "pslhq.app")).not.toBeNull()
  })
})

describe("cleanRules", () => {
  test("normalizes and keeps valid rules", () => {
    expect(
      cleanRules(
        [{ pattern: " DEV.pslhq.app ", mode: "auto", role: "admin" }],
        "pslhq.app",
      ),
    ).toEqual({ ok: true, rules: [rule("dev.pslhq.app", "auto", "admin")] })
  })
  test("refuses a duplicate pattern, a bad mode, a missing role", () => {
    expect(
      cleanRules([rule("pslhq.app", "auto"), rule("PSLHQ.app", "off")], "pslhq.app").ok,
    ).toBe(false)
    expect(
      cleanRules([{ pattern: "pslhq.app", mode: "on", role: "member" }], "pslhq.app")
        .ok,
    ).toBe(false)
    expect(cleanRules([{ pattern: "pslhq.app", mode: "auto" }], "pslhq.app").ok).toBe(
      false,
    )
  })

  // #335: our keys, written as ours; Clerk's two old keys read as ours.
  test("a role is member or admin, and is written as our key", () => {
    expect(
      cleanRules(
        [
          { pattern: "pslhq.app", mode: "suggest", role: "org:member" },
          { pattern: "*.pslhq.app", mode: "auto", role: "org:admin" },
        ],
        "pslhq.app",
      ),
    ).toEqual({
      ok: true,
      rules: [
        rule("pslhq.app", "suggest", "member"),
        rule("*.pslhq.app", "auto", "admin"),
      ],
    })
  })
  test("never owner, and never a role we do not have", () => {
    expect(
      cleanRules([{ pattern: "pslhq.app", mode: "auto", role: "owner" }], "pslhq.app"),
    ).toEqual({ ok: false, error: "A rule can't make anyone an owner." })
    for (const role of ["org:billing", "superadmin", "org:sys_memberships:manage"])
      expect(
        cleanRules([{ pattern: "pslhq.app", mode: "auto", role }], "pslhq.app"),
      ).toEqual({ ok: false, error: "A rule's role is member or admin." })
    expect(
      cleanRules([{ pattern: "pslhq.app", mode: "auto", role: " " }], "pslhq.app"),
    ).toEqual({ ok: false, error: "A rule needs a role." })
  })
})

describe("isFreeMail", () => {
  test("free-mail providers, their country variants and subdomains", () => {
    for (const name of [
      "gmail.com",
      "GMAIL.com",
      "outlook.com",
      "hotmail.co.uk",
      "yahoo.fr",
      "proton.me",
      "icloud.com",
      "mail.gmail.com",
    ])
      expect(isFreeMail(name)).toBe(true)
  })
  test("a parent that would cover one", () => {
    expect(isFreeMail("com.au")).toBe(true)
  })
  test("ordinary company domains are fine", () => {
    for (const name of ["pslhq.app", "acme.com", "dev.acme.co.uk", "livenation.com"])
      expect(isFreeMail(name)).toBe(false)
  })
})

describe("coveringNames", () => {
  test("the domain and each parent down to two labels", () => {
    expect(coveringNames("a.dev.pslhq.app")).toEqual([
      "a.dev.pslhq.app",
      "dev.pslhq.app",
      "pslhq.app",
    ])
  })
})

describe("matchAccess", () => {
  const acme: AccessDomain = {
    tenantId: "t_acme",
    clerkOrgId: "org_acme",
    name: "pslhq.app",
    rules: [rule("pslhq.app", "suggest"), rule("*.pslhq.app", "auto", "admin")],
  }

  test("each address takes its most specific rule", () => {
    expect(matchAccess([acme], ["a@pslhq.app"])).toEqual([
      {
        tenantId: "t_acme",
        clerkOrgId: "org_acme",
        email: "a@pslhq.app",
        pattern: "pslhq.app",
        mode: "suggest",
        role: "member",
      },
    ])
    expect(matchAccess([acme], ["a@x.y.pslhq.app"])[0]).toMatchObject({
      mode: "auto",
      role: "admin",
      pattern: "*.pslhq.app",
    })
  })

  test("across addresses, the strongest mode", () => {
    const [m] = matchAccess([acme], ["a@pslhq.app", "a@dev.pslhq.app"])
    expect(m).toMatchObject({ mode: "auto", email: "a@dev.pslhq.app" })
  })

  test("an off rule offers nothing", () => {
    const off: AccessDomain = { ...acme, rules: [rule("*.pslhq.app", "off")] }
    expect(matchAccess([off], ["a@dev.pslhq.app"])).toEqual([])
  })

  // ⚠ A ROW WRITTEN AROUND THE VALIDATION STILL CANNOT REACH ABOVE ITS PROOF.
  test("a proven subdomain never covers its parent", () => {
    const sub: AccessDomain = {
      ...acme,
      name: "notifications.pslhq.app",
      rules: [rule("pslhq.app", "auto"), rule("*.pslhq.app", "auto")],
    }
    expect(matchAccess([sub], ["a@pslhq.app", "b@dev.pslhq.app"])).toEqual([])
  })

  test("a free-mail address matches nothing, whatever the rows say", () => {
    const gmail: AccessDomain = {
      ...acme,
      name: "gmail.com",
      rules: [rule("gmail.com", "auto")],
    }
    expect(matchAccess([gmail], ["a@gmail.com"])).toEqual([])
  })
})
