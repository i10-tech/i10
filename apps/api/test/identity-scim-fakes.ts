import type {
  ClerkProvisioning,
  Directory,
  DirectoryConflict,
  DirectoryGroupRow,
  DirectoryStore,
  DirectoryToken,
  DirectoryUserRow,
  OutboxEntry,
  TokenRow,
  WatchChannelRow,
} from "../src/identity/directory-ports.js"
import type { AuditEvent } from "../src/identity/ports.js"
import {
  TOKEN_PREFIX,
  type StoredGroup,
  type StoredUser,
} from "../src/identity/scim.js"
import { hashSecret } from "../src/identity/model.js"
import { TENANT, memoryClerk, user as clerkUser } from "./identity-fakes.js"

/**
 * In-memory doubles for the directory store and the Clerk calls provisioning
 * makes (#342). The store keeps the semantics Postgres enforces: the
 * case-insensitive userName index over live rows, one link per account per
 * directory, members only of their own directory, outbox entries in the same
 * "transaction" as the write, and ids that sort by creation like uuidv7.
 * The real SQL is tested against Postgres in identity-scim-db.test.ts.
 */

export const DIRECTORY = "44444444-4444-4444-8444-444444444444"
export const OTHER_DIRECTORY = "55555555-5555-4555-8555-555555555555"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A SCIM token in our format, and its hash. */
export function scimToken(seed: string) {
  const body = seed.padEnd(43, "x").slice(0, 43)
  const token = `${TOKEN_PREFIX}${body}`
  return { token, hash: hashSecret(token) }
}

interface TokenRecord extends DirectoryToken {
  tenantId: string
  tokenHash: string
}

/** A token as the console sees it: never the hash. */
const publicToken = (t: TokenRecord): DirectoryToken => ({
  id: t.id,
  directoryId: t.directoryId,
  hint: t.hint,
  createdBy: t.createdBy,
  createdAt: t.createdAt,
  expiresAt: t.expiresAt,
  revokedAt: t.revokedAt,
  lastUsedAt: t.lastUsedAt,
})

export function memoryDirectories(
  init: {
    directories?: Partial<Directory>[]
    tokens?: { seed: string; directoryId?: string; over?: Partial<TokenRecord> }[]
    domains?: string[]
    tenant?: string
  } = {},
) {
  const tenant = init.tenant ?? TENANT
  let n = 0
  const id = () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`
  const directories = new Map<string, Directory>()
  for (const over of init.directories ?? [{ id: DIRECTORY }]) {
    const provider = over.provider ?? "generic"
    const made: Directory = {
      id: DIRECTORY,
      tenantId: tenant,
      name: "Acme directory",
      provider,
      enabled: provider !== "google",
      createMailboxes: false,
      adminEmail: null,
      domain: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      ...over,
    }
    directories.set(made.id, made)
  }
  const tokens: TokenRecord[] = []
  const watchChannels: WatchChannelRow[] = []
  const users: DirectoryUserRow[] = []
  const groups: DirectoryGroupRow[] = []
  const memberships: { groupId: string; userId: string; directoryId: string }[] = []
  const outbox: (OutboxEntry & {
    directoryId: string
    tenantId: string
    cause: string
    createdAt: Date
    appliedAt: Date | null
    attempts: number
    lastError: string | null
  })[] = []
  const events: (AuditEvent & { tenantId: string })[] = []
  const waitlist: {
    tenantId: string
    userId: string
    email: string
    answered: boolean | null
  }[] = []
  const domains = init.domains ?? ["acme.test"]
  let clock = new Date("2026-10-21T10:00:00Z")
  const calls: string[] = []
  const fail = { forApply: false }
  /** Clerk accounts that are workspace members (what `seats` calls `outside` otherwise). */
  const seated = new Set<string>()

  const put = (tenantId: string, directoryId: string, input: StoredUser) => {
    const at = clock
    const row: DirectoryUserRow = {
      id: id(),
      tenantId,
      directoryId,
      userName: input.userName,
      externalId: input.externalId,
      displayName: input.displayName,
      givenName: input.givenName,
      familyName: input.familyName,
      email: input.email,
      active: input.active,
      resource: structuredClone(input.resource),
      clerkUserId: null,
      conflict: null,
      conflictDetail: null,
      conflictAt: null,
      bannedByDirectory: false,
      aliasesIgnored: 0,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    }
    users.push(row)
    return row
  }

  const entries = (
    tenantId: string,
    directoryId: string,
    ids: string[],
    cause: string,
  ): OutboxEntry[] =>
    ids.map((directoryUserId) => {
      const e = {
        id: id(),
        directoryUserId,
        directoryId,
        tenantId,
        cause,
        createdAt: clock,
        appliedAt: null,
        attempts: 0,
        lastError: null,
      }
      outbox.push(e)
      return { id: e.id, directoryUserId }
    })

  const taken = (directoryId: string, userName: string, except?: string) =>
    users.some(
      (u) =>
        u.directoryId === directoryId &&
        !u.deletedAt &&
        u.id !== except &&
        u.userName.toLowerCase() === userName.toLowerCase(),
    )

  const live = (tenantId: string, directoryId: string, ids: string[]) => {
    const ok = new Set(
      users
        .filter(
          (u) =>
            u.tenantId === tenantId && u.directoryId === directoryId && !u.deletedAt,
        )
        .map((u) => u.id),
    )
    return ids
      .filter((x) => UUID.test(x) && ok.has(x.toLowerCase()))
      .map((x) => x.toLowerCase())
  }

  const rowOf = (tenantId: string, directoryId: string, uid: string) =>
    users.find(
      (u) =>
        u.tenantId === tenantId &&
        u.directoryId === directoryId &&
        u.id === uid &&
        !u.deletedAt,
    ) ?? null

  const record = (tenantId: string, event: AuditEvent) => {
    events.push({ tenantId, ...event })
  }

  const store: DirectoryStore = {
    async createDirectory(tenantId, input) {
      const made: Directory = {
        id: id(),
        tenantId,
        name: input.name,
        provider: input.provider,
        enabled: input.enabled ?? input.provider !== "google",
        createMailboxes: false,
        adminEmail: input.adminEmail ?? null,
        domain: input.domain ?? null,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        createdAt: clock,
        updatedAt: clock,
      }
      directories.set(made.id, made)
      return { ...made }
    },
    async directories(tenantId) {
      return [...directories.values()]
        .filter((d) => d.tenantId === tenantId)
        .map((d) => ({
          ...d,
          tokens: tokens
            .filter((t) => t.directoryId === d.id)
            .map((t) => publicToken(t)),
          users: users.filter((u) => u.directoryId === d.id && !u.deletedAt).length,
          conflicts: users.filter((u) => u.directoryId === d.id && u.conflict).length,
          pending: outbox.filter((o) => o.directoryId === d.id && !o.appliedAt).length,
        }))
    },
    async directory(tenantId, did) {
      const d = directories.get(did)
      return d && d.tenantId === tenantId ? { ...d } : null
    },
    async updateDirectory(tenantId, did, patch) {
      const d = directories.get(did)
      if (!d || d.tenantId !== tenantId) return null
      Object.assign(d, patch, { updatedAt: clock })
      return { ...d }
    },
    async noteDirectorySync(tenantId, did, input) {
      const d = directories.get(did)
      if (!d || d.tenantId !== tenantId) return
      d.lastSyncAt = input.at
      d.lastSyncStatus = input.status
      d.lastSyncError = input.error
      d.updatedAt = input.at
    },
    async dueGoogleDirectories(after, limit) {
      if (after !== null && !UUID.test(after)) return []
      const capped = Math.min(Math.max(Math.trunc(limit), 0), 500)
      if (capped === 0) return []
      return [...directories.values()]
        .filter(
          (d) =>
            d.provider === "google" && d.enabled && (after === null || d.id > after),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, capped)
        .map((d) => ({ id: d.id, tenantId: d.tenantId }))
    },
    async watchChannels(tenantId, did) {
      if (!UUID.test(did)) return []
      return watchChannels
        .filter((w) => w.tenantId === tenantId && w.directoryId === did)
        .map((w) => ({ ...w }))
    },
    async saveWatchChannel(tenantId, input) {
      const d = directories.get(input.directoryId)
      if (!d || d.tenantId !== tenantId) throw new Error("no such directory")
      const made: WatchChannelRow = {
        id: input.id.toLowerCase(),
        tenantId,
        directoryId: input.directoryId,
        event: input.event,
        resourceId: input.resourceId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: clock,
      }
      watchChannels.push(made)
      return { ...made }
    },
    async deleteWatchChannels(tenantId, did, ids) {
      if (!UUID.test(did)) return []
      const wanted =
        ids === undefined
          ? null
          : new Set(ids.filter((x) => UUID.test(x)).map((x) => x.toLowerCase()))
      if (wanted !== null && wanted.size === 0) return []
      const gone: WatchChannelRow[] = []
      for (let i = watchChannels.length - 1; i >= 0; i--) {
        const w = watchChannels[i]!
        if (
          w.tenantId === tenantId &&
          w.directoryId === did &&
          (wanted === null || wanted.has(w.id))
        ) {
          gone.push({ ...w })
          watchChannels.splice(i, 1)
        }
      }
      return gone.reverse()
    },
    async watchChannelById(cid) {
      if (!UUID.test(cid)) return null
      const w = watchChannels.find((x) => x.id === cid.toLowerCase())
      return w ? { ...w } : null
    },
    async issueToken(tenantId, did, input, now) {
      const d = directories.get(did)
      if (!d || d.tenantId !== tenantId) return null
      const until = new Date(now.getTime() + input.overlapMs)
      for (const t of tokens)
        if (
          t.directoryId === did &&
          !t.revokedAt &&
          (!t.expiresAt || t.expiresAt > now)
        ) {
          if (input.overlapMs === 0) t.revokedAt = now
          else t.expiresAt = !t.expiresAt || t.expiresAt > until ? until : t.expiresAt
        }
      const made: TokenRecord = {
        id: id(),
        tenantId,
        directoryId: did,
        tokenHash: input.tokenHash,
        hint: input.hint,
        createdBy: input.createdBy,
        createdAt: now,
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      }
      tokens.push(made)
      return publicToken(made)
    },
    async revokeToken(tenantId, did, tid, at) {
      const t = tokens.find(
        (x) => x.tenantId === tenantId && x.directoryId === did && x.id === tid,
      )
      if (!t || t.revokedAt) return false
      t.revokedAt = at
      return true
    },
    async conflicts(tenantId, did) {
      return users
        .filter((u) => u.tenantId === tenantId && u.directoryId === did && u.conflict)
        .map((u) => structuredClone(u))
    },
    async tokenByHash(hash) {
      const t = tokens.find((x) => x.tokenHash === hash)
      if (!t) return null
      const row: TokenRow = {
        id: t.id,
        tenantId: t.tenantId,
        directoryId: t.directoryId,
        tokenHash: t.tokenHash,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        lastUsedAt: t.lastUsedAt,
      }
      return row
    },
    async touchToken(_t, tid, at) {
      const t = tokens.find((x) => x.id === tid)
      if (t && (!t.lastUsedAt || at.getTime() - t.lastUsedAt.getTime() > 60_000))
        t.lastUsedAt = at
    },

    async listUsers(tenantId, did, input) {
      const f = input.filter
      const all = users.filter(
        (u) =>
          u.tenantId === tenantId &&
          u.directoryId === did &&
          !u.deletedAt &&
          (f === null ||
            (f.attr === "userName" &&
              u.userName.toLowerCase() === f.value.toLowerCase()) ||
            (f.attr === "externalId" && u.externalId === f.value) ||
            (f.attr === "emails.value" &&
              ((u.resource.emails as { value?: string }[] | undefined) ?? []).some(
                (e) => e.value?.toLowerCase() === f.value.toLowerCase(),
              ))),
      )
      return {
        total: all.length,
        rows: all
          .slice(input.startIndex - 1, input.startIndex - 1 + input.count)
          .map((u) => structuredClone(u)),
      }
    },
    async user(tenantId, did, uid) {
      if (!UUID.test(uid)) return null
      const u = rowOf(tenantId, did, uid)
      return u ? structuredClone(u) : null
    },
    async createUser(tenantId, did, input, event) {
      if (taken(did, input.userName)) return "taken"
      const row = put(tenantId, did, input)
      const outboxEntries = entries(tenantId, did, [row.id], "created")
      record(tenantId, { ...event, data: { ...event.data, directoryUserId: row.id } })
      return { row: structuredClone(row), outbox: outboxEntries }
    },
    async editUser(tenantId, did, uid, edit, event) {
      if (!UUID.test(uid)) return null
      const row = rowOf(tenantId, did, uid)
      if (!row) return null
      const before = structuredClone(row)
      const next = edit(before)
      if (taken(did, next.userName, uid)) return "taken"
      Object.assign(row, {
        userName: next.userName,
        externalId: next.externalId,
        displayName: next.displayName,
        givenName: next.givenName,
        familyName: next.familyName,
        email: next.email,
        active: next.active,
        resource: structuredClone(next.resource),
        updatedAt: clock,
      })
      const outboxEntries = entries(tenantId, did, [uid], "updated")
      record(tenantId, event(before, next))
      return { row: structuredClone(row), outbox: outboxEntries }
    },
    async deleteUser(tenantId, did, uid, event) {
      if (!UUID.test(uid)) return null
      const row = rowOf(tenantId, did, uid)
      if (!row) return null
      row.deletedAt = clock
      for (let i = memberships.length - 1; i >= 0; i--)
        if (memberships[i]!.userId === uid) memberships.splice(i, 1)
      const outboxEntries = entries(tenantId, did, [uid], "deleted")
      record(tenantId, event)
      return { row: { id: uid }, outbox: outboxEntries }
    },
    async groupsOf(_t, userIds) {
      const out = new Map<string, { id: string; displayName: string }[]>()
      for (const m of memberships)
        if (userIds.includes(m.userId)) {
          const g = groups.find((x) => x.id === m.groupId)!
          out.set(m.userId, [
            ...(out.get(m.userId) ?? []),
            { id: g.id, displayName: g.displayName },
          ])
        }
      return out
    },

    async listGroups(tenantId, did, input) {
      const f = input.filter
      const all = groups.filter(
        (g) =>
          g.tenantId === tenantId &&
          g.directoryId === did &&
          (f === null ||
            (f.attr === "displayName" &&
              g.displayName.toLowerCase() === f.value.toLowerCase()) ||
            (f.attr === "externalId" && g.externalId === f.value)),
      )
      return {
        total: all.length,
        rows: all
          .slice(input.startIndex - 1, input.startIndex - 1 + input.count)
          .map((g) => structuredClone(g)),
      }
    },
    async group(tenantId, did, gid) {
      if (!UUID.test(gid)) return null
      const g = groups.find(
        (x) => x.tenantId === tenantId && x.directoryId === did && x.id === gid,
      )
      return g ? structuredClone(g) : null
    },
    async groupSummaries(tenantId, did) {
      return groups
        .filter((g) => g.tenantId === tenantId && g.directoryId === did)
        .map((g) => ({
          id: g.id,
          displayName: g.displayName,
          memberCount: memberships.filter((m) => m.groupId === g.id).length,
        }))
        .sort(
          (a, b) =>
            a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) ||
            a.id.localeCompare(b.id),
        )
    },
    async membersOf(_t, groupIds) {
      const out = new Map<string, { id: string; display: string }[]>()
      for (const m of memberships)
        if (groupIds.includes(m.groupId)) {
          const u = users.find((x) => x.id === m.userId)!
          out.set(m.groupId, [
            ...(out.get(m.groupId) ?? []),
            { id: u.id, display: u.displayName ?? u.userName },
          ])
        }
      return out
    },
    async createGroup(tenantId, did, input: StoredGroup, event) {
      const row: DirectoryGroupRow = {
        id: id(),
        tenantId,
        directoryId: did,
        displayName: input.displayName,
        externalId: input.externalId,
        resource: structuredClone(input.resource),
        createdAt: clock,
        updatedAt: clock,
      }
      groups.push(row)
      const members = live(tenantId, did, input.members)
      for (const userId of members)
        memberships.push({ groupId: row.id, userId, directoryId: did })
      const outboxEntries = entries(tenantId, did, members, "group")
      const skipped = input.members.length - members.length
      record(tenantId, {
        ...event,
        data: { ...event.data, groupId: row.id, members: members.length, skipped },
      })
      return { row: structuredClone(row), outbox: outboxEntries, skipped }
    },
    async editGroup(tenantId, did, gid, edit, event) {
      if (!UUID.test(gid)) return null
      const row = groups.find(
        (x) => x.tenantId === tenantId && x.directoryId === did && x.id === gid,
      )
      if (!row) return null
      const had = memberships.filter((m) => m.groupId === gid).map((m) => m.userId)
      const next = edit({ row: structuredClone(row), members: [...had] })
      const wanted = live(tenantId, did, next.members)
      const added = wanted.filter((u) => !had.includes(u))
      const removed = had.filter((u) => !wanted.includes(u))
      const renamed =
        row.displayName !== next.displayName || row.externalId !== next.externalId
      Object.assign(row, {
        displayName: next.displayName,
        externalId: next.externalId,
        resource: structuredClone(next.resource),
        updatedAt: clock,
      })
      for (const userId of added)
        memberships.push({ groupId: gid, userId, directoryId: did })
      for (const userId of removed) {
        const at = memberships.findIndex(
          (m) => m.groupId === gid && m.userId === userId,
        )
        memberships.splice(at, 1)
      }
      const touched = renamed
        ? [...new Set([...wanted, ...removed])]
        : [...added, ...removed]
      const outboxEntries = entries(tenantId, did, touched, "group")
      const skipped = next.members.length - wanted.length
      record(tenantId, {
        ...event,
        data: {
          ...event.data,
          groupId: gid,
          added: added.length,
          removed: removed.length,
          skipped,
        },
      })
      return { row: structuredClone(row), outbox: outboxEntries, skipped }
    },
    async deleteGroup(tenantId, did, gid, event) {
      if (!UUID.test(gid)) return null
      const at = groups.findIndex(
        (x) => x.tenantId === tenantId && x.directoryId === did && x.id === gid,
      )
      if (at < 0) return null
      const members = memberships.filter((m) => m.groupId === gid).map((m) => m.userId)
      groups.splice(at, 1)
      for (let i = memberships.length - 1; i >= 0; i--)
        if (memberships[i]!.groupId === gid) memberships.splice(i, 1)
      const outboxEntries = entries(tenantId, did, members, "group")
      record(tenantId, {
        ...event,
        data: { ...event.data, groupId: gid, members: members.length },
      })
      return { row: { id: gid }, outbox: outboxEntries }
    },

    async pending(tenantId, did, before, limit) {
      return outbox
        .filter(
          (o) =>
            o.tenantId === tenantId &&
            o.directoryId === did &&
            !o.appliedAt &&
            o.createdAt < before,
        )
        .slice(0, limit)
        .map((o) => ({ id: o.id, directoryUserId: o.directoryUserId }))
    },
    async forApply(tenantId, uid) {
      if (fail.forApply) throw new Error("database down")
      const latest = outbox
        .filter(
          (o) => o.tenantId === tenantId && o.directoryUserId === uid && !o.appliedAt,
        )
        .map((o) => o.id)
        .sort()
        .at(-1)
      const row = users.find((u) => u.tenantId === tenantId && u.id === uid)
      if (!row) return null
      return {
        row: {
          ...structuredClone(row),
          directoryEnabled: directories.get(row.directoryId)!.enabled,
          createMailboxes: directories.get(row.directoryId)!.createMailboxes,
        },
        upTo: latest ?? null,
      }
    },
    async personStatus(tenantId, clerkUserId, except) {
      const rows = users.filter(
        (u) =>
          u.tenantId === tenantId &&
          u.clerkUserId === clerkUserId &&
          !u.deletedAt &&
          u.id !== except &&
          directories.get(u.directoryId)!.enabled,
      )
      if (rows.length === 0) return "unknown"
      return rows.some((u) => u.active || u.conflict === "last_owner")
        ? "active"
        : "inactive"
    },
    async personGroups(tenantId, clerkUserId) {
      const mine = users.filter(
        (u) =>
          u.tenantId === tenantId &&
          u.clerkUserId === clerkUserId &&
          !u.deletedAt &&
          directories.get(u.directoryId)!.enabled,
      )
      return memberships
        .filter((m) => mine.some((u) => u.id === m.userId))
        .map((m) => groups.find((g) => g.id === m.groupId)!)
        .map((g) => ({
          id: g.id,
          directoryId: g.directoryId,
          displayName: g.displayName,
          externalId: g.externalId,
        }))
    },
    async linkUser(tenantId, uid, clerkUserId) {
      const row = users.find((u) => u.tenantId === tenantId && u.id === uid)
      if (!row) return "taken"
      if (row.clerkUserId && row.clerkUserId !== clerkUserId) return "taken"
      if (
        users.some(
          (u) =>
            u.directoryId === row.directoryId &&
            u.id !== uid &&
            !u.deletedAt &&
            u.clerkUserId === clerkUserId,
        )
      )
        return "taken"
      row.clerkUserId = clerkUserId
      return "linked"
    },
    async setConflict(tenantId, uid, conflict: DirectoryConflict | null, detail, at) {
      const row = users.find((u) => u.tenantId === tenantId && u.id === uid)
      if (!row) return false
      if (conflict ? row.conflict === conflict : row.conflict === null) return false
      row.conflict = conflict
      row.conflictDetail = conflict ? (detail ?? {}) : null
      row.conflictAt = conflict ? at : null
      return true
    },
    async bannedByDirectory(tenantId, clerkUserId) {
      return users.some(
        (u) =>
          u.tenantId === tenantId &&
          u.clerkUserId === clerkUserId &&
          u.bannedByDirectory,
      )
    },
    async setBannedByDirectory(tenantId, clerkUserId, banned) {
      if (!banned)
        for (let i = users.length - 1; i >= 0; i--) {
          const u = users[i]!
          if (
            u.tenantId === tenantId &&
            u.clerkUserId === clerkUserId &&
            u.bannedByDirectory &&
            u.deletedAt
          )
            users.splice(i, 1)
        }
      for (const u of users)
        if (u.tenantId === tenantId && u.clerkUserId === clerkUserId)
          u.bannedByDirectory = banned
    },
    async markApplied(tenantId, uid, upTo, at) {
      for (const o of outbox)
        if (
          o.tenantId === tenantId &&
          o.directoryUserId === uid &&
          !o.appliedAt &&
          o.id <= upTo
        )
          o.appliedAt = at
    },
    async noteFailure(tenantId, uid, reason) {
      for (const o of outbox)
        if (o.tenantId === tenantId && o.directoryUserId === uid && !o.appliedAt) {
          o.attempts += 1
          o.lastError = reason.slice(0, 200)
        }
    },
    async purgeUser(tenantId, uid) {
      const at = users.findIndex(
        (u) => u.tenantId === tenantId && u.id === uid && u.deletedAt,
      )
      if (at < 0) return
      users.splice(at, 1)
      for (let i = outbox.length - 1; i >= 0; i--)
        if (outbox[i]!.directoryUserId === uid) outbox.splice(i, 1)
    },
    async requeue(tenantId, did, uid) {
      if (!UUID.test(uid) || !rowOf(tenantId, did, uid)) return null
      return entries(tenantId, did, [uid], "updated")[0]!
    },
    async liveDomains() {
      return [...domains]
    },
    async seats(tenantId) {
      // One key per person, as the SQL: the account, else the address, else the row.
      const people = new Map<string, string | null>()
      for (const u of users) {
        if (u.tenantId !== tenantId || u.deletedAt) continue
        if (!directories.get(u.directoryId)!.enabled) continue
        if (!(u.active || u.conflict === "last_owner")) continue
        people.set(
          u.clerkUserId ?? `e:${u.email?.toLowerCase() ?? `r:${u.id}`}`,
          u.clerkUserId,
        )
      }
      return {
        people: people.size,
        outside: [...people.values()].filter((id) => id === null || !seated.has(id))
          .length,
      }
    },
    async requeueActive(tenantId, did) {
      return entries(
        tenantId,
        did,
        users
          .filter(
            (u) =>
              u.tenantId === tenantId &&
              u.directoryId === did &&
              u.active &&
              !u.deletedAt &&
              u.clerkUserId,
          )
          .map((u) => u.id),
        "updated",
      )
    },
    async fileWaitlist(tenantId, input) {
      if (!waitlist.some((w) => w.userId === input.userId && w.answered === null))
        waitlist.push({ tenantId, ...input, answered: null })
    },
    async closeWaitlist(tenantId, userId, accepted) {
      for (const w of waitlist)
        if (w.tenantId === tenantId && w.userId === userId && w.answered === null)
          w.answered = accepted
    },
    async provisioned(tenantId, input) {
      return users
        .filter(
          (u) =>
            u.tenantId === tenantId &&
            !u.deletedAt &&
            directories.get(u.directoryId)!.enabled &&
            (u.externalId === input.subject ||
              u.userName.toLowerCase() === input.subject.toLowerCase() ||
              u.email === input.email),
        )
        .map((u) => ({
          clerkUserId: u.clerkUserId,
          active: u.active || u.conflict === "last_owner",
          by:
            u.externalId === input.subject ||
            u.userName.toLowerCase() === input.subject.toLowerCase()
              ? ("subject" as const)
              : ("email" as const),
        }))
    },
  }

  for (const t of init.tokens ?? []) {
    const { hash } = scimToken(t.seed)
    tokens.push({
      id: id(),
      tenantId: tenant,
      directoryId: t.directoryId ?? DIRECTORY,
      tokenHash: hash,
      hint: `${TOKEN_PREFIX}${t.seed.slice(0, 4)}`,
      createdBy: null,
      createdAt: clock,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      ...t.over,
    })
  }

  return {
    store,
    directories,
    tokens,
    watchChannels,
    users,
    groups,
    memberships,
    outbox,
    events,
    waitlist,
    domains,
    calls,
    fail,
    tenant,
    seated,
    setClock(at: Date) {
      clock = at
    },
    /** Applies nothing: marks every pending entry applied, as a finished job would. */
    settleOutbox() {
      for (const o of outbox) o.appliedAt ??= clock
    },
  }
}

/** The Clerk calls provisioning makes, on the identity fakes' own Clerk users. */
export function memoryProvisioning(clerk: ReturnType<typeof memoryClerk>) {
  const calls: string[] = []
  const created: {
    email: string
    firstName: string
    lastName: string
    externalId: string
  }[] = []
  const fail = { createUser: false, addPrimaryEmail: false }
  /** Runs inside `createUser` before uniqueness is checked: the other half of a race. */
  const hooks: { beforeCreate?: (email: string) => void } = {}
  let n = 0
  const provisioning: ClerkProvisioning = {
    async createUser(input) {
      if (fail.createUser) throw new Error("clerk down")
      hooks.beforeCreate?.(input.email)
      calls.push(`createUser:${input.email}`)
      if (
        [...clerk.users.values()].some((u) =>
          u.emails.some((e) => e.address === input.email),
        )
      )
        return { outcome: "taken" }
      if (!input.firstName || !input.lastName) return { outcome: "incomplete" }
      const uid = `user_scim_${++n}`
      clerk.users.set(
        uid,
        clerkUser({
          id: uid,
          firstName: input.firstName,
          lastName: input.lastName,
          primaryEmailId: `idn_${uid}`,
          emails: [{ id: `idn_${uid}`, address: input.email, verified: true }],
          deleteSelfEnabled: true,
        }),
      )
      created.push(input)
      return { outcome: "created", id: uid }
    },
    async addPrimaryEmail(userId, email) {
      if (fail.addPrimaryEmail) throw new Error("clerk down")
      calls.push(`addPrimaryEmail:${userId}:${email}`)
      if (
        [...clerk.users.values()].some((u) => u.emails.some((e) => e.address === email))
      )
        return "taken"
      const u = clerk.users.get(userId)!
      const eid = `idn_added_${++n}`
      u.emails.push({ id: eid, address: email, verified: true })
      u.primaryEmailId = eid
      return "added"
    },
    async makePrimary(userId, emailId) {
      calls.push(`makePrimary:${userId}:${emailId}`)
      clerk.users.get(userId)!.primaryEmailId = emailId
    },
    async unban(userId) {
      calls.push(`unban:${userId}`)
      clerk.users.get(userId)!.banned = false
    },
  }
  return { provisioning, calls, created, fail, hooks }
}
