import { describe, expect, test } from "bun:test"
import {
  MANAGE_DOMAINS,
  MANAGE_MEMBERS,
  addAccessDomain,
  allowAddress,
  answerJoinRequest,
  autoJoin,
  autoJoinFromWebhook,
  joinNow,
  listAccess,
  offersFor,
  removeTeamMember,
  requestToJoin,
  setAccessRules,
} from "../src/console/team-domains.js"
import type { JoinRule } from "../src/db/core.js"
import { ACME, deps } from "./team-access-fixtures.js"

/**
 * Team access (#326) - the decisions, against an in-memory store: who is
 * offered what, the removed and block lists by EMAIL ADDRESS, auto-join at
 * sign-up (idempotent, verified addresses only, a full workspace becoming a
 * request), and answering requests. The SQL and its policies are
 * join-db.test.ts.
 */

const seeker = (emails: string[], userId = "user_new") => ({
  currentTenantId: "00000000-0000-0000-0000-000000000000",
  userId,
  emails,
})

const admin = { tenantId: ACME.tenantId, userId: "user_admin", orgId: ACME.orgId }

describe("offersFor", () => {
  const rules: JoinRule[] = [
    { pattern: "pslhq.app", mode: "suggest", role: "org:member" },
    { pattern: "*.pslhq.app", mode: "auto", role: "org:member" },
  ]

  test("verified addresses only ever come from the caller; a stranger gets nothing", async () => {
    const { d } = deps(rules)
    expect(
      await offersFor(d, { ...seeker(["a@elsewhere.app"]), exceptOrgIds: [] }),
    ).toEqual([])
  })

  test("a removed address may only ask, never auto-join", async () => {
    const { d, exclusions } = deps(rules)
    exclusions.set("a@dev.pslhq.app", "removed")
    const [offer] = await offersFor(d, {
      ...seeker(["a@dev.pslhq.app"]),
      exceptOrgIds: [],
    })
    expect(offer).toMatchObject({ mode: "suggest", removed: true })
  })

  test("a blocked address is offered nothing, whichever address they use", async () => {
    const { d, exclusions } = deps(rules)
    exclusions.set("a@dev.pslhq.app", "blocked")
    expect(
      await offersFor(d, {
        ...seeker(["a@dev.pslhq.app", "a@pslhq.app"]),
        exceptOrgIds: [],
      }),
    ).toEqual([])
  })

  // ⚠ KEYED BY ADDRESS: a new account with the same address is the same person.
  test("the lists follow the address across a new account", async () => {
    const { d, exclusions } = deps(rules)
    exclusions.set("a@dev.pslhq.app", "blocked")
    expect(
      await offersFor(d, {
        ...seeker(["A@dev.pslhq.app"], "user_brand_new"),
        exceptOrgIds: [],
      }),
    ).toEqual([])
  })
})

describe("requestToJoin", () => {
  test("files a request with the matching address and rule; once", async () => {
    const { d, requests } = deps([
      { pattern: "pslhq.app", mode: "suggest", role: "org:member" },
    ])
    const input = { ...seeker(["a@pslhq.app"]), tenantId: ACME.tenantId }
    expect(await requestToJoin(d, input)).toBe("created")
    expect(await requestToJoin(d, input)).toBe("exists")
    expect(requests[0]).toMatchObject({
      email: "a@pslhq.app",
      via: "pslhq.app",
      full: false,
    })
  })
  test("blocked: no request", async () => {
    const { d, exclusions } = deps([
      { pattern: "pslhq.app", mode: "suggest", role: "org:member" },
    ])
    exclusions.set("a@pslhq.app", "blocked")
    expect(
      await requestToJoin(d, { ...seeker(["a@pslhq.app"]), tenantId: ACME.tenantId }),
    ).toBe("not_suggested")
  })
  test("off: no request", async () => {
    const { d } = deps([{ pattern: "pslhq.app", mode: "off", role: "org:member" }])
    expect(
      await requestToJoin(d, { ...seeker(["a@pslhq.app"]), tenantId: ACME.tenantId }),
    ).toBe("not_suggested")
  })
})

describe("joinNow", () => {
  const auto: JoinRule[] = [{ pattern: "*.pslhq.app", mode: "auto", role: "org:admin" }]

  test("adds an existing user at once with the rule's role, and records how", async () => {
    const { d, added, joins } = deps(auto)
    const out = await joinNow(d, {
      ...seeker(["a@dev.pslhq.app"]),
      tenantId: ACME.tenantId,
    })
    expect(out).toEqual({ outcome: "joined", orgId: ACME.orgId })
    expect(added).toEqual([
      { orgId: ACME.orgId, userId: "user_new", role: "org:admin" },
    ])
    expect(joins[0]).toMatchObject({ how: "join", via: "*.pslhq.app" })
  })
  test("a removed person cannot instant-join", async () => {
    const { d, added, exclusions } = deps(auto)
    exclusions.set("a@dev.pslhq.app", "removed")
    const out = await joinNow(d, {
      ...seeker(["a@dev.pslhq.app"]),
      tenantId: ACME.tenantId,
    })
    expect(out).toEqual({ outcome: "not_offered" })
    expect(added).toEqual([])
  })
  test("suggest-only cannot instant-join", async () => {
    const { d } = deps([
      { pattern: "*.pslhq.app", mode: "suggest", role: "org:member" },
    ])
    const out = await joinNow(d, {
      ...seeker(["a@dev.pslhq.app"]),
      tenantId: ACME.tenantId,
    })
    expect(out).toEqual({ outcome: "not_offered" })
  })
  test("a full workspace files a request instead", async () => {
    const { d, requests } = deps(auto, { full: true })
    const out = await joinNow(d, {
      ...seeker(["a@dev.pslhq.app"]),
      tenantId: ACME.tenantId,
    })
    expect(out).toEqual({ outcome: "full" })
    expect(requests[0]).toMatchObject({ full: true, email: "a@dev.pslhq.app" })
  })
})

describe("autoJoin at sign-up", () => {
  const auto: JoinRule[] = [{ pattern: "pslhq.app", mode: "auto", role: "org:member" }]

  test("joins once however often it runs", async () => {
    const { d, added } = deps(auto)
    expect(await autoJoin(d, seeker(["new@pslhq.app"]))).toEqual([
      { tenantId: ACME.tenantId, orgId: ACME.orgId, outcome: "joined" },
    ])
    expect(await autoJoin(d, seeker(["new@pslhq.app"]))).toEqual([])
    expect(added).toHaveLength(1)
  })

  test("somebody who left is not pulled back in", async () => {
    const { d, added } = deps(auto)
    await autoJoin(d, seeker(["new@pslhq.app"]))
    // They leave in Clerk; our join record stays.
    const left = { ...d, memberOrgIds: async () => [] }
    expect(await autoJoin(left, seeker(["new@pslhq.app"]))).toEqual([])
    expect(added).toHaveLength(1)
  })

  test("full: a request, filed once", async () => {
    const { d, requests } = deps(auto, { full: true })
    expect(await autoJoin(d, seeker(["new@pslhq.app"]))).toEqual([
      { tenantId: ACME.tenantId, orgId: ACME.orgId, outcome: "full" },
    ])
    expect(await autoJoin(d, seeker(["new@pslhq.app"]))).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.full).toBe(true)
  })

  test("removed or blocked addresses are not auto-joined", async () => {
    for (const kind of ["removed", "blocked"] as const) {
      const { d, added, exclusions } = deps(auto)
      exclusions.set("new@pslhq.app", kind)
      expect(await autoJoin(d, seeker(["new@pslhq.app"]))).toEqual([])
      expect(added).toEqual([])
    }
  })
})

describe("autoJoinFromWebhook", () => {
  const auto: JoinRule[] = [{ pattern: "pslhq.app", mode: "auto", role: "org:member" }]
  const payload = (status: string) => ({
    id: "user_w",
    email_addresses: [{ email_address: "W@pslhq.app", verification: { status } }],
  })

  test("only VERIFIED addresses from Clerk's payload", async () => {
    const { d, added } = deps(auto)
    expect(await autoJoinFromWebhook(d, payload("unverified"))).toBeNull()
    expect(added).toEqual([])
    expect(await autoJoinFromWebhook(d, payload("verified"))).toBe(
      `joined:${ACME.orgId}`,
    )
    expect(added[0]).toMatchObject({ userId: "user_w" })
  })

  test("a redelivery changes nothing", async () => {
    const { d, added } = deps(auto)
    await autoJoinFromWebhook(d, payload("verified"))
    expect(await autoJoinFromWebhook(d, payload("verified"))).toBeNull()
    expect(added).toHaveLength(1)
  })

  test("a malformed payload is ignored", async () => {
    const { d } = deps(auto)
    expect(await autoJoinFromWebhook(d, null)).toBeNull()
    expect(await autoJoinFromWebhook(d, { email_addresses: [] })).toBeNull()
  })
})

describe("answerJoinRequest", () => {
  const rules: JoinRule[] = [
    { pattern: "pslhq.app", mode: "suggest", role: "org:member" },
    { pattern: "*.pslhq.app", mode: "suggest", role: "org:admin" },
  ]

  async function withRequest(
    over: Parameters<typeof deps>[1] = {},
    email = "a@dev.pslhq.app",
  ) {
    const t = deps(rules, over)
    await requestToJoin(t.d, { ...seeker([email]), tenantId: ACME.tenantId })
    return { ...t, id: t.requests[0]!.id }
  }

  test("accepting adds them with the rule's role, records it, and clears the removed list", async () => {
    const t = await withRequest()
    t.exclusions.set("a@dev.pslhq.app", "removed")
    // Another address of theirs, listed when they were removed (see `emailsOf`).
    t.exclusions.set("gone@pslhq.app", "removed")
    expect(await answerJoinRequest(t.d, { ...admin, id: t.id, accept: true })).toBe(
      "ok",
    )
    expect(t.added).toEqual([
      { orgId: ACME.orgId, userId: "user_new", role: "org:admin" },
    ])
    expect(t.exclusions.size).toBe(0)
    expect(t.joins[0]).toMatchObject({ how: "request", via: "*.pslhq.app" })
  })

  test("full: refused and the request stays open", async () => {
    const t = await withRequest({ full: true })
    expect(await answerJoinRequest(t.d, { ...admin, id: t.id, accept: true })).toBe(
      "full",
    )
    expect(await t.store.pending(ACME.tenantId)).toHaveLength(1)
  })

  test("decline and block puts the address on the block list", async () => {
    const t = await withRequest()
    expect(
      await answerJoinRequest(t.d, { ...admin, id: t.id, accept: false, block: true }),
    ).toBe("ok")
    expect(t.exclusions.get("a@dev.pslhq.app")).toBe("blocked")
    // Every address of theirs, as "Remove and block" does.
    expect(t.exclusions.get("gone@pslhq.app")).toBe("blocked")
    expect(t.exclusions.get("other@example.com")).toBe("blocked")
    expect(t.added).toEqual([])
  })

  test("only for somebody who can manage members", async () => {
    let asked = ""
    const t = await withRequest({
      can: async (_u, _o, permission) => {
        asked = permission
        return false
      },
    })
    expect(await answerJoinRequest(t.d, { ...admin, id: t.id, accept: true })).toBe(
      "forbidden",
    )
    expect(asked).toBe(MANAGE_MEMBERS)
  })

  test("a Clerk failure leaves the request open", async () => {
    const t = await withRequest({
      addMember: async () => {
        throw new Error("clerk down")
      },
    })
    await expect(
      answerJoinRequest(t.d, { ...admin, id: t.id, accept: true }),
    ).rejects.toThrow("clerk down")
    expect(await t.store.pending(ACME.tenantId)).toHaveLength(1)
  })
})

describe("removeTeamMember", () => {
  test("lists every verified address as removed, then removes in Clerk", async () => {
    const { d, removed, exclusions } = deps([])
    expect(
      await removeTeamMember(d, { ...admin, memberUserId: "user_9", block: false }),
    ).toBe("ok")
    expect([...exclusions]).toEqual([
      ["gone@pslhq.app", "removed"],
      ["other@example.com", "removed"],
    ])
    expect(removed).toEqual(["user_9"])
  })
  test("remove and block", async () => {
    const { d, exclusions } = deps([])
    await removeTeamMember(d, { ...admin, memberUserId: "user_9", block: true })
    expect(exclusions.get("gone@pslhq.app")).toBe("blocked")
  })
  test("removed never weakens blocked", async () => {
    const { d, exclusions } = deps([])
    exclusions.set("gone@pslhq.app", "blocked")
    await removeTeamMember(d, { ...admin, memberUserId: "user_9", block: false })
    expect(exclusions.get("gone@pslhq.app")).toBe("blocked")
  })
  test("not yourself", async () => {
    const { d } = deps([])
    expect(
      await removeTeamMember(d, { ...admin, memberUserId: admin.userId, block: false }),
    ).toBe("self")
  })
})

describe("allowAddress", () => {
  test("Allow takes them off the list; Allow and invite also invites", async () => {
    const { d, exclusions, invited } = deps([])
    exclusions.set("x@pslhq.app", "blocked")
    expect(
      await allowAddress(d, { ...admin, email: "X@pslhq.app", invite: true }),
    ).toBe("ok")
    expect(exclusions.size).toBe(0)
    expect(invited).toEqual(["x@pslhq.app"])
  })
})

describe("access domains", () => {
  test("free-mail names are refused before anything else", async () => {
    const { d } = deps([])
    expect(
      await addAccessDomain(d, { ...admin, name: "gmail.com", source: "txt" }),
    ).toEqual({ outcome: "free_mail" })
  })
  test("from /domains only a name verified there", async () => {
    const { d } = deps([])
    expect(
      await addAccessDomain(d, { ...admin, name: "other.app", source: "domains" }),
    ).toEqual({ outcome: "not_verified" })
    expect(
      await addAccessDomain(d, { ...admin, name: "PSLHQ.app", source: "domains" }),
    ).toEqual({ outcome: "ok", id: "jd_new", existed: false })
  })
  test("never on a Personal workspace", async () => {
    const { d } = deps([], { isPersonal: async () => true })
    expect(
      await addAccessDomain(d, { ...admin, name: "acme.com", source: "txt" }),
    ).toEqual({
      outcome: "personal",
    })
  })
  test("only for somebody who can manage domains", async () => {
    let asked = ""
    const { d } = deps([], {
      can: async (_u, _o, permission) => {
        asked = permission
        return false
      },
    })
    expect(
      await addAccessDomain(d, { ...admin, name: "acme.com", source: "txt" }),
    ).toEqual({
      outcome: "forbidden",
    })
    expect(asked).toBe(MANAGE_DOMAINS)
  })
  test("the suggestion card offers exactly the /domains names, never a parent", async () => {
    const { d } = deps([])
    const listed = await listAccess(d, ACME.tenantId)
    // pslhq.app is added already; notifications.other.app is offered as named.
    expect(listed.suggested).toEqual(["notifications.other.app"])
  })
  test("rules may not reach above the proven name", async () => {
    const { d } = deps([])
    expect(
      await setAccessRules(d, {
        ...admin,
        id: "jd_1",
        rules: [{ pattern: "*.app", mode: "auto", role: "org:member" }],
      }),
    ).toMatchObject({ outcome: "invalid" })
    expect(
      await setAccessRules(d, {
        ...admin,
        id: "jd_1",
        rules: [{ pattern: "*.pslhq.app", mode: "auto", role: "org:admin" }],
      }),
    ).toEqual({
      outcome: "ok",
      rules: [{ pattern: "*.pslhq.app", mode: "auto", role: "org:admin" }],
    })
  })
})
