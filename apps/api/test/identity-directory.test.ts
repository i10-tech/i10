import { describe, expect, it } from "bun:test"
import { addMember } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import {
  KICK_AFTER_MS,
  KICK_EVERY_MS,
  applyDirectoryUser,
  directoryDeprovisioned,
  directoryKicker,
  directoryPreProvisioned,
  scheduleEntries,
  type DirectoryDeps,
} from "../src/identity/directory.js"
import type {
  DirectoryConflict,
  DirectoryUserRow,
} from "../src/identity/directory-ports.js"
import type { DeprovisionDeps } from "../src/identity/managed.js"
import type { Assertion } from "../src/identity/model.js"
import { patchUser, readPatch, readUser, SCHEMA } from "../src/identity/scim.js"
import { ACME, row as roleRow, rolesDeps } from "./role-fixtures.js"
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
import { memoryMail, realProvisioning } from "./identity-mail-fakes.js"
import {
  DIRECTORY,
  OTHER_DIRECTORY,
  memoryDirectories,
  memoryProvisioning,
} from "./identity-scim-fakes.js"

/**
 * What a directory's changes do to Clerk, the membership and the managed
 * account (#342): every conflict, both deprovisioning modes, reactivation,
 * two directories, and the outbox bookkeeping, with the real roles decisions
 * and in-memory ports.
 */

type Clerk = ReturnType<typeof user>

interface WorldOptions {
  users?: Clerk[]
  blocked?: string[]
  full?: boolean
  owners?: string[]
  admins?: string[]
  members?: string[]
  domains?: string[]
  mode?: "membership" | "account"
  /** The SSO connection's status: only an active one gives a managed person a way in. */
  sso?: Connection["status"]
  directories?: NonNullable<Parameters<typeof memoryDirectories>[0]>["directories"]
}

/** A fresh Clerk account for Ada each time: the fakes keep what they are given. */
const ada = () =>
  user({
    id: "user_ada",
    firstName: "Ada",
    lastName: "Lovelace",
    passwordEnabled: true,
  })

function world(options: WorldOptions = {}) {
  const dirs = memoryDirectories({
    domains: options.domains ?? ["acme.test"],
    directories: options.directories ?? [{ id: DIRECTORY }, { id: OTHER_DIRECTORY }],
  })
  const identity = memoryStore({
    connections: [connection({ status: options.sso ?? "active" })],
    blocked: options.blocked ?? [],
  })
  const clerk = memoryClerk({ users: options.users ?? [] })
  const prov = memoryProvisioning(clerk)
  const members = new Set(options.members ?? [])
  const rows = [
    ...(options.owners ?? []).map((u) => roleRow(u, "owner")),
    ...(options.admins ?? []).map((u) => roleRow(u, "admin")),
  ]
  const roles = rolesDeps({
    rows,
    tenants: { [ORG]: ACME.tenantId },
    clerk: {
      create: async (_o, userId) => {
        if (members.has(userId)) return { outcome: "already_member" }
        members.add(userId)
        return { outcome: "created", membershipId: `mem_${userId}` }
      },
    },
  })
  const forgotten: string[] = []
  const fail = { unconfirmed: false }
  const seats = { full: options.full ?? false, asked: 0 }
  const joined: { userId: string; role: string }[] = []
  const mail = memoryMail()
  mail.deps.isMember = async (_t, userId) => members.has(userId)
  const deprovision: DeprovisionDeps = {
    store: identity.store,
    clerk: clerk.clerk,
    log,
    mail: mail.lifecycle,
    workspaceOrg: (t) => identity.store.workspaceOrg(t),
    authorize: async () => "ok",
    removeMembership: async ({ userId }) => {
      if (fail.unconfirmed) return "unconfirmed"
      const owners = roles.rows().filter((r) => r.role === "owner")
      if (owners.length === 1 && owners[0]!.userId === userId) return "last_owner"
      members.delete(userId)
      return "removed"
    },
  }
  const deps: DirectoryDeps = {
    store: dirs.store,
    identity: identity.store,
    clerk: clerk.clerk,
    provisioning: prov.provisioning,
    deprovision,
    mail: mail.deps,
    isMember: async (_o, userId) => members.has(userId),
    seats: async () => {
      seats.asked += 1
      return { full: seats.full }
    },
    join: async ({ orgId, userId, role }) => {
      joined.push({ userId, role })
      return addMember(roles.d, { orgId, userId, role, source: "scim" })
    },
    isExempt: async (_t, userId) => {
      const role = await roles.d.store.roleOf(ACME.tenantId, userId)
      return role === "owner" || role === "admin"
    },
    forget: ({ userId }) => void forgotten.push(userId),
    log,
    now: () => new Date("2026-10-21T10:00:00Z"),
  }
  if (options.mode) void identity.store.setDeprovisionMode(TENANT, options.mode, "u")
  return {
    dirs,
    identity,
    clerk,
    prov,
    members,
    roles,
    deps,
    mail,
    forgotten,
    fail,
    seats,
    joined,
  }
}
type World = ReturnType<typeof world>

/** Entra's shape for a person, with the names Clerk requires. */
const person = (over: Record<string, unknown> = {}) => ({
  schemas: [SCHEMA.user, SCHEMA.enterprise],
  externalId: "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10",
  userName: "ada@acme.test",
  active: true,
  displayName: "Ada Lovelace",
  name: { givenName: "Ada", familyName: "Lovelace" },
  emails: [{ primary: true, type: "work", value: "ada@acme.test" }],
  ...over,
})

async function push(
  w: World,
  payload: Record<string, unknown> = person(),
  directory = DIRECTORY,
): Promise<DirectoryUserRow> {
  // Through JSON, as over HTTP: no undefined, no shared references.
  const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  const made = await w.dirs.store.createUser(TENANT, directory, readUser(body), {
    type: "scim.user.created",
  })
  if (made === "taken") throw new Error("userName taken")
  return made.row
}

async function change(
  w: World,
  id: string,
  ops: Record<string, unknown>[],
  directory = DIRECTORY,
) {
  const done = await w.dirs.store.editUser(
    TENANT,
    directory,
    id,
    (current) =>
      patchUser(current.resource, readPatch({ Operations: ops }), current.id),
    () => ({ type: "scim.user.updated" }),
  )
  if (!done || done === "taken") throw new Error("could not change")
  return done.row
}

const apply = (w: World, id: string) =>
  applyDirectoryUser(w.deps, { tenantId: TENANT, directoryUserId: id })
const stored = (w: World, id: string) => w.dirs.users.find((u) => u.id === id)!
const eventTypes = (w: World) => w.identity.events.map((e) => e.type)
const pendingOf = (w: World, id: string) =>
  w.dirs.outbox.filter((o) => o.directoryUserId === id && !o.appliedAt)

// ── Refusals and conflicts ──────────────────────────────────────────────────

describe("applying: nothing happens", () => {
  it("skips a disabled directory without marking anything applied, and replays when it is enabled", async () => {
    const w = world({ directories: [{ id: DIRECTORY, enabled: false }] })
    const p = await push(w)
    expect(await apply(w, p.id)).toEqual({
      outcome: "skipped",
      action: "directory_disabled",
    })
    expect(pendingOf(w, p.id)).toHaveLength(1)
    expect(w.prov.calls).toEqual([])
    expect(w.clerk.users.size).toBe(0)
    expect(w.members.size).toBe(0)

    w.dirs.directories.get(DIRECTORY)!.enabled = true
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "created",
    })
    expect(pendingOf(w, p.id)).toHaveLength(0)
  })

  it("answers gone for a row that is not there, and for one of another workspace", async () => {
    const w = world()
    const p = await push(w)
    expect(await apply(w, "00000000-0000-4000-8000-0000000000ff")).toEqual({
      outcome: "gone",
      action: "no_such_row",
    })
    expect(
      await applyDirectoryUser(w.deps, {
        tenantId: OTHER_TENANT,
        directoryUserId: p.id,
      }),
    ).toMatchObject({ outcome: "gone" })
    expect(w.clerk.users.size).toBe(0)
  })

  it("does nothing for a row with nothing pending, so a duplicate job is cheap", async () => {
    const w = world()
    const p = await push(w)
    await apply(w, p.id)
    const calls = [...w.prov.calls]
    expect(await apply(w, p.id)).toEqual({
      outcome: "applied",
      action: "nothing_to_do",
    })
    expect(w.prov.calls).toEqual(calls)
  })
})

describe("applying: conflicts, each on the row and in the audit log, none an error", () => {
  const expectConflict = async (
    w: World,
    p: DirectoryUserRow,
    conflict: DirectoryConflict,
  ) => {
    const result = await apply(w, p.id)
    expect(result).toEqual({ outcome: "applied", action: "conflict", conflict })
    expect(stored(w, p.id).conflict).toBe(conflict)
    expect(w.identity.events.filter((e) => e.type === "scim.conflict")).toMatchObject([
      { reason: conflict, data: { directoryId: DIRECTORY, directoryUserId: p.id } },
    ])
    // The entry is applied: a conflict is a state, not a failure to retry.
    expect(pendingOf(w, p.id)).toHaveLength(0)
  }

  it("no_email: nothing to make an account with", async () => {
    const w = world()
    const p = await push(w, {
      userName: "grace",
      active: true,
      name: { givenName: "G", familyName: "H" },
    })
    await expectConflict(w, p, "no_email")
    expect(w.prov.calls).toEqual([])
  })

  it("blocked: the block list wins, and Clerk is not asked a thing", async () => {
    const w = world({ blocked: ["ada@acme.test"], users: [ada()] })
    const asked: string[] = []
    const real = w.clerk.clerk.usersByEmail
    w.clerk.clerk.usersByEmail = async (email) => (asked.push(email), real(email))
    const p = await push(w)
    await expectConflict(w, p, "blocked")
    expect(asked).toEqual([])
    expect(w.prov.calls).toEqual([])
    expect(w.members.size).toBe(0)
    expect(w.identity.managed.size).toBe(0)
  })

  it("no_sso_connection: nobody is made while no active connection covers the address", async () => {
    const w = world({ sso: "testing" })
    const p = await push(w)
    await expectConflict(w, p, "no_sso_connection")
    expect(w.prov.calls).toEqual([])
    expect(w.clerk.users.size).toBe(0)
  })

  it("no_sso_connection: an existing account is not claimed, so its password and sessions stay", async () => {
    const w = world({ sso: "disabled", users: [ada()] })
    const p = await push(w)
    await expectConflict(w, p, "no_sso_connection")
    expect(w.identity.managed.size).toBe(0)
    expect(stored(w, p.id).clerkUserId).toBeNull()
    expect(w.joined).toEqual([])
  })

  it("domain_not_verified when nobody holds the address: no account is made", async () => {
    const w = world({ domains: ["other.test"] })
    const p = await push(w)
    await expectConflict(w, p, "domain_not_verified")
    expect(w.prov.calls).toEqual([])
    expect(w.clerk.users.size).toBe(0)
  })

  it("domain_not_verified when an unrelated account holds the address: not claimed, and not even looked up", async () => {
    const stranger = user({
      id: "user_stranger",
      emails: [{ id: "i", address: "ada@acme.test", verified: true }],
    })
    const w = world({ domains: ["other.test"], users: [stranger] })
    const asked: string[] = []
    const real = w.clerk.clerk.usersByEmail
    w.clerk.clerk.usersByEmail = async (email) => (asked.push(email), real(email))
    const p = await push(w)
    await expectConflict(w, p, "domain_not_verified")
    expect(asked).toEqual([])
    expect(w.identity.managed.size).toBe(0)
    expect(stored(w, p.id).clerkUserId).toBeNull()
  })

  it("domain_not_verified is the same answer on a subdomain the workspace never proved", async () => {
    const w = world({ domains: ["acme.test"] })
    const p = await push(
      w,
      person({
        userName: "ada@eng.acme.test",
        emails: [{ value: "ada@eng.acme.test", primary: true }],
      }),
    )
    await expectConflict(w, p, "domain_not_verified")
  })

  it("profile_incomplete: no given or family name means no Clerk call, and nothing invented from the address", async () => {
    for (const name of [
      { givenName: "Ada" },
      { familyName: "Lovelace" },
      {},
      undefined,
    ]) {
      const w = world()
      const p = await push(w, person({ name }))
      await expectConflict(w, p, "profile_incomplete")
      expect(w.prov.calls).toEqual([])
      expect(w.prov.created).toEqual([])
      expect(w.clerk.users.size).toBe(0)
    }
  })

  it("profile_incomplete: a name of blanks or control characters is no name", async () => {
    const w = world()
    const p = await push(
      w,
      person({ name: { givenName: "   ", familyName: "Lov\u0007lace" } }),
    )
    await expectConflict(w, p, "profile_incomplete")
  })

  it("profile_incomplete: Clerk's form_data_missing is mapped to the same conflict", async () => {
    const w = world()
    w.prov.provisioning.createUser = async () => ({ outcome: "incomplete" })
    const p = await push(w)
    await expectConflict(w, p, "profile_incomplete")
  })

  it("address_taken: Clerk holds the address on an account we may not claim (unverified)", async () => {
    const holder = user({
      id: "user_unverified",
      emails: [{ id: "i", address: "ada@acme.test", verified: false }],
    })
    const w = world({ users: [holder] })
    const p = await push(w)
    await expectConflict(w, p, "address_taken")
    expect(w.prov.calls).toEqual([])
    expect(w.identity.managed.size).toBe(0)
  })

  it("address_taken: Clerk answers form_identifier_exists and the account is still not claimable", async () => {
    const w = world()
    w.prov.hooks.beforeCreate = (email) => {
      w.clerk.users.set(
        "user_late",
        user({
          id: "user_late",
          emails: [{ id: "i", address: email, verified: false }],
        }),
      )
    }
    const p = await push(w)
    await expectConflict(w, p, "address_taken")
    expect(w.prov.created).toEqual([])
  })

  it("claims the account that appeared while we looked, instead of failing (a race with another directory)", async () => {
    const w = world()
    w.prov.hooks.beforeCreate = (email) => {
      w.prov.hooks.beforeCreate = undefined
      w.clerk.users.set(
        "user_racer",
        user({
          id: "user_racer",
          emails: [{ id: "i", address: email, verified: true }],
        }),
      )
    }
    const p = await push(w)
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "claimed",
    })
    expect(stored(w, p.id).clerkUserId).toBe("user_racer")
    expect(w.prov.created).toEqual([])
  })

  it("ambiguous_account: two accounts hold it verified, and neither is picked", async () => {
    const mk = (id: string) =>
      user({
        id,
        emails: [{ id: `i_${id}`, address: "ada@acme.test", verified: true }],
      })
    const w = world({ users: [mk("user_one"), mk("user_two")] })
    const p = await push(w)
    await expectConflict(w, p, "ambiguous_account")
    expect(stored(w, p.id).clerkUserId).toBeNull()
    expect(w.identity.managed.size).toBe(0)
  })

  it("managed_elsewhere: another workspace controls the account", async () => {
    const w = world({ users: [ada()] })
    await w.identity.store.claimManaged(OTHER_TENANT, {
      clerkUserId: "user_ada",
      tenantId: OTHER_TENANT,
      connectionId: null,
      reason: "claimed",
      emails: ["ada@acme.test"],
    })
    const p = await push(w)
    await expectConflict(w, p, "managed_elsewhere")
    expect(w.identity.managed.get("user_ada")!.tenantId).toBe(OTHER_TENANT)
    expect(w.members.has("user_ada")).toBe(false)
    expect(stored(w, p.id).clerkUserId).toBeNull()
  })

  it("role_exempt: an owner or an admin is never claimed by a directory, managed or not", async () => {
    for (const who of [{ owners: ["user_ada"] }, { admins: ["user_ada"] }]) {
      const w = world({ users: [ada()], members: ["user_ada"], ...who })
      const p = await push(w)
      await expectConflict(w, p, "role_exempt")
      expect(w.identity.managed.size).toBe(0)
      expect(stored(w, p.id).clerkUserId).toBeNull()
      expect(w.clerk.calls).toEqual([])
    }
    // Managed already (by SSO), and still not claimed by a directory row that is not linked.
    const w = world({
      users: [ada()],
      members: ["user_ada"],
      owners: ["user_ada", "user_other"],
    })
    await w.identity.store.claimManaged(TENANT, {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "linked",
      emails: ["ada@acme.test"],
    })
    const p = await push(w)
    await expectConflict(w, p, "role_exempt")
  })

  it("banned: a ban that is not ours wins and is not lifted", async () => {
    const w = world({ users: [{ ...ada(), banned: true }] })
    const p = await push(w)
    await expectConflict(w, p, "banned")
    expect(w.prov.calls.filter((c) => c.startsWith("unban"))).toEqual([])
    expect(w.clerk.users.get("user_ada")!.banned).toBe(true)
    expect(w.members.size).toBe(0)
  })

  it("already_linked: another person of the directory is linked to that account", async () => {
    const w = world({ users: [ada()] })
    const first = await push(w)
    await apply(w, first.id)
    const second = await push(
      w,
      person({ userName: "ada.l@acme.test", externalId: "e2" }),
    )
    await expectConflict(w, second, "already_linked")
    expect(stored(w, first.id).clerkUserId).toBe("user_ada")
  })

  it("account_deleted: the Clerk user is gone, and is not made again on our own", async () => {
    const w = world({ users: [ada()] })
    const p = await push(w)
    await apply(w, p.id)
    w.clerk.users.delete("user_ada")
    await change(w, p.id, [{ op: "replace", path: "title", value: "Countess" }])
    await expectConflict(w, p, "account_deleted")
    expect(w.prov.calls.filter((c) => c.startsWith("createUser"))).toEqual([])
    // A later push finds it gone again, quietly: no second audit row.
    await change(w, p.id, [{ op: "replace", path: "title", value: "Countess 2" }])
    expect(await apply(w, p.id)).toMatchObject({ conflict: "account_deleted" })
    expect(w.identity.events.filter((e) => e.type === "scim.conflict")).toHaveLength(1)
    expect(w.prov.created).toEqual([])
  })

  it("a rename to an address the workspace has not proved is domain_not_verified, and to one another account holds is address_taken", async () => {
    const w = world({ users: [ada()] })
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [
      {
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: "ada@elsewhere.test",
      },
    ])
    expect(await apply(w, p.id)).toMatchObject({ conflict: "domain_not_verified" })
    expect(w.prov.calls.some((c) => c.startsWith("addPrimaryEmail"))).toBe(false)

    const holder = user({
      id: "user_new",
      emails: [{ id: "n", address: "ada.new@acme.test", verified: true }],
    })
    w.clerk.users.set("user_new", holder)
    await change(w, p.id, [
      {
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: "ada.new@acme.test",
      },
    ])
    expect(await apply(w, p.id)).toMatchObject({ conflict: "address_taken" })
    expect(w.clerk.users.get("user_ada")!.emails.map((e) => e.address)).toEqual([
      "ada@acme.test",
    ])
  })

  it("a conflict that clears is audited as resolved, once", async () => {
    const w = world({ users: [ada()], blocked: ["ada@acme.test"] })
    const p = await push(w)
    await apply(w, p.id)
    expect(stored(w, p.id).conflict).toBe("blocked")
    // Same state again: no new audit row.
    await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
    await apply(w, p.id)
    expect(w.identity.events.filter((e) => e.type === "scim.conflict")).toHaveLength(1)
    // The block is lifted at the workspace; the next push provisions the person.
    const lifted = world({ users: [ada()] })
    const q = await push(lifted)
    stored(lifted, q.id).conflict = "blocked"
    await apply(lifted, q.id)
    expect(stored(lifted, q.id).conflict).toBeNull()
    expect(
      lifted.identity.events.filter((e) => e.type === "scim.conflict_resolved"),
    ).toMatchObject([{ reason: "blocked" }])
  })
})

describe("applying: a full workspace", () => {
  it("accepts the person, files the waiting list, and joins them once there is room", async () => {
    const w = world({ users: [ada()], full: true })
    const p = await push(w)
    const result = await apply(w, p.id)
    expect(result).toEqual({
      outcome: "applied",
      action: "conflict",
      conflict: "workspace_full",
    })
    expect(w.members.has("user_ada")).toBe(false)
    expect(w.dirs.waitlist).toEqual([
      { tenantId: TENANT, userId: "user_ada", email: "ada@acme.test", answered: null },
    ])
    // They exist, are linked and are managed (as JIT does): only the seat is missing.
    expect(stored(w, p.id).clerkUserId).toBe("user_ada")
    expect(w.identity.managed.get("user_ada")).toBeDefined()
    expect(w.joined).toEqual([])

    w.seats.full = false
    await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "updated",
    })
    expect(w.members.has("user_ada")).toBe(true)
    expect(w.dirs.waitlist[0]!.answered).toBe(true)
    expect(stored(w, p.id).conflict).toBeNull()
  })

  it("files it once when Clerk's own limit says full after ours said room", async () => {
    const w = world({ users: [ada()] })
    w.deps.join = async () => "full"
    const p = await push(w)
    expect(await apply(w, p.id)).toMatchObject({ conflict: "workspace_full" })
    await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
    await apply(w, p.id)
    expect(w.dirs.waitlist).toHaveLength(1)
  })

  it("does not waitlist somebody who is already a member of a full workspace", async () => {
    const w = world({ users: [ada()], full: true, members: ["user_ada"] })
    const p = await push(w)
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "claimed",
    })
    expect(w.dirs.waitlist).toEqual([])
    expect(w.seats.asked).toBe(0)
  })
})

describe("applying: failures are retried, not recorded as conflicts", () => {
  it("counts a Clerk failure on the entry, rethrows, leaves it unapplied, and finishes on retry", async () => {
    const w = world()
    const p = await push(w)
    w.prov.fail.createUser = true
    await expect(apply(w, p.id)).rejects.toThrow("clerk down")
    const entry = w.dirs.outbox.find((o) => o.directoryUserId === p.id)!
    expect(entry).toMatchObject({ attempts: 1, lastError: "Error", appliedAt: null })
    expect(stored(w, p.id).conflict).toBeNull()
    expect(w.identity.events.filter((e) => e.type === "scim.conflict")).toEqual([])

    w.prov.fail.createUser = false
    expect(await apply(w, p.id)).toMatchObject({ action: "created" })
    expect(entry.appliedAt).not.toBeNull()
    expect(w.clerk.users.size).toBe(1)
  })

  it("keeps a Clerk error's code, never its message, as the reason", async () => {
    const w = world()
    const p = await push(w)
    w.prov.provisioning.createUser = async () => {
      throw Object.assign(new Error("ada@acme.test is invalid"), {
        errors: [{ code: "rate_limit_exceeded" }],
      })
    }
    await expect(apply(w, p.id)).rejects.toThrow()
    const reason = w.dirs.outbox.find((o) => o.directoryUserId === p.id)!.lastError
    expect(reason).toBe("rate_limit_exceeded")
    expect(reason).not.toContain("ada@")
  })

  it("an unconfirmed removal is thrown for retry, never swallowed", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    w.fail.unconfirmed = true
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await expect(apply(w, p.id)).rejects.toThrow("unconfirmed")
    expect(pendingOf(w, p.id).length).toBeGreaterThan(0)
  })

  it("marks applied only up to what it read: a change landing meanwhile keeps its own entry", async () => {
    const w = world({ users: [ada()] })
    const p = await push(w)
    const real = w.clerk.clerk.usersByEmail
    w.clerk.clerk.usersByEmail = async (email) => {
      // A PATCH from the IdP arrives while the job is talking to Clerk.
      await change(w, p.id, [{ op: "replace", path: "title", value: "mid-flight" }])
      return real(email)
    }
    await apply(w, p.id)
    const entries = w.dirs.outbox.filter((o) => o.directoryUserId === p.id)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.appliedAt).not.toBeNull()
    expect(entries[1]!.appliedAt).toBeNull()
    // The next job picks it up.
    w.clerk.clerk.usersByEmail = real
    await apply(w, p.id)
    expect(pendingOf(w, p.id)).toHaveLength(0)
  })
})

// ── Providing ───────────────────────────────────────────────────────────────

describe("applying: a new person", () => {
  it("creates the Clerk account, links it, manages it, and adds the member with the default role from the directory", async () => {
    const w = world()
    const p = await push(w)
    const result = await apply(w, p.id)
    expect(result).toEqual({ outcome: "applied", action: "created" })

    expect(w.prov.created).toEqual([
      {
        email: "ada@acme.test",
        firstName: "Ada",
        lastName: "Lovelace",
        externalId: p.id,
      },
    ])
    const row = stored(w, p.id)
    expect(row.clerkUserId).toBe("user_scim_1")
    expect(row.conflict).toBeNull()
    expect(pendingOf(w, p.id)).toHaveLength(0)
    expect(w.identity.managed.get("user_scim_1")).toMatchObject({
      tenantId: TENANT,
      reason: "scim",
      connectionId: null,
      emails: ["ada@acme.test"],
    })
    expect(w.joined).toEqual([{ userId: "user_scim_1", role: "member" }])
    expect(w.roles.rows()).toMatchObject([
      {
        userId: "user_scim_1",
        role: "member",
        source: "scim",
        membershipId: "mem_user_scim_1",
      },
    ])
    expect(w.forgotten).toEqual(["user_scim_1"])
    expect(eventTypes(w)).toEqual([
      "scim.account_created",
      "managed.claimed",
      "managed.enforced",
      "scim.member_added",
    ])
  })

  it("is idempotent: applying again changes nothing and creates nobody twice", async () => {
    const w = world()
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
    expect(await apply(w, p.id)).toEqual({ outcome: "applied", action: "updated" })
    expect(w.prov.created).toHaveLength(1)
    expect(w.joined).toHaveLength(1)
  })

  it("finishes after a crash between creating the account and linking it: the retry claims it", async () => {
    const w = world()
    const p = await push(w)
    const real = w.dirs.store.linkUser
    w.dirs.store.linkUser = async () => {
      throw new Error("database down")
    }
    await expect(apply(w, p.id)).rejects.toThrow("database down")
    expect(w.clerk.users.has("user_scim_1")).toBe(true)
    expect(stored(w, p.id).clerkUserId).toBeNull()
    w.dirs.store.linkUser = real
    expect(await apply(w, p.id)).toMatchObject({ outcome: "applied" })
    expect(stored(w, p.id).clerkUserId).toBe("user_scim_1")
    expect(w.prov.created).toHaveLength(1)
  })

  it("claims an existing member who holds the address verified: sessions end, other ways in go", async () => {
    const w = world({
      users: [{ ...ada(), passwordEnabled: true, phoneIds: ["ph_1"] }],
      members: ["user_ada"],
    })
    w.clerk.active.set("user_ada", [{ id: "sess_old", createdAt: new Date() }])
    const p = await push(w)
    expect(await apply(w, p.id)).toEqual({ outcome: "applied", action: "claimed" })
    expect(stored(w, p.id).clerkUserId).toBe("user_ada")
    expect(w.clerk.calls).toContain("revokeSession:sess_old")
    expect(w.clerk.calls).toContain("removePassword:user_ada")
    expect(w.clerk.calls).toContain("deletePhone:ph_1")
    expect(w.identity.managed.get("user_ada")).toMatchObject({
      reason: "scim",
      connectionId: null,
    })
    // Already a member: no join, no role written, no waiting.
    expect(w.joined).toEqual([])
    expect(w.roles.rows()).toEqual([])
    expect(eventTypes(w)).toContain("managed.claimed")
    expect(w.prov.created).toEqual([])
  })

  it("keeps a managed person managed on later pushes, without revoking their sessions again", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    w.clerk.calls.length = 0
    await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
    await apply(w, p.id)
    expect(w.clerk.calls.filter((c) => c.startsWith("revokeSession"))).toEqual([])
    expect(eventTypes(w).filter((t) => t === "managed.claimed")).toHaveLength(1)
  })

  it("follows a rename: the new address is added primary and listed for the managed account", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [
      {
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: "ada.king@acme.test",
      },
    ])
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "updated",
    })
    expect(w.prov.calls).toContain("addPrimaryEmail:user_ada:ada.king@acme.test")
    const managed = w.identity.managed.get("user_ada")!
    expect(managed.emails[0]).toBe("ada.king@acme.test")
    expect(eventTypes(w)).toContain("scim.email_changed")
    expect(stored(w, p.id).conflict).toBeNull()
  })

  it("makes a verified address the primary when the account already holds it", async () => {
    const two = user({
      id: "user_ada",
      primaryEmailId: "e1",
      emails: [
        { id: "e1", address: "ada@acme.test", verified: true },
        { id: "e2", address: "ada.king@acme.test", verified: true },
      ],
    })
    const w = world({ users: [two], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [
      {
        op: "replace",
        path: 'emails[type eq "work"].value',
        value: "ada.king@acme.test",
      },
    ])
    await apply(w, p.id)
    expect(w.prov.calls).toContain("makePrimary:user_ada:e2")
    expect(w.prov.calls.some((c) => c.startsWith("addPrimaryEmail"))).toBe(false)
  })

  it("syncs the directory's names to Clerk, and audits it without the names", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [{ op: "replace", path: "name.familyName", value: "King" }])
    await apply(w, p.id)
    expect(w.clerk.profiles).toEqual([
      { userId: "user_ada", names: { lastName: "King" } },
    ])
    const event = w.identity.events.find((e) => e.type === "scim.profile_updated")!
    expect(JSON.stringify(event)).not.toContain("King")
  })

  it("lifts a ban of its own on reactivation, and only that one", async () => {
    const w = world({ users: [ada()], members: ["user_ada"], mode: "account" })
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(w.clerk.users.get("user_ada")!.banned).toBe(true)
    expect(stored(w, p.id).bannedByDirectory).toBe(true)

    await change(w, p.id, [{ op: "replace", value: { active: true } }])
    expect(await apply(w, p.id)).toMatchObject({ outcome: "applied" })
    expect(w.clerk.users.get("user_ada")!.banned).toBe(false)
    expect(w.prov.calls).toContain("unban:user_ada")
    expect(stored(w, p.id).bannedByDirectory).toBe(false)
    expect(eventTypes(w)).toContain("scim.unbanned")
  })
})

// ── Deprovisioning ──────────────────────────────────────────────────────────

describe("applying: a person switched off", () => {
  async function provisioned(options: WorldOptions = {}) {
    const w = world({ users: [ada()], members: ["user_ada"], ...options })
    const p = await push(w)
    await apply(w, p.id)
    const sid = "sess_ada"
    await w.identity.store.bindSession(TENANT, {
      sessionId: sid,
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: null,
      at: new Date(),
      freshAt: new Date(),
    })
    return { w, p }
  }

  it("membership mode: sessions end, the membership goes, the account is released and keeps its other workspaces", async () => {
    const { w, p } = await provisioned()
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    expect(await apply(w, p.id)).toEqual({
      outcome: "applied",
      action: "deprovisioned",
    })
    expect(w.members.has("user_ada")).toBe(false)
    expect(w.identity.managed.has("user_ada")).toBe(false)
    expect(w.clerk.calls).toContain("revokeSession:sess_ada")
    expect(w.clerk.users.get("user_ada")!.banned).toBe(false)
    expect(w.forgotten.at(-1)).toBe("user_ada")
    expect(
      w.identity.events.find((e) => e.type === "member.deprovisioned"),
    ).toMatchObject({ actorUserId: null, reason: "scim", data: { mode: "membership" } })
    expect(stored(w, p.id).bannedByDirectory).toBe(false)
    expect(pendingOf(w, p.id)).toHaveLength(0)
  })

  it("account mode: the Clerk user is banned and the ban is remembered as ours", async () => {
    const { w, p } = await provisioned({ mode: "account" })
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(w.clerk.users.get("user_ada")!.banned).toBe(true)
    expect(stored(w, p.id).bannedByDirectory).toBe(true)
    expect(w.identity.managed.has("user_ada")).toBe(true)
  })

  it("account mode: a ban staff had already placed is not taken over, so reactivation leaves it", async () => {
    const { w, p } = await provisioned({ mode: "account" })
    w.clerk.users.get("user_ada")!.banned = true
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(stored(w, p.id).bannedByDirectory).toBe(false)
    await change(w, p.id, [{ op: "replace", value: { active: true } }])
    expect(await apply(w, p.id)).toMatchObject({ conflict: "banned" })
    expect(w.clerk.users.get("user_ada")!.banned).toBe(true)
    expect(w.prov.calls.some((c) => c.startsWith("unban"))).toBe(false)
  })

  it("reactivation: the person comes back in, managed again, with the default role", async () => {
    const { w, p } = await provisioned()
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    await change(w, p.id, [{ op: "replace", value: { active: true } }])
    expect(await apply(w, p.id)).toMatchObject({ outcome: "applied" })
    expect(w.members.has("user_ada")).toBe(true)
    expect(w.identity.managed.get("user_ada")).toMatchObject({ reason: "scim" })
    expect(w.joined.at(-1)).toEqual({ userId: "user_ada", role: "member" })
    expect(w.prov.created).toEqual([])
  })

  it("the last owner stays, visibly: sessions end, the conflict is on the row, the row stays when deleted too", async () => {
    const w = world({ users: [ada()], members: ["user_ada"], owners: ["user_ada"] })
    // The owner is linked to the row by an earlier sign-in, not claimed by the directory.
    const p = await push(w)
    await w.dirs.store.linkUser(TENANT, p.id, "user_ada")
    await w.identity.store.claimManaged(TENANT, {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "linked",
      emails: ["ada@acme.test"],
    })
    await w.identity.store.bindSession(TENANT, {
      sessionId: "sess_owner",
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: null,
      at: new Date(),
      freshAt: new Date(),
    })
    stored(w, p.id).active = false
    w.dirs.outbox.push({
      id: "00000000-0000-7000-9000-000000000001",
      directoryUserId: p.id,
      directoryId: DIRECTORY,
      tenantId: TENANT,
      cause: "updated",
      createdAt: new Date(),
      appliedAt: null,
      attempts: 0,
      lastError: null,
    })
    expect(await apply(w, p.id)).toEqual({
      outcome: "applied",
      action: "conflict",
      conflict: "last_owner",
    })
    expect(w.members.has("user_ada")).toBe(true)
    expect(w.clerk.calls).toContain("revokeSession:sess_owner")
    expect(stored(w, p.id).conflict).toBe("last_owner")
    expect(w.identity.events.find((e) => e.reason === "last_owner")).toBeDefined()

    // A repeated push does not let the row vote against itself.
    w.dirs.outbox.push({
      id: "00000000-0000-7000-9000-000000000002",
      directoryUserId: p.id,
      directoryId: DIRECTORY,
      tenantId: TENANT,
      cause: "updated",
      createdAt: new Date(),
      appliedAt: null,
      attempts: 0,
      lastError: null,
    })
    expect(await apply(w, p.id)).toMatchObject({ conflict: "last_owner" })

    // Deleted in the IdP: the row stays so the conflict stays visible.
    await w.dirs.store.deleteUser(TENANT, DIRECTORY, p.id, {
      type: "scim.user.deleted",
    })
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "retained",
      conflict: "last_owner",
    })
    expect(stored(w, p.id).deletedAt).not.toBeNull()
    expect(stored(w, p.id).conflict).toBe("last_owner")
  })

  it("does not take out somebody this workspace does not manage", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await w.dirs.store.linkUser(TENANT, p.id, "user_ada")
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "deprovisioned",
    })
    expect(w.members.has("user_ada")).toBe(true)
    expect(w.clerk.users.get("user_ada")!.banned).toBe(false)
  })

  it("an inactive person who was never provisioned needs nothing", async () => {
    const w = world()
    const p = await push(w, person({ active: false }))
    expect(await apply(w, p.id)).toEqual({
      outcome: "applied",
      action: "nothing_to_do",
    })
    expect(w.clerk.users.size).toBe(0)
    expect(w.prov.calls).toEqual([])
  })

  it("an inactive person's stale conflict is cleared", async () => {
    const w = world({ blocked: ["ada@acme.test"] })
    const p = await push(w)
    await apply(w, p.id)
    expect(stored(w, p.id).conflict).toBe("blocked")
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    expect(await apply(w, p.id)).toMatchObject({ outcome: "applied" })
    expect(stored(w, p.id).conflict).toBeNull()
  })

  it("two directories vote: active while any enabled one says active", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const a = await push(w, person(), DIRECTORY)
    const b = await push(w, person({ externalId: "other-id" }), OTHER_DIRECTORY)
    await apply(w, a.id)
    await apply(w, b.id)
    expect(stored(w, a.id).clerkUserId).toBe("user_ada")
    expect(stored(w, b.id).clerkUserId).toBe("user_ada")

    await change(w, a.id, [{ op: "replace", value: { active: false } }])
    expect(await apply(w, a.id)).toEqual({
      outcome: "applied",
      action: "kept_by_other_directory",
    })
    expect(w.members.has("user_ada")).toBe(true)
    expect(w.identity.managed.has("user_ada")).toBe(true)

    await change(
      w,
      b.id,
      [{ op: "replace", value: { active: false } }],
      OTHER_DIRECTORY,
    )
    expect(await apply(w, b.id)).toEqual({
      outcome: "applied",
      action: "deprovisioned",
    })
    expect(w.members.has("user_ada")).toBe(false)
  })

  it("a disabled directory no longer votes", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const a = await push(w, person(), DIRECTORY)
    const b = await push(w, person({ externalId: "other-id" }), OTHER_DIRECTORY)
    await apply(w, a.id)
    await apply(w, b.id)
    w.dirs.directories.get(OTHER_DIRECTORY)!.enabled = false
    await change(w, a.id, [{ op: "replace", value: { active: false } }])
    expect(await apply(w, a.id)).toMatchObject({ action: "deprovisioned" })
  })
})

describe("applying: a person deleted in the directory", () => {
  it("deprovisions in membership mode, forgets their identity links, and purges the row", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    await w.identity.store.link(TENANT, {
      connectionId: CONNECTION,
      subject: "okta|ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
    })
    await w.dirs.store.deleteUser(TENANT, DIRECTORY, p.id, {
      type: "scim.user.deleted",
    })
    expect(await apply(w, p.id)).toEqual({ outcome: "applied", action: "purged" })
    expect(w.dirs.users.find((u) => u.id === p.id)).toBeUndefined()
    expect(w.dirs.outbox.filter((o) => o.directoryUserId === p.id)).toEqual([])
    expect(w.members.has("user_ada")).toBe(false)
    expect(w.identity.identities).toEqual([])
    expect(w.identity.managed.has("user_ada")).toBe(false)
  })

  it("account mode keeps the deleted row only to remember the ban, and drops it when a new row lifts it", async () => {
    const w = world({ users: [ada()], members: ["user_ada"], mode: "account" })
    const p = await push(w)
    await apply(w, p.id)
    await w.dirs.store.deleteUser(TENANT, DIRECTORY, p.id, {
      type: "scim.user.deleted",
    })
    expect(await apply(w, p.id)).toMatchObject({
      outcome: "applied",
      action: "retained",
    })
    expect(w.clerk.users.get("user_ada")!.banned).toBe(true)
    expect(stored(w, p.id).deletedAt).not.toBeNull()

    // Re-hired: a new row for the same address. The ban is the directory's, so it is lifted.
    const again = await push(w)
    expect(await apply(w, again.id)).toMatchObject({ outcome: "applied" })
    expect(w.clerk.users.get("user_ada")!.banned).toBe(false)
    expect(w.dirs.users.find((u) => u.id === p.id)).toBeUndefined()
    expect(stored(w, again.id).clerkUserId).toBe("user_ada")
  })

  it("purges a row that never had an account, and one whose person another directory keeps", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const never = await push(
      w,
      person({ userName: "nobody@acme.test", emails: [{ value: "nobody@acme.test" }] }),
    )
    await w.dirs.store.deleteUser(TENANT, DIRECTORY, never.id, {
      type: "scim.user.deleted",
    })
    expect(await apply(w, never.id)).toEqual({ outcome: "applied", action: "purged" })

    const a = await push(w, person(), DIRECTORY)
    const b = await push(w, person({ externalId: "x" }), OTHER_DIRECTORY)
    await apply(w, a.id)
    await apply(w, b.id)
    await w.dirs.store.deleteUser(TENANT, DIRECTORY, a.id, {
      type: "scim.user.deleted",
    })
    expect(await apply(w, a.id)).toEqual({ outcome: "applied", action: "purged" })
    expect(w.members.has("user_ada")).toBe(true)
  })

  it("an account already deleted at Clerk is forgotten here and the row purged", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    w.clerk.users.delete("user_ada")
    await w.dirs.store.deleteUser(TENANT, DIRECTORY, p.id, {
      type: "scim.user.deleted",
    })
    expect(await apply(w, p.id)).toEqual({ outcome: "applied", action: "purged" })
    expect(w.identity.managed.has("user_ada")).toBe(false)
  })
})

// ── The bridge's hooks ──────────────────────────────────────────────────────

describe("directory hooks for the sign-in bridge", () => {
  const ctx = (subject: string, email = "ada@acme.test") => ({
    tenantId: TENANT,
    connection: connection(),
    assertion: {
      subject,
      email,
      emailVerified: true,
      groupsState: "present",
      authTime: null,
    } as Assertion,
    email,
  })
  const warnings: object[] = []
  const hook = (w: World) =>
    directoryPreProvisioned({
      store: w.dirs.store,
      log: { ...log, warn: (o) => void warnings.push(o) },
    })

  it("finds nobody for a stranger", async () => {
    const w = world()
    expect(await hook(w)(ctx("okta|nobody", "nobody@acme.test"))).toBeNull()
  })

  it("finds the account a directory linked, by subject (externalId or userName) before address", async () => {
    const w = world({
      users: [
        ada(),
        user({
          id: "user_bob",
          emails: [{ id: "b", address: "bob@acme.test", verified: true }],
        }),
      ],
    })
    const adaRow = await push(w)
    await apply(w, adaRow.id)
    expect(await hook(w)(ctx("8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10"))).toBe("user_ada")
    expect(await hook(w)(ctx("ada()@acme.test"))).toBe("user_ada")
    // A different subject with the same address still finds her by address.
    expect(await hook(w)(ctx("someone-else"))).toBe("user_ada")
    // A subject that names Bob wins over an address that names Ada.
    const bob = await push(
      w,
      person({
        userName: "bob@acme.test",
        externalId: "bob-ext",
        emails: [{ value: "bob@acme.test", primary: true }],
        name: { givenName: "Bob", familyName: "B" },
      }),
    )
    await apply(w, bob.id)
    expect(await hook(w)(ctx("bob-ext", "ada@acme.test"))).toBe("user_bob")
  })

  it("is not used when several accounts match one subject", async () => {
    const w = world()
    const a = await push(w, person({ externalId: "same" }), DIRECTORY)
    const b = await push(
      w,
      person({
        externalId: "same",
        userName: "ada2@acme.test",
        emails: [{ value: "ada2@acme.test" }],
      }),
      OTHER_DIRECTORY,
    )
    await w.dirs.store.linkUser(TENANT, a.id, "user_one")
    await w.dirs.store.linkUser(TENANT, b.id, "user_two")
    expect(await hook(w)(ctx("same"))).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it("refuses a person the directory has switched off: deprovisioned, never claimed or made again", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w)
    await apply(w, p.id)
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(await hook(w)(ctx("someone-else"))).toBe("deprovisioned")
    expect(await hook(w)(ctx("8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10"))).toBe(
      "deprovisioned",
    )
    // Also when the account was never made: the address alone is enough.
    const never = world()
    await push(never, person({ active: false }))
    expect(await hook(never)(ctx("whoever"))).toBe("deprovisioned")
    // And the account-level check the bridge makes for every resolved account.
    expect(
      await directoryDeprovisioned({ store: w.dirs.store })(TENANT, "user_ada"),
    ).toBe(true)
    expect(
      await directoryDeprovisioned({ store: w.dirs.store })(TENANT, "user_unknown"),
    ).toBe(false)
  })

  it("lets a person through who another enabled directory still has active", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const a = await push(w, person(), DIRECTORY)
    const b = await push(w, person({ externalId: "x" }), OTHER_DIRECTORY)
    await apply(w, a.id)
    await apply(w, b.id)
    await change(w, a.id, [{ op: "replace", value: { active: false } }])
    await apply(w, a.id)
    expect(await hook(w)(ctx("someone"))).toBe("user_ada")
    expect(
      await directoryDeprovisioned({ store: w.dirs.store })(TENANT, "user_ada"),
    ).toBe(false)
  })

  it("ignores a disabled directory", async () => {
    const w = world({ users: [ada()], members: ["user_ada"] })
    const p = await push(w, person({ active: false }))
    w.dirs.directories.get(DIRECTORY)!.enabled = false
    expect(await hook(w)(ctx("x"))).toBeNull()
    void p
  })

  it("does not lock the last owner out of SSO when a directory switched them off", async () => {
    const w = world({ users: [ada()], members: ["user_ada"], owners: ["user_ada"] })
    const p = await push(w, person({ active: false }))
    await w.dirs.store.linkUser(TENANT, p.id, "user_ada")
    stored(w, p.id).conflict = "last_owner"
    expect(await hook(w)(ctx("x"))).toBe("user_ada")
    expect(
      await directoryDeprovisioned({ store: w.dirs.store })(TENANT, "user_ada"),
    ).toBe(false)
  })
})

// ── Scheduling ──────────────────────────────────────────────────────────────

describe("scheduling and the kick", () => {
  const enqueued: { job: object; bucket: number | null }[] = []
  const errors: object[] = []
  const logger = { ...log, error: (o: object) => void errors.push(o) }

  it("schedules each committed entry, and a Redis failure is logged, not thrown", async () => {
    enqueued.length = 0
    errors.length = 0
    const entries = [
      { id: "e1", directoryUserId: "u1" },
      { id: "e2", directoryUserId: "u2" },
    ]
    await scheduleEntries(
      {
        enqueue: async (job, bucket) => {
          if (job.directoryUserId === "u2") throw new Error("redis down")
          enqueued.push({ job, bucket })
        },
        log: logger,
      },
      TENANT,
      entries,
    )
    expect(enqueued).toEqual([
      { job: { tenantId: TENANT, directoryUserId: "u1", entryId: "e1" }, bucket: null },
    ])
    expect(errors).toHaveLength(1)
  })

  it("re-schedules entries nobody applied, under a bucketed job, throttled per directory, forced by the console", async () => {
    const w = world()
    enqueued.length = 0
    errors.length = 0
    const p = await push(w)
    let clock = new Date("2026-10-21T10:00:00Z")
    w.dirs.setClock(new Date("2026-10-21T09:00:00Z"))
    const q = await push(w, person({ userName: "grace@acme.test", externalId: "g" }))
    w.dirs.setClock(new Date("2026-10-21T10:00:00Z"))
    const kick = directoryKicker({
      store: w.dirs.store,
      enqueue: async (job, bucket) => void enqueued.push({ job, bucket }),
      log: logger,
      now: () => clock,
    })
    // Only the entry older than the grace period is picked up.
    expect(await kick(TENANT, DIRECTORY)).toBe(1)
    expect(enqueued).toMatchObject([
      { job: { directoryUserId: q.id }, bucket: Math.floor(clock.getTime() / 60_000) },
    ])
    // Throttled inside a minute, unless forced.
    expect(await kick(TENANT, DIRECTORY)).toBe(0)
    expect(await kick(TENANT, DIRECTORY, { force: true })).toBe(1)
    clock = new Date(clock.getTime() + KICK_EVERY_MS + 1)
    expect(await kick(TENANT, DIRECTORY)).toBe(2)
    expect(KICK_AFTER_MS).toBeGreaterThan(0)
    void p
  })

  describe("retrying the waiting list", () => {
    /** Three people: two parked as workspace_full (dave first), one as role_exempt. */
    async function parked() {
      const w = world()
      const at = new Date("2026-10-21T10:00:00Z")
      w.dirs.setClock(at)
      const dave = await push(
        w,
        person({ userName: "dave@acme.test", externalId: "d" }),
      )
      const erin = await push(
        w,
        person({ userName: "erin@acme.test", externalId: "e" }),
      )
      const admin = await push(
        w,
        person({ userName: "root@acme.test", externalId: "r" }),
      )
      stored(w, dave.id).conflict = "workspace_full"
      stored(w, erin.id).conflict = "workspace_full"
      stored(w, admin.id).conflict = "role_exempt"
      // The real store answers newest first.
      const store = { ...w.dirs.store }
      store.conflicts = async (t, d) => (await w.dirs.store.conflicts(t, d)).reverse()
      const requeued: string[] = []
      store.requeue = async (t, d, id) => {
        requeued.push(id)
        return w.dirs.store.requeue(t, d, id)
      }
      return { store, requeued, dave, erin, at }
    }
    const jobs: string[] = []
    const kicker = (
      p: Awaited<ReturnType<typeof parked>>,
      room?: (tenantId: string) => Promise<boolean>,
    ) =>
      directoryKicker({
        store: p.store,
        enqueue: async (job) =>
          void jobs.push((job as { directoryUserId: string }).directoryUserId),
        log: logger,
        room,
        now: () => p.at,
      })

    it("requeues the workspace_full rows, oldest first, once there is room", async () => {
      jobs.length = 0
      const p = await parked()
      let asked = 0
      const kick = kicker(p, async () => (asked++, true))
      expect(await kick(TENANT, DIRECTORY, { force: true })).toBe(2)
      expect(p.requeued).toEqual([p.dave.id, p.erin.id])
      expect(jobs).toEqual([p.dave.id, p.erin.id])
      expect(asked).toBe(1)
    })

    it("asks once and requeues nothing when the workspace is still full", async () => {
      jobs.length = 0
      const p = await parked()
      let asked = 0
      const kick = kicker(p, async () => (asked++, false))
      expect(await kick(TENANT, DIRECTORY, { force: true })).toBe(0)
      expect(p.requeued).toEqual([])
      expect(jobs).toEqual([])
      expect(asked).toBe(1)
    })

    it("does nothing about the waiting list without a room check", async () => {
      jobs.length = 0
      const p = await parked()
      expect(await kicker(p)(TENANT, DIRECTORY, { force: true })).toBe(0)
      expect(p.requeued).toEqual([])
    })

    it("does not ask for room when the kick is throttled", async () => {
      jobs.length = 0
      const p = await parked()
      let asked = 0
      const kick = kicker(p, async () => (asked++, true))
      await kick(TENANT, DIRECTORY)
      expect(asked).toBe(1)
      expect(await kick(TENANT, DIRECTORY)).toBe(0)
      expect(asked).toBe(1)
    })

    it("logs and returns zero when the room check fails", async () => {
      jobs.length = 0
      errors.length = 0
      const p = await parked()
      const kick = kicker(p, async () => {
        throw new Error("clerk down")
      })
      expect(await kick(TENANT, DIRECTORY, { force: true })).toBe(0)
      expect(errors).toHaveLength(1)
    })
  })

  it("never throws when the database or the queue fail", async () => {
    const w = world()
    await push(w)
    w.dirs.setClock(new Date("2026-10-21T09:00:00Z"))
    errors.length = 0
    const kick = directoryKicker({
      store: w.dirs.store,
      enqueue: async () => {
        throw new Error("redis down")
      },
      log: logger,
      now: () => new Date("2026-10-21T10:00:00Z"),
    })
    w.dirs.store.pending = async () => [{ id: "e", directoryUserId: "u" }]
    expect(await kick(TENANT, DIRECTORY, { force: true })).toBe(0)
    w.dirs.store.pending = async () => {
      throw new Error("database down")
    }
    expect(await kick(TENANT, DIRECTORY, { force: true })).toBe(0)
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Mail from the directory (#344, slice B) ─────────────────────────────────

describe("mail from the directory", () => {
  const MAIL_DIRECTORY = [
    { id: DIRECTORY, createMailboxes: true },
    { id: OTHER_DIRECTORY },
  ]

  /** A world whose directory opted in (or not), with the real provisioning over the fakes. */
  function mailWorld(
    options: WorldOptions & {
      hosted?: Record<string, string>
      limit?: boolean
      optIn?: boolean
    } = {},
  ) {
    const w = world({
      users: [ada()],
      members: ["user_ada"],
      directories: options.optIn === false ? undefined : MAIL_DIRECTORY,
      ...options,
    })
    if (options.hosted) {
      w.mail.hosted.clear()
      for (const [domain, tenant] of Object.entries(options.hosted))
        w.mail.hosted.set(domain, tenant)
    }
    realProvisioning(w.mail, w.clerk.users, options.limit ? { limit: true } : {})
    return w
  }
  const types = (w: World) => w.mail.types()

  // ── Refusals first ──

  it("makes NO mailbox unless the directory opted in", async () => {
    const w = mailWorld({ optIn: false })
    const p = await push(w)
    await apply(w, p.id)
    expect(w.mail.accounts.size).toBe(0)
    expect(w.mail.delivers("ada@acme.test")).toBe(false)
    expect(types(w)).not.toContain("mailbox.created")
  })

  it("makes NO mailbox for an address off a domain the workspace hosts mail for, and says so on the row and in the audit log, once", async () => {
    const w = mailWorld({ hosted: { "other.test": TENANT } })
    const p = await push(w)
    await apply(w, p.id)
    expect(w.mail.accounts.size).toBe(0)
    expect(w.mail.notes.get(p.id)).toBe("domain_not_hosted")
    // The person is otherwise fully in: this is not a conflict.
    expect(stored(w, p.id).conflict).toBeNull()
    expect(w.members.has("user_ada")).toBe(true)
    await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
    await apply(w, p.id)
    expect(types(w).filter((t) => t === "mailbox.refused")).toHaveLength(1)
  })

  it("makes NO mailbox on a domain ANOTHER workspace hosts (a directory cannot reach into someone else's)", async () => {
    const w = mailWorld({ hosted: { "acme.test": OTHER_TENANT } })
    const p = await push(w)
    await apply(w, p.id)
    expect(w.mail.accounts.size).toBe(0)
    expect(w.mail.notes.get(p.id)).toBe("domain_not_hosted")
  })

  it("makes NO mailbox over the plan's mailbox limit, and none for an address somebody else already holds", async () => {
    const full = mailWorld({ limit: true })
    const a = await push(full)
    await apply(full, a.id)
    expect(full.mail.accounts.size).toBe(0)
    expect(full.mail.notes.get(a.id)).toBe("limit")

    const taken = mailWorld()
    taken.mail.give("user_other", "ada@acme.test")
    const b = await push(taken)
    await apply(taken, b.id)
    expect(taken.mail.accounts.has("user_ada")).toBe(false)
    expect(taken.mail.notes.get(b.id)).toBe("address_taken")
  })

  it("makes NO mailbox for somebody who is not in: a full workspace stops before it", async () => {
    const w = mailWorld({ full: true, members: [] })
    const p = await push(w)
    await apply(w, p.id)
    expect(stored(w, p.id).conflict).toBe("workspace_full")
    expect(w.mail.accounts.size).toBe(0)
  })

  // ── The mailbox ──

  it("gives the person their mailbox before they ever sign in: it receives, and only the hosted aliases come with it", async () => {
    const w = mailWorld()
    const p = await push(
      w,
      person({
        emails: [
          { primary: true, type: "work", value: "ada@acme.test" },
          { type: "other", value: "Ada.L@ACME.test" },
          { type: "other", value: "ada@gmail.com" },
          { type: "other", value: "not an address" },
          { type: "other", value: "ada@acme.test" },
        ],
      }),
    )
    await apply(w, p.id)
    expect(w.mail.delivers("ada@acme.test")).toBe(true)
    expect(w.mail.canLogin("user_ada")).toBe(true)
    expect([...w.mail.accounts.get("user_ada")!.aliases]).toEqual(["ada.l@acme.test"])
    expect(w.mail.delivers("ada.l@acme.test")).toBe(true)
    expect(w.mail.delivers("ada@gmail.com")).toBe(false)
    // The ignored ones are counted on the row, not stored.
    expect(w.mail.ignored.get(p.id)).toBe(2)
    expect(types(w)).toContain("mailbox.created")
    expect(types(w)).toContain("mailbox.aliases_changed")
  })

  it("an alias somebody else holds is ignored and counted, never taken", async () => {
    const w = mailWorld()
    w.mail.give("user_bob", "ada.l@acme.test")
    const p = await push(
      w,
      person({
        emails: [
          { primary: true, value: "ada@acme.test" },
          { value: "ada.l@acme.test" },
        ],
      }),
    )
    await apply(w, p.id)
    expect(w.mail.accounts.get("user_ada")!.aliases.size).toBe(0)
    expect(w.mail.accounts.get("user_bob")!.address).toBe("ada.l@acme.test")
    expect(w.mail.ignored.get(p.id)).toBe(1)
  })

  // ── Deprovisioning ──

  async function provisionedWithMailbox() {
    const w = mailWorld()
    const p = await push(
      w,
      person({
        emails: [
          { primary: true, type: "work", value: "ada@acme.test" },
          { value: "ada.l@acme.test" },
        ],
      }),
    )
    await apply(w, p.id)
    return { w, p }
  }

  it("deprovisioning SUSPENDS: the login is refused, mail keeps arriving, nothing is deleted", async () => {
    const { w, p } = await provisionedWithMailbox()
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(w.mail.canLogin("user_ada")).toBe(false)
    expect(w.mail.delivers("ada@acme.test")).toBe(true)
    expect(w.mail.delivers("ada.l@acme.test")).toBe(true)
    expect(w.mail.rows.get(`${TENANT}/user_ada`)).toMatchObject({
      state: "suspended",
      next: "keep",
      deleteAt: null,
    })
    expect(
      w.identity.events.find((e) => e.type === "member.deprovisioned"),
    ).toMatchObject({ data: { mailbox: "suspended" } })
    expect(types(w)).toContain("mailbox.suspended")
  })

  it("is not suspended while ANOTHER enabled directory still says the person is active", async () => {
    const { w, p } = await provisionedWithMailbox()
    const other = await push(w, person({ userName: "ada2@acme.test" }), OTHER_DIRECTORY)
    await w.dirs.store.linkUser(TENANT, other.id, "user_ada")
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    expect(await apply(w, p.id)).toMatchObject({ action: "kept_by_other_directory" })
    expect(w.mail.canLogin("user_ada")).toBe(true)
    expect(w.mail.rows.get(`${TENANT}/user_ada`)?.state).toBe("active")
  })

  it("a reactivated person gets the SAME mailbox back, aliases and all", async () => {
    const { w, p } = await provisionedWithMailbox()
    const before = structuredClone([...w.mail.accounts.get("user_ada")!.aliases])
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(w.mail.canLogin("user_ada")).toBe(false)
    await change(w, p.id, [{ op: "replace", value: { active: true } }])
    await apply(w, p.id)
    expect(w.mail.canLogin("user_ada")).toBe(true)
    expect(w.mail.accounts.get("user_ada")!.address).toBe("ada@acme.test")
    expect([...w.mail.accounts.get("user_ada")!.aliases]).toEqual(before)
    expect(w.mail.rows.get(`${TENANT}/user_ada`)).toMatchObject({
      state: "active",
      next: "keep",
    })
    expect(types(w)).toContain("mailbox.resumed")
  })

  it("reactivation restores the mailbox even when the opt-in has since been turned off", async () => {
    const { w, p } = await provisionedWithMailbox()
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    await w.dirs.store.updateDirectory(TENANT, DIRECTORY, { createMailboxes: false })
    await change(w, p.id, [{ op: "replace", value: { active: true } }])
    await apply(w, p.id)
    expect(w.mail.canLogin("user_ada")).toBe(true)
  })

  /*
   * ⚠ THE DIRECTORY SAYS THE PERSON IS OFF, SO THEIR MAILBOX IN THIS WORKSPACE
   * GOES, WHETHER OR NOT THIS WORKSPACE MANAGES THEM. `deprovision` answers
   * `not_managed` before it suspends anything for somebody the workspace does not
   * manage - never claimed, released earlier, or managed by another workspace -
   * and that used to be the end of it: the mailbox kept its login, on a password
   * authd had cached for hours.
   */
  describe("a person the directory switches off who is not managed here", () => {
    it("loses the login of their mailbox when the account was released earlier", async () => {
      const { w, p } = await provisionedWithMailbox()
      w.identity.managed.delete("user_ada")
      await change(w, p.id, [{ op: "replace", value: { active: false } }])
      expect(await apply(w, p.id)).toMatchObject({ action: "deprovisioned" })
      expect(w.mail.canLogin("user_ada")).toBe(false)
      expect(w.mail.delivers("ada@acme.test")).toBe(true)
      expect(w.mail.rows.get(`${TENANT}/user_ada`)).toMatchObject({
        state: "suspended",
      })
      expect(types(w)).toContain("mailbox.suspended")
      // Said in the identity audit log too, with why it was not a deprovision.
      expect(w.identity.events).toContainEqual(
        expect.objectContaining({
          type: "mailbox.suspended_unmanaged",
          subjectUserId: "user_ada",
          reason: "directory_inactive",
        }),
      )
    })

    it("loses it when ANOTHER workspace manages the account", async () => {
      const { w, p } = await provisionedWithMailbox()
      w.identity.managed.set("user_ada", {
        clerkUserId: "user_ada",
        tenantId: OTHER_TENANT,
        connectionId: CONNECTION,
        reason: "claimed",
        emails: ["ada@acme.test"],
      })
      await change(w, p.id, [{ op: "replace", value: { active: false } }])
      await apply(w, p.id)
      expect(w.mail.canLogin("user_ada")).toBe(false)
      // Still the other workspace's account: neither released nor banned from here.
      expect(w.identity.managed.get("user_ada")?.tenantId).toBe(OTHER_TENANT)
    })

    it("loses it when Clerk no longer knows the account", async () => {
      const { w, p } = await provisionedWithMailbox()
      w.clerk.users.delete("user_ada")
      await change(w, p.id, [{ op: "replace", value: { active: false } }])
      await apply(w, p.id)
      expect(w.mail.canLogin("user_ada")).toBe(false)
    })

    it("is the same once more on a retry, and a mailbox that is not theirs here is left alone", async () => {
      const { w, p } = await provisionedWithMailbox()
      w.identity.managed.delete("user_ada")
      await change(w, p.id, [{ op: "replace", value: { active: false } }])
      await apply(w, p.id)
      await change(w, p.id, [{ op: "replace", path: "title", value: "x" }])
      await apply(w, p.id)
      expect(
        w.identity.events.filter((e) => e.type === "mailbox.suspended_unmanaged"),
      ).toHaveLength(1)

      // A mailbox in ANOTHER workspace (the account's tenant differs) is not touched.
      const away = mailWorld({ hosted: { "acme.test": OTHER_TENANT } })
      away.mail.give("user_ada", "ada@acme.test", OTHER_TENANT)
      const q = await push(away)
      await away.dirs.store.linkUser(TENANT, q.id, "user_ada")
      await change(away, q.id, [{ op: "replace", value: { active: false } }])
      await apply(away, q.id)
      expect(away.mail.canLogin("user_ada")).toBe(true)
    })
  })

  it("the last owner is not suspended: the mailbox stays open while the membership stays", async () => {
    const w = mailWorld({ owners: ["user_ada"] })
    const p = await push(w)
    await w.dirs.store.linkUser(TENANT, p.id, "user_ada")
    await w.identity.store.claimManaged(TENANT, {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "linked",
      emails: ["ada@acme.test"],
    })
    w.mail.give("user_ada", "ada@acme.test")
    await change(w, p.id, [{ op: "replace", value: { active: false } }])
    await apply(w, p.id)
    expect(stored(w, p.id).conflict).toBe("last_owner")
    expect(w.mail.canLogin("user_ada")).toBe(true)
  })

  it("turning on 'create mailboxes' looks at the people already in again", async () => {
    const w = mailWorld({ optIn: false })
    const p = await push(w)
    await apply(w, p.id)
    expect(w.mail.accounts.size).toBe(0)
    await w.dirs.store.updateDirectory(TENANT, DIRECTORY, { createMailboxes: true })
    const entries = await w.dirs.store.requeueActive(TENANT, DIRECTORY)
    expect(entries.map((e) => e.directoryUserId)).toEqual([p.id])
    await apply(w, p.id)
    expect(w.mail.delivers("ada@acme.test")).toBe(true)
  })
})
