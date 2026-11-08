import { EXEMPTION_REQUEST_TTL_MS } from "../src/identity/policy-store.js"
import type {
  BypassEntry,
  DiscoveredConnection,
  EnforcementRead,
  SetupLinkRow,
  SsoPolicyStore,
} from "../src/identity/ports.js"

/**
 * An in-memory `SsoPolicyStore` (#340) with the same compare-and-set rules as
 * Postgres: one bypass sign-in per workspace and session, two different
 * owners for the exemption, one first use per link. The policies themselves
 * are tested against Postgres in identity-policy-db.test.ts.
 */
export function memoryPolicy(
  init: {
    /** What `enforcementRead` answers, per workspace; absent: nothing required. */
    reads?: Record<string, EnforcementRead>
    roles?: Record<string, string>
    passedRuns?: { connectionId: string; at: Date }[]
    discovered?: Record<string, DiscoveredConnection[]>
  } = {},
) {
  const reads = new Map(Object.entries(init.reads ?? {}))
  const roles = new Map(Object.entries(init.roles ?? {}))
  const bypass = new Map<string, Map<string, BypassEntry>>()
  const bypassSignIns = new Set<string>()
  const audit: { tenantId: string; sessionId: string; connectionIds: string[] }[] = []
  const settings = new Map<
    string,
    { enabled: boolean; requestedBy: string | null; requestedAt: Date | null }
  >()
  const links = new Map<string, SetupLinkRow & { tokenHash: string }>()
  const passedRuns = [...(init.passedRuns ?? [])]
  const calls: string[] = []
  let failing = false
  const fail = () => {
    if (failing) throw new Error("database down")
  }
  /** A link as the store hands it out: never its hash. */
  const view = (row: SetupLinkRow & { tokenHash: string }): SetupLinkRow => ({
    id: row.id,
    tenantId: row.tenantId,
    connectionId: row.connectionId,
    contactEmail: row.contactEmail,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt,
  })
  const settingsOf = (tenantId: string) =>
    settings.get(tenantId) ?? { enabled: true, requestedBy: null, requestedAt: null }
  const live = (s: { requestedAt: Date | null }, now: Date) =>
    s.requestedAt !== null &&
    now.getTime() - s.requestedAt.getTime() < EXEMPTION_REQUEST_TTL_MS

  const store: SsoPolicyStore = {
    async enforcementRead(tenantId) {
      calls.push("enforcementRead")
      fail()
      return structuredClone(reads.get(tenantId) ?? { required: false })
    },
    async noteBypassSignIn(tenantId, row) {
      calls.push("noteBypassSignIn")
      fail()
      const key = `${tenantId}:${row.sessionId}`
      if (bypassSignIns.has(key)) return false
      bypassSignIns.add(key)
      audit.push({
        tenantId,
        sessionId: row.sessionId,
        connectionIds: row.connectionIds,
      })
      return true
    },
    async bypassList(_t, connectionId) {
      return [...(bypass.get(connectionId)?.values() ?? [])]
    },
    async addBypass(_t, connectionId, entry) {
      const list = bypass.get(connectionId) ?? new Map<string, BypassEntry>()
      if (list.has(entry.clerkUserId)) return "exists"
      list.set(entry.clerkUserId, {
        clerkUserId: entry.clerkUserId,
        reason: entry.reason,
        addedBy: entry.addedBy,
        createdAt: new Date(),
      })
      bypass.set(connectionId, list)
      return "added"
    },
    async removeBypass(_t, connectionId, clerkUserId) {
      const row = bypass.get(connectionId)?.get(clerkUserId) ?? null
      bypass.get(connectionId)?.delete(clerkUserId)
      return row
    },
    async ownerExemption(tenantId, now) {
      const s = settingsOf(tenantId)
      return {
        enabled: s.enabled,
        pending:
          s.enabled && live(s, now)
            ? {
                requestedBy: s.requestedBy!,
                requestedAt: s.requestedAt!,
                expiresAt: new Date(
                  s.requestedAt!.getTime() + EXEMPTION_REQUEST_TTL_MS,
                ),
              }
            : null,
      }
    },
    async requestExemptionOff(tenantId, by, now) {
      const s = settingsOf(tenantId)
      if (!s.enabled) return "off"
      if (live(s, now)) return "pending"
      settings.set(tenantId, { enabled: true, requestedBy: by, requestedAt: now })
      return "requested"
    },
    async approveExemptionOff(tenantId, by, now) {
      const s = settingsOf(tenantId)
      if (!s.enabled || !live(s, now)) return { outcome: "none" }
      if (s.requestedBy === by) return { outcome: "same_owner" }
      if (roles.get(s.requestedBy!) !== "owner") return { outcome: "none" }
      settings.set(tenantId, { enabled: false, requestedBy: null, requestedAt: null })
      return { outcome: "applied", requestedBy: s.requestedBy! }
    },
    async cancelExemptionOff(tenantId) {
      const s = settingsOf(tenantId)
      if (!s.requestedBy) return false
      settings.set(tenantId, { ...s, requestedBy: null, requestedAt: null })
      return true
    },
    async enableExemption(tenantId) {
      const s = settingsOf(tenantId)
      if (s.enabled && !s.requestedBy) return false
      settings.set(tenantId, { enabled: true, requestedBy: null, requestedAt: null })
      return true
    },
    async passedTestRunSince(_t, connectionId, since) {
      return passedRuns.some(
        (r) => r.connectionId === connectionId && r.at.getTime() >= since.getTime(),
      )
    },
    async discover(domain) {
      calls.push(`discover:${domain}`)
      fail()
      return init.discovered?.[domain] ?? []
    },
    async createSetupLink(tenantId, input) {
      const row = {
        id: crypto.randomUUID(),
        tenantId,
        connectionId: input.connectionId,
        contactEmail: input.contactEmail,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
        usedAt: null,
        revokedAt: null,
        revokedReason: null,
        createdAt: new Date(),
        tokenHash: input.tokenHash,
      }
      links.set(row.id, row)
      return view(row)
    },
    async setupLinks(tenantId, connectionId) {
      return [...links.values()]
        .filter((l) => l.tenantId === tenantId && l.connectionId === connectionId)
        .map(view)
    },
    async revokeSetupLink(tenantId, connectionId, id, reason, at) {
      const row = links.get(id)
      if (!row || row.tenantId !== tenantId || row.connectionId !== connectionId)
        return null
      if (row.revokedAt) return null
      row.revokedAt = at
      row.revokedReason = reason
      return view(row)
    },
    async revokeSetupLinksOf(tenantId, connectionId, reason, at) {
      const done: string[] = []
      for (const row of links.values())
        if (
          row.tenantId === tenantId &&
          row.connectionId === connectionId &&
          !row.revokedAt &&
          row.expiresAt > at
        ) {
          row.revokedAt = at
          row.revokedReason = reason
          done.push(row.id)
        }
      return done
    },
    async setupLinkByHash(tokenHash) {
      fail()
      const row = [...links.values()].find((l) => l.tokenHash === tokenHash)
      return row ? { ...row } : null
    },
    async markSetupLinkUsed(_t, id, at) {
      const row = links.get(id)
      if (!row || row.usedAt) return false
      row.usedAt = at
      return true
    },
  }

  return {
    store,
    reads,
    roles,
    bypass,
    audit,
    settings,
    links,
    passedRuns,
    calls,
    failWith: (on: boolean) => {
      failing = on
    },
  }
}
