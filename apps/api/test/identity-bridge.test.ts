import { describe, expect, it } from "bun:test"
import {
  bind,
  completeLogin,
  redeemHandoff,
  startLogin,
  type BridgeDeps,
} from "../src/identity/bridge.js"
import { testEngine } from "../src/identity/test-engine.js"
import {
  normaliseEmail,
  refusalMessage,
  type Assertion,
} from "../src/identity/model.js"
import { mayRemove } from "../src/console/roles.js"
import {
  CONNECTION,
  ORG,
  OTHER_TENANT,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"

/**
 * The sign-in bridge (#337, sso.md 2.1), every step and every refusal, with
 * in-memory ports. The Postgres side is identity-db.test.ts.
 */

const BINDING = "b".repeat(43)
const OTHER_BROWSER = "c".repeat(43)

function world(
  options: {
    store?: Parameters<typeof memoryStore>[0]
    users?: NonNullable<Parameters<typeof memoryClerk>[0]>["users"]
    join?: "added" | "full"
    owners?: string[]
  } = {},
) {
  let clock = new Date("2026-10-20T10:00:00Z").getTime()
  const store = memoryStore(options.store)
  const clerk = memoryClerk(options.users ? { users: options.users } : {})
  const joined: { orgId: string; userId: string }[] = []
  const deps: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([["test", testEngine("https://auth.i10.localhost")]]),
    join: async ({ orgId, userId }) => {
      joined.push({ orgId, userId })
      return options.join ?? "added"
    },
    isExempt: async (_tenantId, userId) => (options.owners ?? []).includes(userId),
    log,
    now: () => new Date(clock),
  }
  const advance = (ms: number) => {
    clock += ms
  }
  const now = () => new Date(clock)

  async function start(purpose: "sign_in" | "test_run" = "sign_in", binding = BINDING) {
    const started = await startLogin(deps, {
      connectionId: CONNECTION,
      purpose,
      binding,
      returnTo: "https://dash.i10.localhost/",
    })
    if (started.outcome !== "redirect")
      throw new Error(`not started: ${started.reason}`)
    const state = new URL(started.redirectUrl).searchParams.get("state")!
    return { state, redirectUrl: started.redirectUrl }
  }

  const assertion = (over: Partial<Assertion> = {}): Assertion => ({
    subject: "okta|ada",
    email: "Ada@Acme.test",
    emailVerified: true,
    authTime: now(),
    amr: ["pwd"],
    ...over,
  })

  /** Start, complete, redeem, Clerk redeems, bind: the whole bridge. */
  async function signIn(over: Partial<Assertion> = {}) {
    const { state } = await start()
    const done = await completeLogin(deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: assertion(over),
    })
    if (done.outcome !== "signed_in")
      throw new Error(`refused: ${JSON.stringify(done)}`)
    const redeemed = await redeemHandoff(deps, { code: done.code, binding: BINDING })
    if (redeemed.outcome !== "ticket")
      throw new Error(`no ticket: ${JSON.stringify(redeemed)}`)
    advance(2_000)
    const sessionId = clerk.redeem(redeemed.ticket, now())
    const bound = await bind(deps, {
      userId: "user_ada",
      sessionId,
      handoff: redeemed.handoff,
    })
    return { done, redeemed, sessionId, bound }
  }

  return { deps, store, clerk, joined, advance, now, start, assertion, signIn }
}

describe("starting", () => {
  it("makes an attempt keyed by hashes and sends the browser to the engine", async () => {
    const w = world()
    const { redirectUrl, state } = await w.start()
    expect(redirectUrl.startsWith("https://auth.i10.localhost/sso/test?state=")).toBe(
      true,
    )
    const [attempt] = [...w.store.attempts.values()]
    expect(attempt!.purpose).toBe("sign_in")
    // Only hashes at rest.
    expect(attempt!.bindingHash).not.toContain(BINDING)
    expect(attempt!.stateHash).not.toBe(state)
    expect(attempt!.expiresAt.getTime() - w.now().getTime()).toBe(10 * 60 * 1000)
  })

  it("refuses a connection that is not active, and one with no engine", async () => {
    for (const status of ["draft", "testing", "disabled"] as const) {
      const w = world({ store: { connections: [connection({ status })] } })
      expect(
        await startLogin(w.deps, {
          connectionId: CONNECTION,
          purpose: "sign_in",
          binding: BINDING,
          returnTo: null,
        }),
      ).toEqual({ outcome: "refused", reason: "connection_inactive" })
    }
    const off = world({ store: { connections: [connection({ protocol: "oidc" })] } })
    expect(
      await startLogin(off.deps, {
        connectionId: CONNECTION,
        purpose: "sign_in",
        binding: BINDING,
        returnTo: null,
      }),
    ).toEqual({ outcome: "refused", reason: "engine_disabled" })
  })

  it("lets a testing connection run test runs only", async () => {
    const w = world({ store: { connections: [connection({ status: "testing" })] } })
    await w.start("test_run")
  })

  it("refuses a step-up for a session that is not this user's bound session", async () => {
    const w = world()
    expect(
      await startLogin(w.deps, {
        connectionId: CONNECTION,
        purpose: "step_up",
        binding: BINDING,
        returnTo: null,
        stepUp: { userId: "user_ada", sessionId: "sess_nobody" },
      }),
    ).toEqual({ outcome: "refused", reason: "step_up_mismatch" })
  })
})

describe("completing", () => {
  it("claims an existing account on a live domain: links, manages, hardens, revokes old sessions", async () => {
    const w = world({
      users: [
        user({
          passwordEnabled: true,
          passkeyIds: ["pk_1"],
          externalAccountIds: ["eac_1"],
          totpEnabled: true,
          twoFactorEnabled: true,
          deleteSelfEnabled: true,
          emails: [
            { id: "idn_1", address: "ada@acme.test", verified: true },
            { id: "idn_2", address: "ada@gmail.test", verified: true },
          ],
        }),
      ],
    })
    w.clerk.active.set("user_ada", [{ id: "sess_old", createdAt: w.now() }])
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    expect(done.outcome).toBe("signed_in")
    expect(w.joined).toEqual([{ orgId: ORG, userId: "user_ada" }])
    expect(w.store.identities).toHaveLength(1)
    expect(w.store.identities[0]).toMatchObject({
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
    })
    expect(w.store.managed.get("user_ada")).toMatchObject({
      tenantId: TENANT,
      reason: "claimed",
      emails: ["ada@acme.test", "ada@gmail.test"],
    })
    expect(w.clerk.calls).toContain("revokeSession:sess_old")
    for (const call of [
      "removePassword:user_ada",
      "deleteExternal:eac_1",
      "deletePasskey:pk_1",
      "disableMfa:user_ada",
      "forbidSelfDelete:user_ada",
    ])
      expect(w.clerk.calls).toContain(call)
    // ⚠ Its other verified address was on the account at link time: it stays.
    expect(w.clerk.calls.some((c) => c.startsWith("deleteEmail"))).toBe(false)
    expect(w.store.events.map((e) => e.type)).toEqual([
      "managed.claimed",
      "managed.enforced",
      "sign_in.verified",
    ])
    // No ticket yet: it is minted at redeem.
    expect(w.clerk.minted).toHaveLength(0)
  })

  it("finds a linked person by subject alone the second time, whatever the email says", async () => {
    const w = world()
    await w.signIn()
    w.clerk.users.set(
      "user_eve",
      user({
        id: "user_eve",
        emails: [{ id: "idn_9", address: "eve@acme.test", verified: true }],
      }),
    )
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      // Same subject, the IdP renamed them: still Ada, never Eve.
      assertion: w.assertion({ email: "eve@acme.test" }),
    })
    expect(done.outcome).toBe("signed_in")
    const attempt = [...w.store.attempts.values()].at(-1)!
    expect(attempt.clerkUserId).toBe("user_ada")
    expect(w.store.identities).toHaveLength(1)
  })

  it("refuses from another browser, and does not burn the real person's attempt", async () => {
    const w = world()
    const { state } = await w.start()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: OTHER_BROWSER,
        assertion: w.assertion(),
      }),
    ).toEqual({ outcome: "refused", reason: "wrong_browser" })
    expect(
      (
        await completeLogin(w.deps, {
          protocol: "test",
          state,
          binding: BINDING,
          assertion: w.assertion(),
        })
      ).outcome,
    ).toBe("signed_in")
  })

  it("refuses an unknown state, a second completion and an expired attempt", async () => {
    const w = world()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state: "s".repeat(43),
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ).toEqual({ outcome: "refused", reason: "attempt_unknown" })
    const { state } = await w.start()
    await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "attempt_used",
    })
    const late = await w.start()
    w.advance(10 * 60 * 1000 + 1)
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state: late.state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "attempt_expired",
    })
  })

  it("lets exactly one of two racing callbacks through", async () => {
    const w = world()
    const { state } = await w.start()
    const results = await Promise.all([
      completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
      completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ])
    expect(results.filter((r) => r.outcome === "signed_in")).toHaveLength(1)
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(1)
  })

  const refusals: [string, Parameters<typeof world>[0], Partial<Assertion>, string][] =
    [
      ["no email", {}, { email: null }, "no_email"],
      [
        "an address the IdP does not vouch for",
        {},
        { emailVerified: false },
        "email_unverified",
      ],
      [
        "an address off the connection's live domains",
        {},
        { email: "ada@elsewhere.test" },
        "domain_not_verified",
      ],
      [
        "a subdomain of a live domain",
        {},
        { email: "ada@eu.acme.test" },
        "domain_not_verified",
      ],
      [
        "a displaced or lapsed proof (no live domains)",
        { store: { live: {} } },
        {},
        "domain_not_verified",
      ],
      ["nobody with that verified address", { users: [] }, {}, "no_account"],
      [
        "an address Clerk holds unverified",
        {
          users: [
            user({
              emails: [{ id: "idn_1", address: "ada@acme.test", verified: false }],
            }),
          ],
        },
        {},
        "no_account",
      ],
      [
        "two accounts holding it",
        { users: [user(), user({ id: "user_twin" })] },
        {},
        "ambiguous_account",
      ],
      ["a banned account", { users: [user({ banned: true })] }, {}, "account_banned"],
      [
        "the workspace's block list",
        { store: { blocked: ["ada@acme.test"] } },
        {},
        "blocked",
      ],
      ["a full workspace", { join: "full" }, {}, "workspace_full"],
      ["a workspace that is gone", { store: { orgs: {} } }, {}, "workspace_gone"],
    ]
  for (const [what, options, over, reason] of refusals) {
    it(`refuses ${what}`, async () => {
      const w = world(options)
      const { state } = await w.start()
      expect(
        await completeLogin(w.deps, {
          protocol: "test",
          state,
          binding: BINDING,
          assertion: w.assertion(over),
        }),
      ).toEqual({
        outcome: "refused",
        reason: reason as never,
      })
      expect(w.store.managed.size).toBe(0)
      expect(w.store.events.at(-1)).toMatchObject({ type: "sign_in.failed", reason })
    })
  }

  it("refuses an account another workspace manages", async () => {
    const w = world()
    w.store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: OTHER_TENANT,
      connectionId: null,
      reason: "claimed",
      emails: ["ada@acme.test"],
    })
    const { state } = await w.start()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "managed_elsewhere",
    })
    expect(w.joined).toHaveLength(0)
  })

  it("refuses an account already linked to another subject on this connection", async () => {
    const w = world()
    await w.signIn()
    const { state } = await w.start()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion({ subject: "okta|imposter" }),
      }),
    ).toEqual({ outcome: "refused", reason: "already_linked" })
  })

  it("requires proof of IdP MFA when the connection asks for it", async () => {
    const w = world({ store: { connections: [connection({ mfaRequired: true })] } })
    const { state } = await w.start()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion({ amr: ["pwd"] }),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "mfa_required",
    })
    const again = await w.start()
    expect(
      (
        await completeLogin(w.deps, {
          protocol: "test",
          state: again.state,
          binding: BINDING,
          assertion: w.assertion({ amr: ["pwd", "otp"] }),
        })
      ).outcome,
    ).toBe("signed_in")
  })

  it("refuses a connection disabled between start and callback", async () => {
    const w = world()
    const { state } = await w.start()
    w.store.connections.set(CONNECTION, connection({ status: "disabled" }))
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "connection_inactive",
    })
  })

  it("never uses JIT unless the connection allows it and a JIT hook exists", async () => {
    // The connection says no (the default), with the hook present.
    const off = world({ users: [] })
    off.deps.jit = true
    const first = await off.start()
    expect(
      (
        await completeLogin(off.deps, {
          protocol: "test",
          state: first.state,
          binding: BINDING,
          assertion: off.assertion(),
        })
      ).outcome,
    ).toBe("refused")
    expect(off.clerk.created).toEqual([])
    // The connection says yes, with no hook in this process.
    const unwired = world({
      users: [],
      store: { connections: [connection({ jitEnabled: true })] },
    })
    const second = await unwired.start()
    expect(
      (
        await completeLogin(unwired.deps, {
          protocol: "test",
          state: second.state,
          binding: BINDING,
          assertion: unwired.assertion(),
        })
      ).outcome,
    ).toBe("refused")
    expect(unwired.clerk.created).toEqual([])
  })

  it("records a test run with the claims and what would happen, and signs nobody in", async () => {
    const w = world({ store: { connections: [connection({ status: "testing" })] } })
    const { state } = await w.start("test_run")
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    expect(done).toMatchObject({ outcome: "tested", passed: true })
    expect(w.store.testRuns[0]).toMatchObject({
      outcome: "passed",
      resolution: { path: "claimed", clerkUserId: "user_ada" },
    })
    expect(w.store.identities).toHaveLength(0)
    expect(w.store.managed.size).toBe(0)
    expect(w.joined).toHaveLength(0)
  })
})

describe("owners and managed rows", () => {
  it("refuses an owner who is not managed before anything moves (decision 7)", async () => {
    const w = world({
      owners: ["user_ada"],
      users: [user({ passkeyIds: ["pk_1"], passwordEnabled: true })],
    })
    w.clerk.active.set("user_ada", [{ id: "sess_old", createdAt: w.now() }])
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    expect(done).toEqual({ outcome: "refused", reason: "role_exempt" })
    // Not joined, not linked, not managed, nothing at Clerk touched, no ticket.
    expect(w.joined).toEqual([])
    expect(w.store.identities).toHaveLength(0)
    expect(w.store.managed.size).toBe(0)
    expect(w.clerk.calls).toEqual([])
    expect(w.clerk.minted).toEqual([])
  })

  it("refuses an assertion from an engine that is not the connection's own", async () => {
    const w = world()
    const { state } = await w.start()
    expect(
      await completeLogin(w.deps, {
        protocol: "oidc",
        state,
        binding: BINDING,
        assertion: w.assertion(),
      }),
    ).toEqual({ outcome: "refused", reason: "engine_mismatch" })
    expect(w.store.identities).toHaveLength(0)
  })

  it("lets a managed owner in only through the link they already have", async () => {
    const managedOwner = () => {
      const w = world({ owners: ["user_ada"] })
      w.store.managed.set("user_ada", {
        clerkUserId: "user_ada",
        tenantId: TENANT,
        connectionId: CONNECTION,
        reason: "claimed",
        emails: ["ada@acme.test"],
      })
      return w
    }
    // Linked on this connection: signs in, stays managed.
    const linked = managedOwner()
    linked.store.identities.push({
      id: "22222222-2222-4222-8222-222222222222",
      tenantId: TENANT,
      connectionId: CONNECTION,
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
      lastLoginAt: null,
    })
    await linked.signIn()
    expect(linked.store.managed.get("user_ada")?.tenantId).toBe(TENANT)

    // Not linked here (another connection's IdP asserting her address): refused.
    const claimed = managedOwner()
    const { state } = await claimed.start()
    expect(
      await completeLogin(claimed.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: claimed.assertion(),
      }),
    ).toEqual({ outcome: "refused", reason: "role_exempt" })
    expect(claimed.store.identities).toHaveLength(0)
    expect(claimed.clerk.minted).toEqual([])
  })

  it("follows an IdP rename on the stored row, and never lists an address the account lacks", async () => {
    const w = world({
      users: [
        user({
          emails: [
            { id: "idn_1", address: "ada@acme.test", verified: true },
            { id: "idn_2", address: "lovelace@acme.test", verified: true },
            { id: "idn_3", address: "sneaky@acme.test", verified: true },
          ],
        }),
      ],
    })
    w.store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "claimed",
      emails: ["ada@acme.test"],
    })
    w.store.identities.push({
      id: "11111111-1111-4111-8111-111111111111",
      tenantId: TENANT,
      connectionId: CONNECTION,
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
      lastLoginAt: null,
    })
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion({ email: "lovelace@acme.test" }),
    })
    expect(done.outcome).toBe("signed_in")
    // The renamed address joins the row; one that merely appeared on the
    // account does not, and is removed.
    expect(w.store.managed.get("user_ada")?.emails).toEqual([
      "lovelace@acme.test",
      "ada@acme.test",
    ])
    expect(w.clerk.calls).toContain("deleteEmail:idn_3")
  })

  it("points a kept row at the connection it just signed in through", async () => {
    const w = world()
    w.store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: null,
      reason: "claimed",
      emails: ["ada@acme.test"],
    })
    await w.signIn()
    expect(w.store.managed.get("user_ada")?.connectionId).toBe(CONNECTION)
  })
})

describe("redeeming the handoff code", () => {
  it("mints a 60-second fresh ticket for the workspace, once", async () => {
    const w = world()
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    if (done.outcome !== "signed_in") throw new Error("not signed in")
    const first = await redeemHandoff(w.deps, { code: done.code, binding: BINDING })
    expect(first.outcome).toBe("ticket")
    expect(w.clerk.minted).toEqual([{ userId: "user_ada", orgId: ORG }])
    expect(await redeemHandoff(w.deps, { code: done.code, binding: BINDING })).toEqual({
      outcome: "refused",
      reason: "attempt_used",
    })
    expect(w.clerk.minted).toHaveLength(1)
  })

  it("refuses another browser, an expired code and an unknown code", async () => {
    const w = world()
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    if (done.outcome !== "signed_in") throw new Error("not signed in")
    expect(
      await redeemHandoff(w.deps, { code: done.code, binding: OTHER_BROWSER }),
    ).toEqual({
      outcome: "refused",
      reason: "wrong_browser",
    })
    expect(
      await redeemHandoff(w.deps, { code: "x".repeat(43), binding: BINDING }),
    ).toEqual({
      outcome: "refused",
      reason: "attempt_unknown",
    })
    w.advance(2 * 60 * 1000 + 1)
    expect(await redeemHandoff(w.deps, { code: done.code, binding: BINDING })).toEqual({
      outcome: "refused",
      reason: "attempt_expired",
    })
    expect(w.clerk.minted).toHaveLength(0)
  })

  it("spends the code even when Clerk then fails: no second ticket for one login", async () => {
    const w = world()
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    if (done.outcome !== "signed_in") throw new Error("not signed in")
    w.clerk.fail.mint = true
    await expect(
      redeemHandoff(w.deps, { code: done.code, binding: BINDING }),
    ).rejects.toThrow()
    w.clerk.fail.mint = false
    expect(
      (await redeemHandoff(w.deps, { code: done.code, binding: BINDING })).outcome,
    ).toBe("refused")
  })

  it("is refused for a refused login", async () => {
    const w = world({ users: [] })
    const { state } = await w.start()
    await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    const attempt = [...w.store.attempts.values()][0]!
    expect(attempt.handoffCodeHash).toBeNull()
  })
})

describe("binding", () => {
  it("binds the session the ticket made, fresh as of the IdP's auth_time", async () => {
    const w = world()
    const authTime = new Date(w.now().getTime() - 30_000)
    const { sessionId, bound } = await w.signIn({ authTime })
    expect(bound).toEqual({ outcome: "bound", returnTo: "https://dash.i10.localhost/" })
    const row = w.store.sessions.get(sessionId)!
    expect(row).toMatchObject({
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      tenantId: TENANT,
    })
    expect(row.freshAt.getTime()).toBe(authTime.getTime())
    expect(w.store.events.at(-1)).toMatchObject({
      type: "sign_in.succeeded",
      sessionId,
    })
  })

  it("reads no auth_time as not fresh at all", async () => {
    const w = world()
    const { sessionId } = await w.signIn({ authTime: null })
    expect(w.store.sessions.get(sessionId)!.freshAt.getTime()).toBe(0)
  })

  async function ready() {
    const w = world()
    const { state } = await w.start()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    if (done.outcome !== "signed_in") throw new Error("not signed in")
    const redeemed = await redeemHandoff(w.deps, { code: done.code, binding: BINDING })
    if (redeemed.outcome !== "ticket") throw new Error("no ticket")
    return { w, redeemed }
  }

  it("refuses a token Clerk never accepted - and kills it", async () => {
    const { w, redeemed } = await ready()
    // A session from somewhere else, with a ticket that is still pending.
    w.clerk.clerkSessions.set("sess_other", {
      id: "sess_other",
      userId: "user_ada",
      clientId: "client_other",
      status: "active",
      createdAt: w.now(),
    })
    w.clerk.strategies.set("client_other", "ticket")
    expect(
      await bind(w.deps, {
        userId: "user_ada",
        sessionId: "sess_other",
        handoff: redeemed.handoff,
      }),
    ).toEqual({
      outcome: "refused",
      reason: "token_not_accepted",
    })
    expect([...w.clerk.tokens.values()]).toEqual(["revoked"])
    expect(w.store.sessions.size).toBe(0)
  })

  it("refuses a session that did not come from a ticket", async () => {
    const { w, redeemed } = await ready()
    const sid = w.clerk.redeem(redeemed.ticket, w.now(), "email_code")
    expect(
      await bind(w.deps, {
        userId: "user_ada",
        sessionId: sid,
        handoff: redeemed.handoff,
      }),
    ).toEqual({
      outcome: "refused",
      reason: "not_ticket",
    })
  })

  it("refuses a session older than the ticket, another user, a second bind and a late bind", async () => {
    const { w, redeemed } = await ready()
    const sid = w.clerk.redeem(redeemed.ticket, new Date(w.now().getTime() - 60_000))
    expect(
      await bind(w.deps, {
        userId: "user_ada",
        sessionId: sid,
        handoff: redeemed.handoff,
      }),
    ).toEqual({
      outcome: "refused",
      reason: "session_mismatch",
    })
    expect(
      await bind(w.deps, {
        userId: "user_eve",
        sessionId: sid,
        handoff: redeemed.handoff,
      }),
    ).toEqual({
      outcome: "refused",
      reason: "wrong_user",
    })
    expect(
      await bind(w.deps, {
        userId: "user_ada",
        sessionId: sid,
        handoff: "h".repeat(43),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "unknown",
    })

    const second = await ready()
    const ok = second.w.clerk.redeem(second.redeemed.ticket, second.w.now())
    expect(
      (
        await bind(second.w.deps, {
          userId: "user_ada",
          sessionId: ok,
          handoff: second.redeemed.handoff,
        })
      ).outcome,
    ).toBe("bound")
    expect(
      await bind(second.w.deps, {
        userId: "user_ada",
        sessionId: ok,
        handoff: second.redeemed.handoff,
      }),
    ).toEqual({
      outcome: "refused",
      reason: "used",
    })

    const third = await ready()
    const late = third.w.clerk.redeem(third.redeemed.ticket, third.w.now())
    third.w.advance(5 * 60 * 1000 + 1)
    expect(
      await bind(third.w.deps, {
        userId: "user_ada",
        sessionId: late,
        handoff: third.redeemed.handoff,
      }),
    ).toEqual({
      outcome: "refused",
      reason: "expired",
    })
  })
})

describe("step-up", () => {
  async function steppable() {
    const w = world()
    const { sessionId } = await w.signIn({
      authTime: new Date(new Date("2026-10-20T10:00:00Z").getTime() - 3_600_000),
    })
    const started = await startLogin(w.deps, {
      connectionId: CONNECTION,
      purpose: "step_up",
      binding: BINDING,
      returnTo: null,
      stepUp: { userId: "user_ada", sessionId },
    })
    if (started.outcome !== "redirect") throw new Error("not started")
    return {
      w,
      sessionId,
      state: new URL(started.redirectUrl).searchParams.get("state")!,
    }
  }

  it("makes the session fresh on a recent IdP re-authentication by the same person", async () => {
    const { w, sessionId, state } = await steppable()
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    expect(done.outcome).toBe("stepped_up")
    expect(w.store.sessions.get(sessionId)!.freshAt.getTime()).toBe(w.now().getTime())
    // No ticket, no new session: step-up changes only `fresh_at`.
    expect(w.clerk.minted).toHaveLength(1)
  })

  it("refuses an IdP that answered from an old session of its own", async () => {
    const { w, state } = await steppable()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion({
          authTime: new Date(w.now().getTime() - 6 * 60 * 1000),
        }),
      }),
    ).toEqual({ outcome: "refused", reason: "step_up_stale" })
  })

  it("refuses somebody else's subject", async () => {
    const { w, state } = await steppable()
    expect(
      await completeLogin(w.deps, {
        protocol: "test",
        state,
        binding: BINDING,
        assertion: w.assertion({ subject: "okta|eve" }),
      }),
    ).toEqual({
      outcome: "refused",
      reason: "step_up_mismatch",
    })
  })
})

describe("addresses the bridge will compare", () => {
  it("takes plain addresses, lower-cased", () => {
    expect(normaliseEmail(" Ada@Acme.Test ")).toBe("ada@acme.test")
    expect(normaliseEmail("ada.l+sso@mail.acme.test")).toBe("ada.l+sso@mail.acme.test")
  })

  it("refuses anything whose domain could be read two ways", () => {
    for (const bad of [
      "a@b@acme.test",
      "ada@acme.test.",
      "ada@-acme.test",
      "ada@acme",
      "ada@acmé.test",
      "ad a@acme.test",
      "ada\u0000@acme.test",
      "@acme.test",
      "ada@",
      `${"a".repeat(65)}@acme.test`,
    ])
      expect(normaliseEmail(bad)).toBeNull()
  })
})

describe("who may act on whom", () => {
  it("lets an owner act on anybody and an admin on anybody but an owner", () => {
    expect(mayRemove("owner", "owner")).toBe("ok")
    expect(mayRemove("admin", "admin")).toBe("ok")
    expect(mayRemove("admin", "member")).toBe("ok")
    expect(mayRemove("admin", "owner")).toBe("owner_only")
    expect(mayRemove("member", "member")).toBe("forbidden")
  })
})

describe("a person a company directory has switched off (#342)", () => {
  async function attempt(
    w: ReturnType<typeof world>,
    over: Partial<Assertion> = {},
    binding = BINDING,
  ) {
    const { state } = await w.start()
    return completeLogin(w.deps, {
      protocol: "test",
      state,
      binding,
      assertion: w.assertion(over),
    })
  }
  const reasons = (w: ReturnType<typeof world>) =>
    w.store.events.filter((e) => e.type === "sign_in.failed").map((e) => e.reason)

  it("is refused instead of claimed by address, whatever Clerk holds under that address", async () => {
    const w = world({ users: [user()] })
    w.deps.preProvisioned = async () => "deprovisioned"
    const done = await attempt(w)
    expect(done).toEqual({ outcome: "refused", reason: "deprovisioned" })
    expect(reasons(w)).toEqual(["deprovisioned"])
    expect(w.store.managed.size).toBe(0)
    expect(w.store.identities).toEqual([])
    expect(w.joined).toEqual([])
    expect(w.clerk.calls).toEqual([])
    expect(refusalMessage("deprovisioned")).toBe(
      "Your administrator has removed your access.",
    )
  })

  it("is not made again by JIT, even on a connection that allows it", async () => {
    const w = world({
      users: [],
      store: { connections: [connection({ jitEnabled: true })] },
    })
    w.deps.jit = true
    w.deps.preProvisioned = async () => "deprovisioned"
    expect(await attempt(w)).toEqual({ outcome: "refused", reason: "deprovisioned" })
    expect(w.clerk.created).toEqual([])
    expect(w.clerk.calls).toEqual([])
    expect(w.joined).toEqual([])
  })

  it("is refused even with an identity link of their own: deprovisioning ends the managed row, not the link", async () => {
    const w = world({ users: [user()] })
    await w.store.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
    })
    // Not switched off: the linked person signs in.
    w.deps.deprovisioned = async () => false
    expect((await attempt(w)).outcome).toBe("signed_in")
    // Switched off: the same sign-in is refused, and joins nobody.
    w.joined.length = 0
    w.deps.deprovisioned = async (tenantId, userId) => {
      expect([tenantId, userId]).toEqual([TENANT, "user_ada"])
      return true
    }
    expect(await attempt(w)).toEqual({ outcome: "refused", reason: "deprovisioned" })
    expect(w.joined).toEqual([])
    expect(reasons(w)).toEqual(["deprovisioned"])
  })

  it("is refused when the account was found by address too, not only by link", async () => {
    const w = world({ users: [user()] })
    w.deps.deprovisioned = async () => true
    expect(await attempt(w)).toEqual({ outcome: "refused", reason: "deprovisioned" })
    expect(w.store.managed.size).toBe(0)
  })

  it("lets the directory's own account through, as a pre-provisioned person", async () => {
    const w = world({ users: [user()] })
    w.deps.preProvisioned = async () => "user_ada"
    w.deps.deprovisioned = async () => false
    expect((await attempt(w)).outcome).toBe("signed_in")
    expect(w.store.managed.get("user_ada")).toMatchObject({ reason: "scim" })
  })

  it("is reported in a test run as a refusal, creating nobody", async () => {
    const w = world({ users: [user()] })
    w.deps.preProvisioned = async () => "deprovisioned"
    const { state } = await w.start("test_run")
    const done = await completeLogin(w.deps, {
      protocol: "test",
      state,
      binding: BINDING,
      assertion: w.assertion(),
    })
    expect(done).toMatchObject({ outcome: "tested", passed: false })
    expect(w.store.testRuns[0]).toMatchObject({
      outcome: "failed",
      reason: "deprovisioned",
      resolution: { refused: "deprovisioned" },
    })
  })
})
