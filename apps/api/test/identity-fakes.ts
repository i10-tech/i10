import type {
  BoundSession,
  Connection,
  DeprovisionMode,
} from "../src/identity/model.js"
import type {
  AttemptRow,
  AuditEvent,
  ClerkIdentity,
  ClerkSessionSnapshot,
  ClerkUserSnapshot,
  GroupRoleRule,
  IdentityStore,
  ManagedRow,
  NewAttempt,
} from "../src/identity/ports.js"

/**
 * In-memory doubles for the identity core's two ports. The store keeps the
 * same compare-and-set semantics as Postgres (first caller wins); the real
 * policies are tested against Postgres in identity-db.test.ts.
 */

export const TENANT = "11111111-1111-4111-8111-111111111111"
export const OTHER_TENANT = "22222222-2222-4222-8222-222222222222"
export const ORG = "org_acme"
export const CONNECTION = "33333333-3333-4333-8333-333333333333"

export function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: CONNECTION,
    tenantId: TENANT,
    name: "Acme Okta",
    protocol: "test",
    provider: "generic",
    status: "active",
    enforcement: "off",
    jitEnabled: false,
    mfaRequired: false,
    maxSessionSeconds: null,
    idleTimeoutSeconds: null,
    config: {},
    attributeMapping: {},
    ...over,
  }
}

type Attempt = AttemptRow & {
  stateHash: string
  handoffCodeHash: string | null
  handoffSecretHash: string | null
  failureReason: string | null
  boundSessionId: string | null
}

/** A rule as the store hands it out: without the fake's tenant column. */
const publicRule = (r: GroupRoleRule): GroupRoleRule => ({
  id: r.id,
  connectionId: r.connectionId,
  groupValue: r.groupValue,
  role: r.role,
  precedence: r.precedence,
})

export function memoryStore(
  init: {
    connections?: Connection[]
    live?: Record<string, string[]>
    orgs?: Record<string, string | null>
    blocked?: string[]
    rules?: GroupRoleRule[]
    names?: Record<string, string>
  } = {},
) {
  const connections = new Map(
    (init.connections ?? [connection()]).map((c) => [c.id, c]),
  )
  const rules: (GroupRoleRule & { tenantId: string })[] = (init.rules ?? []).map(
    (r) => ({ ...r, tenantId: connections.get(r.connectionId)?.tenantId ?? TENANT }),
  )
  /** The JIT lock: one chain per key, as Postgres's advisory lock serialises. */
  const locks = new Map<string, Promise<unknown>>()
  const lockLog: string[] = []
  const live = init.live ?? { [CONNECTION]: ["acme.test"] }
  const orgs = init.orgs ?? { [TENANT]: ORG }
  const attempts = new Map<string, Attempt>()
  const identities: {
    id: string
    tenantId: string
    connectionId: string
    subject: string
    clerkUserId: string
    email: string | null
    lastLoginAt: Date | null
  }[] = []
  const managed = new Map<string, ManagedRow>()
  const sessions = new Map<
    string,
    BoundSession & {
      tenantId: string
      identityId: string | null
      idpSession: string | null
      authTime: Date | null
      revokedReason: string | null
    }
  >()
  const events: (AuditEvent & { tenantId: string })[] = []
  const testRuns: Record<string, unknown>[] = []
  const settings = new Map<string, DeprovisionMode>()
  /** Plain here; sealed by the real store. */
  const secrets = new Map<string, Record<string, unknown>>()
  let n = 0
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
  const fail = { gateRead: false }

  const store: IdentityStore = {
    async connection(tenantId, cid) {
      const c = connections.get(cid)
      return c && c.tenantId === tenantId ? { ...c } : null
    },
    async connectionForStart(cid) {
      const c = connections.get(cid)
      return c ? { ...c } : null
    },
    async connections(tenantId) {
      return [...connections.values()]
        .filter((c) => c.tenantId === tenantId)
        .map((c) => ({
          ...c,
          domains: (live[c.id] ?? []).map((name) => ({
            joinDomainId: name,
            name,
            live: true,
          })),
        }))
    },
    async createConnection(tenantId, input) {
      const made = connection({
        id: id(),
        tenantId,
        name: input.name,
        protocol: input.protocol,
        provider: input.provider,
        status: "draft",
      })
      connections.set(made.id, made)
      return made
    },
    async updateConnection(tenantId, cid, patch) {
      const c = connections.get(cid)
      if (!c || c.tenantId !== tenantId) return null
      const next = { ...c, ...patch }
      connections.set(cid, next)
      return next
    },
    async addDomain() {
      return "added"
    },
    async removeDomain() {
      return true
    },
    async liveDomains(_tenantId, cid) {
      return live[cid] ?? []
    },
    async workspaceOrg(tenantId) {
      return orgs[tenantId] ?? null
    },
    async workspaceName(tenantId) {
      return (init.names ?? { [TENANT]: "Acme" })[tenantId] ?? null
    },
    async coveredDomains(tenantId) {
      return [...connections.values()]
        .filter((c) => c.tenantId === tenantId && c.status === "active")
        .flatMap((c) => live[c.id] ?? [])
    },
    async groupRules(tenantId, cid) {
      return rules
        .filter((r) => r.tenantId === tenantId && r.connectionId === cid)
        .sort((a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id))
        .map(publicRule)
    },
    async createGroupRule(tenantId, input) {
      const c = connections.get(input.connectionId)
      if (!c || c.tenantId !== tenantId) return "not_found"
      const mine = rules.filter((r) => r.connectionId === input.connectionId)
      if (mine.some((r) => r.groupValue === input.groupValue)) return "exists"
      if (mine.length >= 100) return "too_many"
      const row = {
        id: id(),
        tenantId,
        connectionId: input.connectionId,
        groupValue: input.groupValue,
        role: input.role,
        precedence: input.precedence,
      }
      rules.push(row)
      return publicRule(row)
    },
    async updateGroupRule(tenantId, cid, ruleId, patch) {
      const row = rules.find(
        (r) => r.tenantId === tenantId && r.connectionId === cid && r.id === ruleId,
      )
      if (!row) return null
      if (
        patch.groupValue !== undefined &&
        rules.some(
          (r) =>
            r.connectionId === cid &&
            r.id !== ruleId &&
            r.groupValue === patch.groupValue,
        )
      )
        return "exists"
      Object.assign(row, patch)
      return publicRule(row)
    },
    async deleteGroupRule(tenantId, cid, ruleId) {
      const at = rules.findIndex(
        (r) => r.tenantId === tenantId && r.connectionId === cid && r.id === ruleId,
      )
      if (at < 0) return null
      const [row] = rules.splice(at, 1)
      return publicRule(row!)
    },
    async provisionLocked(tenantId, key, fn) {
      const name = `${key.connectionId}:${key.email}`
      const before = locks.get(name) ?? Promise.resolve()
      const run = before.then(async () => {
        lockLog.push(`lock:${name}`)
        try {
          return await fn({
            async identityBySubject(subject) {
              const row = identities.find(
                (i) =>
                  i.tenantId === tenantId &&
                  i.connectionId === key.connectionId &&
                  i.subject === subject,
              )
              return row ? { id: row.id, clerkUserId: row.clerkUserId } : null
            },
            async link(input) {
              const row = {
                id: id(),
                tenantId,
                connectionId: key.connectionId,
                ...input,
                lastLoginAt: null,
              }
              identities.push(row)
              return { id: row.id }
            },
          })
        } finally {
          lockLog.push(`unlock:${name}`)
        }
      })
      locks.set(
        name,
        run.catch(() => {}),
      )
      return run
    },
    async connectionSecrets(tenantId, cid) {
      const c = connections.get(cid)
      if (!c || c.tenantId !== tenantId) return null
      return structuredClone(secrets.get(cid) ?? {})
    },
    async setConnectionSecrets(tenantId, cid, edit) {
      const c = connections.get(cid)
      if (!c || c.tenantId !== tenantId) return null
      const done = edit({
        secrets: structuredClone(secrets.get(cid) ?? {}),
        config: structuredClone(c.config),
      })
      secrets.set(cid, structuredClone(done.secrets))
      const next = { ...c, config: structuredClone(done.config) }
      connections.set(cid, next)
      return { ...next }
    },
    async createAttempt(input: NewAttempt) {
      const row: Attempt = {
        id: id(),
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        purpose: input.purpose,
        bindingHash: input.bindingHash,
        stepUpSessionId: input.stepUpSessionId ?? null,
        returnTo: input.returnTo ?? null,
        nonce: input.nonce ?? null,
        pkceVerifier: input.pkceVerifier ?? null,
        requestId: input.requestId ?? null,
        expiresAt: input.expiresAt,
        consumedAt: null,
        outcome: null,
        clerkUserId: null,
        identityId: null,
        clerkOrgId: null,
        idpSession: null,
        authTime: null,
        handoffExpiresAt: null,
        redeemedAt: null,
        signInTokenId: null,
        tokenMintedAt: null,
        boundAt: null,
        stateHash: input.stateHash,
        handoffCodeHash: null,
        handoffSecretHash: null,
        failureReason: null,
        boundSessionId: null,
      }
      attempts.set(row.id, row)
      return { id: row.id }
    },
    async attemptByState(hash) {
      return [...attempts.values()].find((a) => a.stateHash === hash) ?? null
    },
    async consumeAttempt(_t, aid, at) {
      const a = attempts.get(aid)!
      if (a.consumedAt) return false
      a.consumedAt = at
      return true
    },
    async finishAttempt(_t, aid, finish) {
      const a = attempts.get(aid)!
      a.outcome = finish.outcome
      a.failureReason = finish.failureReason ?? null
      for (const key of [
        "clerkUserId",
        "identityId",
        "clerkOrgId",
        "idpSession",
        "authTime",
        "handoffCodeHash",
        "handoffExpiresAt",
      ] as const)
        if (finish[key] !== undefined)
          (a as unknown as Record<string, unknown>)[key] = finish[key]
    },
    async attemptByHandoffCode(hash) {
      return [...attempts.values()].find((a) => a.handoffCodeHash === hash) ?? null
    },
    async claimRedeem(_t, aid, at) {
      const a = attempts.get(aid)!
      if (a.redeemedAt) return false
      a.redeemedAt = at
      return true
    },
    async recordToken(_t, aid, token) {
      const a = attempts.get(aid)!
      a.signInTokenId = token.signInTokenId
      a.tokenMintedAt = token.mintedAt
      a.handoffSecretHash = token.handoffSecretHash
    },
    async attemptByHandoffSecret(hash) {
      return [...attempts.values()].find((a) => a.handoffSecretHash === hash) ?? null
    },
    async markBound(_t, aid, sid, at) {
      const a = attempts.get(aid)!
      if (a.boundAt) return false
      a.boundAt = at
      a.boundSessionId = sid
      return true
    },
    async identityBySubject(tenantId, cid, subject) {
      const row = identities.find(
        (i) =>
          i.tenantId === tenantId && i.connectionId === cid && i.subject === subject,
      )
      return row ? { id: row.id, clerkUserId: row.clerkUserId } : null
    },
    async identityByUser(tenantId, cid, userId) {
      const row = identities.find(
        (i) =>
          i.tenantId === tenantId && i.connectionId === cid && i.clerkUserId === userId,
      )
      return row ? { id: row.id, subject: row.subject } : null
    },
    async link(tenantId, input) {
      const row = { id: id(), tenantId, ...input, lastLoginAt: null }
      identities.push(row)
      return { id: row.id }
    },
    async touchIdentity(_t, iid, email, at) {
      const row = identities.find((i) => i.id === iid)!
      row.email = email
      row.lastLoginAt = at
    },
    async managedByUser(userId) {
      const row = managed.get(userId)
      return row ? { ...row } : null
    },
    async managedByIdentifier(identifier) {
      return [...managed.values()].some((m) => m.emails.includes(identifier))
    },
    async claimManaged(tenantId, row) {
      const existing = managed.get(row.clerkUserId)
      if (!existing) {
        managed.set(row.clerkUserId, { ...row, tenantId })
        return "created"
      }
      return existing.tenantId === tenantId ? "kept" : "elsewhere"
    },
    async setManagedEmails(_t, userId, emails, connectionId) {
      const row = managed.get(userId)!
      row.emails = emails
      if (connectionId !== undefined) row.connectionId = connectionId
    },
    async releaseManaged(tenantId, userId) {
      const row = managed.get(userId)
      if (!row || row.tenantId !== tenantId) return false
      managed.delete(userId)
      return true
    },
    async forgetUser(tenantId, userId) {
      for (let i = identities.length - 1; i >= 0; i--)
        if (
          identities[i]!.tenantId === tenantId &&
          identities[i]!.clerkUserId === userId
        )
          identities.splice(i, 1)
      if (managed.get(userId)?.tenantId === tenantId) managed.delete(userId)
    },
    async gateRead(userId, sid) {
      if (fail.gateRead) throw new Error("database down")
      const m = managed.get(userId)
      if (!m) return { managed: null }
      const s = sessions.get(sid)
      const c = s ? connections.get(s.connectionId) : null
      return {
        managed: { tenantId: m.tenantId, connectionId: m.connectionId },
        session:
          s && c && s.tenantId === m.tenantId && s.clerkUserId === userId
            ? {
                ...s,
                connectionStatus: c.status,
                domainLive: (live[c.id] ?? []).length > 0,
                maxSessionSeconds: c.maxSessionSeconds,
                idleTimeoutSeconds: c.idleTimeoutSeconds,
              }
            : null,
      }
    },
    async bindSession(tenantId, row) {
      sessions.set(row.sessionId, {
        sessionId: row.sessionId,
        tenantId,
        clerkUserId: row.clerkUserId,
        connectionId: row.connectionId,
        identityId: row.identityId,
        idpSession: row.idpSession,
        authTime: row.authTime,
        boundAt: row.at,
        freshAt: row.freshAt,
        lastSeenAt: row.at,
        revokedAt: null,
        revokedReason: null,
      })
    },
    async touchSession(_t, sid, at) {
      const s = sessions.get(sid)
      if (s) s.lastSeenAt = at
    },
    async revokeSessionRow(_t, sid, reason, at) {
      const s = sessions.get(sid)
      if (!s || s.revokedAt) return false
      s.revokedAt = at
      s.revokedReason = reason
      return true
    },
    async sessionRow(tenantId, sid) {
      const s = sessions.get(sid)
      return s && s.tenantId === tenantId ? { ...s } : null
    },
    async sessionsOf(tenantId, userId) {
      return [...sessions.values()].filter(
        (s) => s.tenantId === tenantId && s.clerkUserId === userId && !s.revokedAt,
      )
    },
    async setFresh(_t, sid, at) {
      sessions.get(sid)!.freshAt = at
    },
    async isBlocked(_t, email) {
      return (init.blocked ?? []).includes(email)
    },
    async deprovisionMode(tenantId) {
      return settings.get(tenantId) ?? "membership"
    },
    async setDeprovisionMode(tenantId, mode) {
      settings.set(tenantId, mode)
    },
    async recordTestRun(tenantId, row) {
      testRuns.push({ tenantId, ...row })
      return { id: id() }
    },
    async record(tenantId, event) {
      events.push({ tenantId, ...event })
    },
    async events() {
      return []
    },
  }
  return {
    store,
    connections,
    live,
    attempts,
    identities,
    managed,
    sessions,
    events,
    testRuns,
    secrets,
    rules,
    lockLog,
    fail,
  }
}

export function user(over: Partial<ClerkUserSnapshot> = {}): ClerkUserSnapshot {
  return {
    id: "user_ada",
    banned: false,
    firstName: "Ada",
    lastName: "Lovelace",
    primaryEmailId: "idn_1",
    emails: [{ id: "idn_1", address: "ada@acme.test", verified: true }],
    passwordEnabled: false,
    twoFactorEnabled: false,
    totpEnabled: false,
    backupCodeEnabled: false,
    externalAccountIds: [],
    passkeyIds: [],
    phoneIds: [],
    web3WalletIds: [],
    deleteSelfEnabled: false,
    ...over,
  }
}

export function memoryClerk(init: { users?: ClerkUserSnapshot[] } = {}) {
  const users = new Map((init.users ?? [user()]).map((u) => [u.id, u]))
  const calls: string[] = []
  const minted: { userId: string; orgId: string }[] = []
  const tokens = new Map<string, "pending" | "accepted" | "revoked">()
  const clerkSessions = new Map<string, ClerkSessionSnapshot>()
  const strategies = new Map<string, string | null>()
  const active = new Map<string, { id: string; createdAt: Date }[]>()
  const fail = { mint: false, revokeSession: false, updateProfile: false }
  /** Runs inside `createUser` before Clerk's uniqueness is checked: a race's other half. */
  const hooks: { beforeCreate?: (email: string) => Promise<void> | void } = {}
  const created: string[] = []
  const profiles: { userId: string; names: Record<string, string> }[] = []
  let n = 0
  let made = 0

  const clerk: ClerkIdentity = {
    async mintSignInToken(input) {
      if (fail.mint) throw new Error("clerk down")
      minted.push(input)
      const tid = `sit_${++n}`
      tokens.set(tid, "pending")
      return { id: tid, token: `ticket_${n}` }
    },
    async revokeSignInToken(tid) {
      calls.push(`revokeToken:${tid}`)
      if (tokens.get(tid) === "pending") {
        tokens.set(tid, "revoked")
        return "revoked"
      }
      return "not_revocable"
    },
    async session(sid) {
      return clerkSessions.get(sid) ?? null
    },
    async lastStrategy(clientId) {
      return strategies.has(clientId) ? (strategies.get(clientId) ?? null) : null
    },
    async revokeSession(sid) {
      if (fail.revokeSession) throw new Error("clerk down")
      calls.push(`revokeSession:${sid}`)
    },
    async activeSessions(userId) {
      return active.get(userId) ?? []
    },
    async user(userId) {
      const u = users.get(userId)
      return u ? structuredClone(u) : null
    },
    async usersByEmail(email) {
      return [...users.values()].filter((u) =>
        u.emails.some((e) => e.address === email),
      )
    },
    async createUser(input) {
      await hooks.beforeCreate?.(input.email)
      // Clerk's own uniqueness: one account per address in an instance.
      if (
        [...users.values()].some((u) => u.emails.some((e) => e.address === input.email))
      )
        return { outcome: "exists" }
      // Like our instances: first and last name are required of every user.
      if (!input.firstName || !input.lastName) return { outcome: "incomplete" }
      const uid = `user_jit_${++made}`
      users.set(
        uid,
        user({
          id: uid,
          firstName: input.firstName,
          lastName: input.lastName,
          primaryEmailId: `idn_${uid}`,
          emails: [{ id: `idn_${uid}`, address: input.email, verified: true }],
          deleteSelfEnabled: true,
        }),
      )
      created.push(uid)
      calls.push(`createUser:${input.email}`)
      return { outcome: "created", userId: uid }
    },
    async updateProfile(userId, names) {
      if (fail.updateProfile) throw new Error("clerk down")
      profiles.push({ userId, names: { ...names } as Record<string, string> })
      const u = users.get(userId)!
      if (names.firstName !== undefined) u.firstName = names.firstName
      if (names.lastName !== undefined) u.lastName = names.lastName
    },
    async removePassword(userId) {
      calls.push(`removePassword:${userId}`)
      users.get(userId)!.passwordEnabled = false
    },
    async deleteExternalAccount(userId, eid) {
      calls.push(`deleteExternal:${eid}`)
      const u = users.get(userId)!
      u.externalAccountIds = u.externalAccountIds.filter((x) => x !== eid)
    },
    async deletePasskey(userId, pid) {
      calls.push(`deletePasskey:${pid}`)
      const u = users.get(userId)!
      u.passkeyIds = u.passkeyIds.filter((x) => x !== pid)
    },
    async deletePhoneNumber(pid) {
      calls.push(`deletePhone:${pid}`)
      for (const u of users.values()) u.phoneIds = u.phoneIds.filter((x) => x !== pid)
    },
    async deleteWeb3Wallet(userId, wid) {
      calls.push(`deleteWeb3:${wid}`)
      const u = users.get(userId)!
      u.web3WalletIds = u.web3WalletIds.filter((x) => x !== wid)
    },
    async disableMfa(userId) {
      calls.push(`disableMfa:${userId}`)
      const u = users.get(userId)!
      u.twoFactorEnabled = false
      u.totpEnabled = false
    },
    async deleteBackupCodes(userId) {
      calls.push(`deleteBackupCodes:${userId}`)
      users.get(userId)!.backupCodeEnabled = false
    },
    async deleteEmailAddress(eid) {
      calls.push(`deleteEmail:${eid}`)
      for (const u of users.values()) u.emails = u.emails.filter((e) => e.id !== eid)
    },
    async forbidSelfDelete(userId) {
      calls.push(`forbidSelfDelete:${userId}`)
      users.get(userId)!.deleteSelfEnabled = false
    },
    async ban(userId) {
      calls.push(`ban:${userId}`)
      users.get(userId)!.banned = true
    },
  }

  /** Clerk redeeming a ticket: a new session on a client that says `ticket`. */
  function redeem(ticket: string, at: Date, strategy = "ticket") {
    const tid = `sit_${ticket.slice("ticket_".length)}`
    tokens.set(tid, "accepted")
    const sid = `sess_${tid.slice(4)}x`
    const u = minted[Number(tid.slice(4)) - 1]!
    clerkSessions.set(sid, {
      id: sid,
      userId: u.userId,
      clientId: `client_${sid}`,
      status: "active",
      createdAt: at,
    })
    strategies.set(`client_${sid}`, strategy)
    return sid
  }

  return {
    clerk,
    users,
    calls,
    minted,
    tokens,
    clerkSessions,
    strategies,
    active,
    fail,
    hooks,
    created,
    profiles,
    redeem,
  }
}

export const log = { info: () => {}, warn: () => {}, error: () => {} }
