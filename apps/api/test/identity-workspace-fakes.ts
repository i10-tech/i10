import type {
  NetworkPolicy,
  WorkspacePolicy,
  WorkspacePolicyChange,
  WorkspacePolicyStore,
} from "../src/identity/ports.js"
import type { memoryStore } from "./identity-fakes.js"

/**
 * An in-memory `WorkspacePolicyStore` (#345) with the same rules as Postgres:
 * no row is nothing set, a change and its audit row happen together, and a
 * bound session is measured from `memoryStore`'s own sessions and connections.
 * The queries themselves are tested against Postgres in
 * identity-workspace-policy-db.test.ts.
 */
export function memoryWorkspacePolicy(
  world: ReturnType<typeof memoryStore>,
  init: Partial<Record<string, Partial<WorkspacePolicy>>> = {},
) {
  const none = (): WorkspacePolicy => ({
    maxSessionSeconds: null,
    idleTimeoutSeconds: null,
    requireSecondFactor: false,
    network: { console: false, apiKeys: false, ranges: [], grace: null },
  })
  const policies = new Map<string, WorkspacePolicy>(
    Object.entries(init).map(([tenant, p]) => [tenant, { ...none(), ...p }]),
  )
  const activity = new Map<
    string,
    { startedAt: Date; lastSeenAt: Date; revokedAt: Date | null; reason: string | null }
  >()
  const calls: string[] = []
  let failing = false

  const current = (tenantId: string) =>
    structuredClone(policies.get(tenantId) ?? none())
  const store: WorkspacePolicyStore = {
    async policy(tenantId) {
      calls.push("policy")
      if (failing) throw new Error("database down")
      return current(tenantId)
    },
    async update(tenantId, actorUserId, change: WorkspacePolicyChange) {
      if (failing) throw new Error("database down")
      const before = current(tenantId)
      const after = current(tenantId)
      let type: string
      let data: Record<string, unknown>
      if (change.kind === "session") {
        after.maxSessionSeconds = change.maxSessionSeconds
        after.idleTimeoutSeconds = change.idleTimeoutSeconds
        type = "session_policy.updated"
        data = {
          before: {
            maxSessionSeconds: before.maxSessionSeconds,
            idleTimeoutSeconds: before.idleTimeoutSeconds,
          },
          after: {
            maxSessionSeconds: change.maxSessionSeconds,
            idleTimeoutSeconds: change.idleTimeoutSeconds,
          },
        }
      } else if (change.kind === "second_factor") {
        after.requireSecondFactor = change.required
        type = "second_factor_policy.updated"
        data = { before: before.requireSecondFactor, after: change.required }
      } else {
        const network: NetworkPolicy = {
          console: change.console,
          apiKeys: change.apiKeys,
          ranges: [...change.ranges],
          grace: change.grace,
        }
        after.network = network
        type = "ip_allowlist.updated"
        data = {
          before: {
            console: before.network.console,
            apiKeys: before.network.apiKeys,
            ranges: before.network.ranges,
          },
          after: {
            console: change.console,
            apiKeys: change.apiKeys,
            ranges: change.ranges,
          },
          lockoutConfirmed: change.lockoutConfirmed,
        }
      }
      policies.set(tenantId, after)
      world.events.push({ tenantId, type, actorUserId, data })
      return { before, after: current(tenantId) }
    },
    async sessionFacts(tenantId, sessionId) {
      calls.push("sessionFacts")
      if (failing) throw new Error("database down")
      const bound = world.sessions.get(sessionId)
      if (bound && bound.tenantId === tenantId) {
        const c = world.connections.get(bound.connectionId)
        return {
          bound: {
            boundAt: bound.boundAt,
            lastSeenAt: bound.lastSeenAt,
            connectionMaxSessionSeconds: c?.maxSessionSeconds ?? null,
            connectionIdleTimeoutSeconds: c?.idleTimeoutSeconds ?? null,
          },
          activity: null,
          revoked: bound.revokedAt !== null,
        }
      }
      const row = activity.get(`${tenantId}:${sessionId}`)
      return {
        bound: null,
        activity: row ? { startedAt: row.startedAt, lastSeenAt: row.lastSeenAt } : null,
        revoked: row?.revokedAt != null,
      }
    },
    async startActivity(tenantId, row) {
      calls.push("startActivity")
      if (failing) throw new Error("database down")
      const key = `${tenantId}:${row.sessionId}`
      if (!activity.has(key))
        activity.set(key, {
          startedAt: row.startedAt,
          lastSeenAt: row.now,
          revokedAt: null,
          reason: null,
        })
      const made = activity.get(key)!
      return {
        startedAt: made.startedAt,
        lastSeenAt: made.lastSeenAt,
        revoked: made.revokedAt !== null,
      }
    },
    async touchActivity(tenantId, sessionId, at) {
      calls.push("touchActivity")
      const row = activity.get(`${tenantId}:${sessionId}`)
      if (row && !row.revokedAt) row.lastSeenAt = at
    },
    async revokeActivity(tenantId, sessionId, reason, at) {
      const row = activity.get(`${tenantId}:${sessionId}`)
      if (!row || row.revokedAt) return false
      row.revokedAt = at
      row.reason = reason
      return true
    },
  }
  return {
    store,
    policies,
    activity,
    calls,
    set(tenantId: string, over: Partial<WorkspacePolicy>) {
      policies.set(tenantId, { ...current(tenantId), ...over })
    },
    setNetwork(tenantId: string, over: Partial<NetworkPolicy>) {
      const p = current(tenantId)
      policies.set(tenantId, { ...p, network: { ...p.network, ...over } })
    },
    fail(on = true) {
      failing = on
    },
  }
}
