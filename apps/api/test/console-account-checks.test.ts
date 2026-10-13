import { describe, expect, test } from "bun:test"
import {
  PASSWORD_ATTEMPTS,
  checkPassword,
  classify,
  passwordAttempts,
} from "../src/console/password-check.js"
import { codeCooldown } from "../src/console/code-cooldown.js"
import {
  MANAGE_DOMAINS,
  answerJoinRequest,
  setTeamDomain,
  type TeamDomainDeps,
} from "../src/console/team-domains.js"
import { domainsOf, type JoinStore } from "../src/console/join.js"

describe("classify", () => {
  test("422 is a wrong password", () => {
    expect(classify({ status: 422, errors: [] })).toBe("wrong")
  })
  test("no_password_set is its own answer", () => {
    expect(classify({ status: 400, errors: [{ code: "no_password_set" }] })).toBe(
      "none",
    )
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

describe("setTeamDomain", () => {
  const calls: { name: string; on: boolean; clerkOrgId: string }[] = []
  const base: TeamDomainDeps = {
    verified: async () => ["acme.com"],
    can: async () => true,
    store: {
      set: async (
        _t: string,
        input: { name: string; on: boolean; clerkOrgId: string },
      ) => {
        calls.push(input)
        return "ok"
      },
    } as unknown as JoinStore,
    memberOrgIds: async () => [],
    describe: async () => ({}),
    addMember: async () => {},
  }
  const input = {
    tenantId: "t",
    userId: "u",
    orgId: "org_1",
    name: " ACME.com ",
    on: true,
  }

  test("turns on a verified domain, lowercased, for the session's organization", async () => {
    calls.length = 0
    expect(await setTeamDomain(base, input)).toBe("ok")
    expect(calls[0]).toEqual({ name: "acme.com", on: true, clerkOrgId: "org_1" })
  })
  test("refuses a domain this workspace has not verified", async () => {
    expect(await setTeamDomain(base, { ...input, name: "evil.com" })).toBe(
      "not_verified",
    )
  })
  test("only for somebody who can manage the organization's domains", async () => {
    let asked = ""
    const outcome = await setTeamDomain(
      {
        ...base,
        can: async (_u, _o, permission) => {
          asked = permission
          return false
        },
      },
      input,
    )
    expect(outcome).toBe("forbidden")
    expect(asked).toBe(MANAGE_DOMAINS)
  })
  test("turning off needs no verified domain", async () => {
    expect(await setTeamDomain(base, { ...input, name: "gone.com", on: false })).toBe(
      "ok",
    )
  })
  test("a personal workspace has no organization", async () => {
    expect(await setTeamDomain(base, { ...input, orgId: undefined })).toBe("no_org")
  })
})

describe("answerJoinRequest", () => {
  const pending = [
    { id: "req_1", user_id: "user_9", email: "b@acme.com", created_at: "x" },
  ]
  function deps(over: Partial<TeamDomainDeps> = {}) {
    const added: string[] = []
    const answered: boolean[] = []
    const d: TeamDomainDeps = {
      verified: async () => [],
      can: async () => true,
      store: {
        pending: async () => pending,
        answer: async (_t: string, _id: string, accept: boolean) => {
          answered.push(accept)
          return pending[0]!
        },
      } as unknown as JoinStore,
      memberOrgIds: async () => [],
      describe: async () => ({}),
      addMember: async (_org, userId) => void added.push(userId),
      ...over,
    }
    return { d, added, answered }
  }
  const input = {
    tenantId: "t",
    userId: "u",
    orgId: "org_1",
    id: "req_1",
    accept: true,
  }

  test("accepting adds the member in Clerk, then marks it answered", async () => {
    const { d, added, answered } = deps()
    expect(await answerJoinRequest(d, input)).toBe("ok")
    expect(added).toEqual(["user_9"])
    expect(answered).toEqual([true])
  })
  test("declining adds nobody", async () => {
    const { d, added, answered } = deps()
    expect(await answerJoinRequest(d, { ...input, accept: false })).toBe("ok")
    expect(added).toEqual([])
    expect(answered).toEqual([false])
  })
  test("a Clerk failure leaves the request open", async () => {
    const { d, answered } = deps({
      addMember: async () => {
        throw new Error("clerk down")
      },
    })
    await expect(answerJoinRequest(d, input)).rejects.toThrow("clerk down")
    expect(answered).toEqual([])
  })
  test("only for somebody who can manage members", async () => {
    const { d, added } = deps({ can: async () => false })
    expect(await answerJoinRequest(d, input)).toBe("forbidden")
    expect(added).toEqual([])
  })
  test("another workspace's request is not found", async () => {
    const { d } = deps()
    expect(await answerJoinRequest(d, { ...input, id: "req_other" })).toBe("missing")
  })
})

describe("domainsOf", () => {
  test("the domain of each address, lowercased, once, and never with a comma", () => {
    expect(domainsOf(["A@Acme.com", "b@acme.com", "c@x,y.com", "nope"])).toEqual([
      "acme.com",
    ])
  })
})
