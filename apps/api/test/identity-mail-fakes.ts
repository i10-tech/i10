import type {
  DirectoryMailDeps,
  DirectoryMailStore,
  LeaverAction,
  LoginBlock,
  MailboxLifecycle,
  MailboxNote,
  MailboxRow,
  ManagerRead,
} from "../src/identity/directory-mail.js"
import { mailboxLifecycle } from "../src/identity/directory-mail.js"
import type { GroupMailStore } from "../src/identity/mail-store.js"
import type { AuditEvent } from "../src/identity/ports.js"
import {
  provisionForDirectory,
  type DirectoryMailboxOutcome,
} from "../src/mailboxes/provision.js"
import { TENANT } from "./identity-fakes.js"

/**
 * The mail half of the directory in memory (#344 slice B): `authd.accounts`
 * as the Go service reads it, and the lifecycle rows beside it.
 *
 * ⚠ `delivers` AND `canLogin` ARE authd's TWO QUESTIONS, ANSWERED THE WAY ITS
 * SQL AND BIND DO: an account receives while it is `active`, and may log in
 * only while it is `active` and not suspended. The suspension tests assert
 * through them, not through a flag.
 */

interface Account {
  tenantId: string
  address: string
  active: boolean
  suspended: boolean
  /** A payment hold, a Clerk ban or lock: refused whatever `suspended` says. */
  blocks: LoginBlock[]
  aliases: Set<string>
  lists: Set<string>
}

export const LEAVER = "user_ada"
export const MANAGER = "user_grace"

export function memoryMail(
  init: {
    /** Domains the workspace hosts mail for. */
    hosted?: Record<string, string>
    default?: { action: LeaverAction; days: number | null }
    members?: string[]
    directoryActive?: string[]
    /** People every enabled directory that knows them says are deactivated. */
    directoryDeactivated?: string[]
  } = {},
) {
  const hosted = new Map(Object.entries(init.hosted ?? { "acme.test": TENANT }))
  const accounts = new Map<string, Account>()
  const rows = new Map<string, MailboxRow>()
  const managers = new Map<string, ManagerRead>()
  const events: (AuditEvent & { tenantId: string })[] = []
  const notes = new Map<string, MailboxNote | null>()
  const ignored = new Map<string, number>()
  const groups = new Map<
    string,
    {
      displayName: string
      mailAddress: string | null
      mailKind: "list" | "shared" | null
    }
  >()
  const scheduled: { tenantId: string; clerkUserId: string; at: Date }[] = []
  const members = new Set(init.members ?? [])
  const active = new Set(init.directoryActive ?? [])
  const deactivated = new Set(init.directoryDeactivated ?? [])
  const provisionResults = new Map<string, DirectoryMailboxOutcome>()
  const settings = {
    default: init.default ?? { action: "keep" as LeaverAction, days: null },
  }
  const fail = { scheduling: false }
  let now = new Date("2026-10-21T10:00:00Z")
  const key = (t: string, u: string) => `${t}/${u}`

  const audit = (tenantId: string, event: AuditEvent) =>
    events.push({ tenantId, ...event })

  const give = (userId: string, address: string, tenantId = TENANT, active = true) => {
    accounts.set(userId, {
      tenantId,
      address,
      active,
      suspended: false,
      blocks: [],
      aliases: new Set(),
      lists: new Set(),
    })
  }

  const store: DirectoryMailStore & GroupMailStore = {
    async hostedBy(domain) {
      return hosted.get(domain.toLowerCase()) ?? null
    },
    async leaverDefault() {
      return settings.default
    },
    async setLeaverDefault(tenantId, input, event) {
      settings.default = { action: input.action, days: input.days }
      audit(tenantId, event)
    },
    async mailbox(tenantId, userId) {
      return rows.get(key(tenantId, userId)) ?? null
    },
    async mailboxes(tenantId) {
      return [...rows.values()].filter((r) => r.tenantId === tenantId)
    },
    async account(tenantId, userId) {
      const a = accounts.get(userId)
      return a && a.tenantId === tenantId && a.active
        ? { address: a.address, suspended: a.suspended, blocks: [...a.blocks] }
        : null
    },
    async recordActive(tenantId, userId, address) {
      if (!rows.has(key(tenantId, userId)))
        rows.set(key(tenantId, userId), {
          tenantId,
          clerkUserId: userId,
          address,
          state: "active",
          suspendedAt: null,
          next: "keep",
          targetUserId: null,
          deleteAfterDays: null,
          deleteAt: null,
        })
    },
    async suspend(tenantId, userId, plan, at, event) {
      const a = accounts.get(userId)
      if (!a || a.tenantId !== tenantId) return "no_mailbox"
      a.suspended = true
      if (rows.get(key(tenantId, userId))?.state === "suspended") return "already"
      rows.set(key(tenantId, userId), {
        tenantId,
        clerkUserId: userId,
        address: a.address,
        state: "suspended",
        suspendedAt: at,
        next: plan.next,
        targetUserId: plan.targetUserId,
        deleteAfterDays: plan.days,
        deleteAt: plan.deleteAt,
      })
      audit(tenantId, event)
      return "suspended"
    },
    async resume(tenantId, userId, event, options) {
      const a = accounts.get(userId)
      const row = rows.get(key(tenantId, userId))
      if (options?.memberOnly && !members.has(userId)) return "not_member"
      if (!a || a.tenantId !== tenantId) return "none"
      if (row?.state !== "suspended" && !a.suspended) return "none"
      a.suspended = false
      if (row)
        rows.set(key(tenantId, userId), {
          ...row,
          state: "active",
          suspendedAt: null,
          next: "keep",
          targetUserId: null,
          deleteAfterDays: null,
          deleteAt: null,
        })
      audit(tenantId, event)
      return "resumed"
    },
    async choose(tenantId, userId, plan, event) {
      const row = rows.get(key(tenantId, userId))
      if (row?.state !== "suspended") return "not_suspended"
      rows.set(key(tenantId, userId), {
        ...row,
        next: plan.next,
        targetUserId: plan.targetUserId,
        deleteAfterDays: plan.days,
        deleteAt: plan.deleteAt,
      })
      audit(tenantId, event)
      return "ok"
    },
    async remove(tenantId, userId, at, event) {
      const row = rows.get(key(tenantId, userId))
      if (!row || row.state !== "suspended" || row.next !== "delete" || !row.deleteAt)
        return "not_scheduled"
      if (row.deleteAt.getTime() > at.getTime()) return "not_due"
      accounts.delete(userId)
      rows.delete(key(tenantId, userId))
      audit(tenantId, event)
      return "deleted"
    },
    async due(tenantId, at) {
      return [...rows.values()].filter(
        (r) =>
          r.tenantId === tenantId &&
          r.state === "suspended" &&
          r.next === "delete" &&
          r.deleteAt &&
          r.deleteAt.getTime() <= at.getTime(),
      )
    },
    async manager(_tenantId, userId) {
      return managers.get(userId) ?? { status: "none" }
    },
    async setAliases(tenantId, userId, wanted, event) {
      const a = accounts.get(userId)
      if (!a) return { taken: [...wanted] }
      const taken = wanted.filter((w) =>
        [...accounts.entries()].some(
          ([id, o]) => id !== userId && (o.address === w || o.aliases.has(w)),
        ),
      )
      const next = new Set(wanted.filter((w) => !taken.includes(w)))
      const added = [...next].filter((x) => !a.aliases.has(x))
      const removed = [...a.aliases].filter((x) => !next.has(x))
      a.aliases = next
      if (added.length || removed.length) audit(tenantId, event(added, removed))
      return { taken }
    },
    async noteAliases(_t, id, n) {
      ignored.set(id, n)
    },
    async setNote(_t, id, note) {
      const changed = (notes.get(id) ?? null) !== note
      notes.set(id, note)
      return changed
    },
    async syncLists() {
      return { added: 0, removed: 0 }
    },
    async group(_t, _d, groupId) {
      const g = groups.get(groupId)
      return g ? { id: groupId, ...g } : null
    },
    async setGroupMail(tenantId, _d, groupId, input, event) {
      const g = groups.get(groupId)
      if (!g) return "not_found"
      if (
        input &&
        [...groups.entries()].some(
          ([id, o]) => id !== groupId && o.mailAddress === input.address,
        )
      )
        return "taken"
      if (input && [...accounts.values()].some((a) => a.address === input.address))
        return "taken"
      g.mailAddress = input?.address ?? null
      g.mailKind = input?.kind ?? null
      audit(tenantId, event)
      return "ok"
    },
  }

  const deps: DirectoryMailDeps = {
    store,
    async provision({ userId }) {
      const preset = provisionResults.get(userId)
      if (preset) {
        if (preset.status === "created") give(userId, preset.address)
        return preset
      }
      return { status: "gone" }
    },
    async isMember(_t, userId) {
      return members.has(userId)
    },
    async directoryActive(_t, userId) {
      return active.has(userId)
    },
    async directoryDeactivated(_t, userId) {
      return deactivated.has(userId)
    },
    async scheduleDeletion(job, at) {
      if (fail.scheduling) throw new Error("redis down")
      scheduled.push({ tenantId: job.tenantId, clerkUserId: job.clerkUserId, at })
    },
    async record(tenantId, event) {
      audit(tenantId, event)
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => now,
  }

  return {
    store,
    deps,
    lifecycle: mailboxLifecycle(deps) as MailboxLifecycle,
    accounts,
    groups,
    rows,
    events,
    notes,
    ignored,
    scheduled,
    members,
    active,
    deactivated,
    managers,
    hosted,
    fail,
    give,
    /** What `provision` answers for this user (and, for `created`, the account it makes). */
    provisions(userId: string, outcome: DirectoryMailboxOutcome) {
      provisionResults.set(userId, outcome)
    },
    setNow(at: Date) {
      now = at
    },
    /** authd's filterMailbox: does mail for this address arrive? */
    delivers(address: string): boolean {
      return [...accounts.values()].some(
        (a) => a.active && (a.address === address || a.aliases.has(address)),
      )
    },
    /** authd's bind: may this person log in? */
    canLogin(userId: string): boolean {
      const a = accounts.get(userId)
      return Boolean(a && a.active && !a.suspended)
    },
    types: () => events.map((e) => e.type),
  }
}

/**
 * `provisionForDirectory` itself, over these fakes and a Clerk fake: the real
 * refusals (not hosted, taken, limit) with an in-memory projection that makes
 * an INACTIVE account and `activate` that flips it, as the SQL does.
 */
export function realProvisioning(
  mail: ReturnType<typeof memoryMail>,
  clerkUsers: Map<
    string,
    {
      id: string
      primaryEmailId: string | null
      emails: { id: string; address: string; verified: boolean }[]
    }
  >,
  options: { limit?: boolean } = {},
) {
  mail.deps.provision = (input) =>
    provisionForDirectory(
      {
        identity: {
          async get(userId) {
            const u = clerkUsers.get(userId)
            if (!u) return null
            return {
              user: {
                id: u.id,
                primary_email_address_id: u.primaryEmailId,
                email_addresses: u.emails.map((e) => ({
                  id: e.id,
                  email_address: e.address,
                  verification: { status: e.verified ? "verified" : "unverified" },
                })),
              },
              passwordEnabled: false,
            }
          },
          async addVerifiedAddress() {
            throw new Error("a directory never adds an address here")
          },
        },
        directory: {
          async domainOwner(domain) {
            return mail.hosted.get(domain) ?? null
          },
          async addressTaken(address) {
            return [...mail.accounts.entries()].some(
              ([, a]) => a.address === address || a.aliases.has(address),
            )
          },
          async current(userId) {
            const a = mail.accounts.get(userId)
            return a
              ? {
                  object: "mailbox" as const,
                  address: a.address,
                  display_name: null,
                  active: a.active,
                  created_at: "2026-10-21T10:00:00.000Z",
                }
              : null
          },
          async activate(userId) {
            const a = mail.accounts.get(userId)
            if (!a) return null
            a.active = true
            return {
              object: "mailbox" as const,
              address: a.address,
              display_name: null,
              active: true,
              created_at: "2026-10-21T10:00:00.000Z",
            }
          },
        },
        capacity: {
          check: async () => ({ status: options.limit ? "exceeded" : "ok" }),
        },
        async project(user) {
          const primary = (user.email_addresses ?? []).find(
            (e) => e.id === user.primary_email_address_id,
          )
          const address = primary?.email_address.toLowerCase()
          const owner = address ? mail.hosted.get(address.split("@")[1]!) : undefined
          if (!address || !owner) return {}
          if (!mail.accounts.has(user.id)) mail.give(user.id, address, owner, false)
          return { email: address }
        },
        featureId: "mailboxes",
      },
      input,
    )
}
