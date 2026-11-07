import { memoryMail } from "./identity-mail-fakes.js"
import { describe, expect, it } from "bun:test"
import {
  deprovision,
  driftOf,
  onUserUpdated,
  planSweep,
  sweepSession,
  type DeprovisionDeps,
} from "../src/identity/managed.js"
import { onIdentityClerkEvent } from "../src/identity/events.js"
import {
  CONNECTION,
  ORG,
  TENANT,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"

/**
 * Managed accounts (#337, sso.md 2.3): the watchdog, the sweeper, and
 * deprovisioning.
 */

const T0 = new Date("2026-10-20T10:00:00Z")

function world(authorized: "ok" | "forbidden" | "owner_only" = "ok") {
  const store = memoryStore()
  const clerk = memoryClerk()
  let clock = T0.getTime()
  const removed: string[] = []
  const mail = memoryMail()
  const deps: DeprovisionDeps = {
    store: store.store,
    clerk: clerk.clerk,
    log,
    mail: mail.lifecycle,
    now: () => new Date(clock),
    workspaceOrg: async () => ORG,
    authorize: async () => authorized,
    removeMembership: async ({ userId }) => (removed.push(userId), "removed"),
  }
  const manage = (emails = ["ada@acme.test"]) =>
    store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "claimed",
      emails,
    })
  return {
    store,
    clerk,
    deps,
    mail,
    manage,
    removed,
    advance: (ms: number) => (clock += ms),
  }
}

describe("drift", () => {
  it("lists every way back in, and nothing for a clean account", () => {
    expect(driftOf(user(), ["ada@acme.test"])).toEqual([])
    expect(
      driftOf(
        user({
          passwordEnabled: true,
          externalAccountIds: ["eac_1"],
          passkeyIds: ["pk_1"],
          totpEnabled: true,
          backupCodeEnabled: true,
          deleteSelfEnabled: true,
          emails: [
            { id: "idn_1", address: "ada@acme.test", verified: true },
            { id: "idn_2", address: "new@gmail.test", verified: false },
          ],
        }),
        ["ada@acme.test"],
      ).map((f) => f.kind),
    ).toEqual([
      "password",
      "external_account",
      "passkey",
      "mfa",
      "backup_codes",
      "email",
      "self_delete",
    ])
  })

  it("removes phone numbers and web3 wallets: neither is the IdP", () => {
    expect(
      driftOf(user({ phoneIds: ["idn_ph"], web3WalletIds: ["idn_w3"] }), [
        "ada@acme.test",
      ]),
    ).toEqual([
      { kind: "phone", id: "idn_ph" },
      { kind: "web3_wallet", id: "idn_w3" },
    ])
  })

  it("never strips an account of its last address", () => {
    expect(driftOf(user(), [])).toEqual([])
  })
})

describe("the user.updated watchdog", () => {
  it("puts a managed account back and records it; the echo finds nothing", async () => {
    const w = world()
    w.manage()
    w.clerk.users.get("user_ada")!.passwordEnabled = true
    w.clerk.users
      .get("user_ada")!
      .emails.push({ id: "idn_x", address: "x@gmail.test", verified: true })
    expect(await onUserUpdated(w.deps, { id: "user_ada" })).toBe("managed:fixed:2")
    expect(w.clerk.calls).toEqual(["removePassword:user_ada", "deleteEmail:idn_x"])
    expect(await onUserUpdated(w.deps, { id: "user_ada" })).toBe("managed:ok")
  })

  it("leaves everybody else alone, without asking Clerk", async () => {
    const w = world()
    w.clerk.users.get("user_ada")!.passwordEnabled = true
    expect(await onUserUpdated(w.deps, { id: "user_ada" })).toBeNull()
    expect(w.clerk.calls).toEqual([])
  })
})

describe("the sweeper", () => {
  const event = {
    sessionId: "sess_1",
    userId: "user_ada",
    clientId: "client_1",
    createdAt: T0,
  }

  it("ignores a session of somebody who is not managed", async () => {
    const w = world()
    expect(await planSweep(w.deps, event)).toEqual({ action: "none" })
  })

  it("revokes a managed account's email-code session at once", async () => {
    const w = world()
    w.manage()
    w.clerk.strategies.set("client_1", "email_code")
    expect(await planSweep(w.deps, event)).toEqual({
      action: "revoke",
      reason: "not_ticket",
    })
    expect(
      await onIdentityClerkEvent(
        { ...w.deps, schedule: async () => {} },
        "session.created",
        {
          id: "sess_1",
          user_id: "user_ada",
          client_id: "client_1",
          created_at: T0.getTime(),
        },
      ),
    ).toBe("sso:revoked")
    expect(w.clerk.calls).toContain("revokeSession:sess_1")
  })

  it("gives a ticket session two minutes, and an unreadable client the same", async () => {
    const w = world()
    w.manage()
    w.clerk.strategies.set("client_1", "ticket")
    expect(await planSweep(w.deps, event)).toEqual({
      action: "later",
      at: new Date(T0.getTime() + 120_000),
    })
    expect(
      await planSweep(w.deps, { ...event, clientId: "client_unknown" }),
    ).toMatchObject({ action: "later" })
    const jobs: unknown[] = []
    await onIdentityClerkEvent(
      { ...w.deps, schedule: async (job) => void jobs.push(job) },
      "session.created",
      {
        id: "sess_1",
        user_id: "user_ada",
        client_id: "client_1",
        created_at: T0.getTime(),
      },
    )
    expect(jobs).toEqual([
      { sessionId: "sess_1", userId: "user_ada", dueAt: T0.getTime() + 120_000 },
    ])
  })

  it("never revokes early, keeps a bound session, revokes an unbound one", async () => {
    const w = world()
    w.manage()
    const job = {
      sessionId: "sess_1",
      userId: "user_ada",
      dueAt: T0.getTime() + 120_000,
    }
    w.advance(119_500)
    expect(await sweepSession(w.deps, job)).toEqual({ outcome: "early", ms: 500 })
    w.advance(500)
    expect(await sweepSession(w.deps, job)).toEqual({ outcome: "revoked" })
    expect(w.clerk.calls).toEqual(["revokeSession:sess_1"])

    await w.store.store.bindSession(TENANT, {
      sessionId: "sess_2",
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: T0,
      at: T0,
      freshAt: T0,
    })
    expect(await sweepSession(w.deps, { ...job, sessionId: "sess_2" })).toEqual({
      outcome: "bound",
    })
  })

  it("forgets a deleted account's links", async () => {
    const w = world()
    w.manage()
    w.store.identities.push({
      id: "i1",
      tenantId: TENANT,
      connectionId: CONNECTION,
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: null,
      lastLoginAt: null,
    })
    expect(
      await onIdentityClerkEvent(
        { ...w.deps, schedule: async () => {} },
        "user.deleted",
        { id: "user_ada" },
      ),
    ).toBe("managed:forgotten")
    expect(w.store.identities).toHaveLength(0)
    expect(w.store.managed.size).toBe(0)
  })
})

describe("deprovisioning", () => {
  async function bound(w: ReturnType<typeof world>, sessionId: string) {
    await w.store.store.bindSession(TENANT, {
      sessionId,
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: T0,
      at: T0,
      freshAt: T0,
    })
  }

  it("by default: sessions revoked, membership removed, the account released", async () => {
    const w = world()
    w.manage()
    await bound(w, "sess_1")
    await bound(w, "sess_2")
    expect(
      await deprovision(w.deps, {
        tenantId: TENANT,
        clerkUserId: "user_ada",
        actorUserId: "user_admin",
        cause: "admin",
      }),
    ).toEqual({ outcome: "membership", sessions: 2 })
    expect(w.clerk.calls).toEqual(["revokeSession:sess_1", "revokeSession:sess_2"])
    expect(w.removed).toEqual(["user_ada"])
    expect(w.store.managed.size).toBe(0)
    expect(w.store.events.at(-1)).toMatchObject({
      type: "member.deprovisioned",
      data: { mode: "membership", sessions: 2, mailbox: "no_mailbox" },
    })
  })

  it("with the workspace's setting: the whole account banned, still managed", async () => {
    const w = world()
    w.manage()
    await bound(w, "sess_1")
    await w.store.store.setDeprovisionMode(TENANT, "account", "user_owner")
    expect(
      await deprovision(w.deps, {
        tenantId: TENANT,
        clerkUserId: "user_ada",
        actorUserId: null,
        cause: "scim",
      }),
    ).toEqual({ outcome: "account", sessions: 1 })
    expect(w.clerk.calls).toContain("ban:user_ada")
    expect(w.removed).toEqual([])
    expect(w.store.managed.size).toBe(1)
  })

  it("revokes sessions even when the membership cannot go (the last owner)", async () => {
    const w = world()
    w.manage()
    await bound(w, "sess_1")
    w.deps.removeMembership = async () => "last_owner"
    expect(
      await deprovision(w.deps, {
        tenantId: TENANT,
        clerkUserId: "user_ada",
        actorUserId: null,
        cause: "admin",
      }),
    ).toEqual({ outcome: "last_owner" })
    expect(w.clerk.calls).toEqual(["revokeSession:sess_1"])
    expect(w.store.managed.size).toBe(1)
  })

  it("refuses an actor who may not remove the person, before any session ends", async () => {
    for (const refusal of ["forbidden", "owner_only"] as const) {
      const w = world(refusal)
      w.manage()
      await bound(w, "sess_1")
      await w.store.store.setDeprovisionMode(TENANT, "account", "user_owner")
      expect(
        await deprovision(w.deps, {
          tenantId: TENANT,
          clerkUserId: "user_ada",
          actorUserId: "user_admin",
          cause: "admin",
        }),
      ).toEqual({ outcome: refusal })
      // Nothing moved: no revoke, no ban, no removal, still managed.
      expect(w.clerk.calls).toEqual([])
      expect(w.removed).toEqual([])
      expect(w.store.managed.size).toBe(1)
    }
  })

  it("passes the actor to the removal, never the person themselves", async () => {
    const w = world()
    w.manage()
    const seen: (string | null)[] = []
    w.deps.removeMembership = async ({ actorUserId }) => (
      seen.push(actorUserId),
      "removed"
    )
    await deprovision(w.deps, {
      tenantId: TENANT,
      clerkUserId: "user_ada",
      actorUserId: "user_admin",
      cause: "admin",
    })
    expect(seen).toEqual(["user_admin"])
  })

  it("does nothing to somebody this workspace does not manage", async () => {
    const w = world()
    expect(
      await deprovision(w.deps, {
        tenantId: TENANT,
        clerkUserId: "user_ada",
        actorUserId: null,
        cause: "admin",
      }),
    ).toEqual({ outcome: "not_managed" })
  })
})
