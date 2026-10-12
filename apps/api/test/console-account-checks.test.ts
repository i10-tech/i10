import { describe, expect, test } from "bun:test"
import {
  PASSWORD_ATTEMPTS,
  checkPassword,
  classify,
  passwordAttempts,
} from "../src/console/password-check.js"
import { codeCooldown } from "../src/console/code-cooldown.js"
import { claimTeamDomain } from "../src/console/team-domains.js"

describe("classify", () => {
  test("422 is a wrong password", () => {
    expect(classify({ status: 422, errors: [] })).toBe("wrong")
  })
  test("no_password_set is its own answer", () => {
    expect(classify({ status: 400, errors: [{ code: "no_password_set" }] })).toBe("none")
  })
  test("an outage is never wrong", () => {
    expect(classify({ status: 429 })).toBe("unavailable")
    expect(classify({ status: 503 })).toBe("unavailable")
    expect(classify(new Error("timeout"))).toBe("unavailable")
  })
})

describe("checkPassword", () => {
  test("verified when Clerk resolves", async () => {
    const verdict = await checkPassword(
      { verify: async () => ({ verified: true }), allow: async () => true },
      "user_1",
      "pw",
    )
    expect(verdict).toBe("verified")
  })
  test("limited before Clerk is asked", async () => {
    let asked = false
    const verdict = await checkPassword(
      {
        verify: async () => {
          asked = true
        },
        allow: async () => false,
      },
      "user_1",
      "pw",
    )
    expect(verdict).toBe("limited")
    expect(asked).toBe(false)
  })
})

describe("passwordAttempts", () => {
  test("the local window still limits when Redis is down", async () => {
    const broken = {
      incr: async () => {
        throw new Error("down")
      },
      expire: async () => 0,
    }
    const allow = passwordAttempts(broken)
    for (let i = 0; i < PASSWORD_ATTEMPTS; i++) expect(await allow("u")).toBe(true)
    expect(await allow("u")).toBe(false)
    expect(await allow("someone-else")).toBe(true)
  })
  test("Redis counts and sets the window once", async () => {
    const counts = new Map<string, number>()
    let expiries = 0
    const allow = passwordAttempts({
      incr: async (key) => {
        const next = (counts.get(key) ?? 0) + 1
        counts.set(key, next)
        return next
      },
      expire: async () => {
        expiries++
      },
    })
    for (let i = 0; i < PASSWORD_ATTEMPTS; i++) await allow("u")
    expect(await allow("u")).toBe(false)
    expect(expiries).toBe(1)
  })
})

describe("codeCooldown", () => {
  test("one send per window, and the wait is reported", async () => {
    const reserve = codeCooldown(null, 60)
    expect(await reserve("u", "step-up:email")).toEqual({ ok: true, retryAfter: 60 })
    const again = await reserve("u", "step-up:email")
    expect(again.ok).toBe(false)
    expect(again.retryAfter).toBeGreaterThan(0)
    expect((await reserve("u", "email:abc")).ok).toBe(true)
  })
  test("Redis answers with its own ttl", async () => {
    const reserve = codeCooldown({ set: async () => null, ttl: async () => 42 })
    expect(await reserve("u", "x")).toEqual({ ok: false, retryAfter: 42 })
  })
})

describe("claimTeamDomain", () => {
  const base = {
    verified: async () => ["acme.com"],
    canManage: async () => true,
    create: async () => {},
  }
  test("only a domain this workspace verified", async () => {
    const outcome = await claimTeamDomain(base, {
      tenantId: "t",
      userId: "u",
      orgId: "org_1",
      name: "evil.com",
    })
    expect(outcome).toBe("not_verified")
  })
  test("only an admin", async () => {
    const outcome = await claimTeamDomain(
      { ...base, canManage: async () => false },
      { tenantId: "t", userId: "u", orgId: "org_1", name: "ACME.com" },
    )
    expect(outcome).toBe("forbidden")
  })
  test("created, case-insensitively", async () => {
    let made = ""
    const outcome = await claimTeamDomain(
      { ...base, create: async (_org, name) => void (made = name) },
      { tenantId: "t", userId: "u", orgId: "org_1", name: " Acme.com " },
    )
    expect(outcome).toBe("created")
    expect(made).toBe("acme.com")
  })
  test("a personal workspace has no organization", async () => {
    expect(
      await claimTeamDomain(base, { tenantId: "t", userId: "u", name: "acme.com" }),
    ).toBe("no_org")
  })
})
