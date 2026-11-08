import { and, eq, isNull, lt } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import {
  connections,
  events,
  sessionActivity,
  ssoSessions,
  workspaceSettings,
} from "../db/identity.js"
import type { WorkspacePolicy, WorkspacePolicyStore } from "./ports.js"
import { MAX_SESSION_SECONDS_LIMIT } from "./workspace-policy.js"

/**
 * The database half of the workspace session, second-factor and network
 * policy (#345). The policy lives on the workspace's `workspace_settings`
 * row, so a change is a compare-free read-modify-write under that row's lock
 * with its audit row in the same transaction.
 *
 * ⚠ NO ROW IS "NOTHING SET", never an error: most workspaces never touch
 * these settings, and the gate must read them without making a row.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]
type SettingsRow = typeof workspaceSettings.$inferSelect

/** The policy a workspace with no row has. */
export const NO_POLICY: WorkspacePolicy = {
  maxSessionSeconds: null,
  idleTimeoutSeconds: null,
  requireSecondFactor: false,
  network: { console: false, apiKeys: false, ranges: [], grace: null },
}

export function toPolicy(row: SettingsRow | undefined): WorkspacePolicy {
  if (!row) return structuredClone(NO_POLICY)
  return {
    maxSessionSeconds: row.maxSessionSeconds,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    requireSecondFactor: row.requireSecondFactor,
    network: {
      console: row.ipAllowlistConsole,
      apiKeys: row.ipAllowlistApiKeys,
      ranges: [...row.ipRanges],
      grace:
        row.ipGraceUserId && row.ipGraceAddress && row.ipGraceUntil
          ? {
              userId: row.ipGraceUserId,
              address: row.ipGraceAddress,
              until: row.ipGraceUntil,
            }
          : null,
    },
  }
}

const SECONDS_PER_DAY = 24 * 60 * 60

export function workspacePolicyStore(db: Database): WorkspacePolicyStore {
  /** The settings row under a lock, made with its defaults first when missing. */
  const lockedSettings = async (tx: Tx, tenantId: string) => {
    await tx.insert(workspaceSettings).values({ tenantId }).onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.tenantId, tenantId))
      .for("update")
      .limit(1)
    return row!
  }

  return {
    async policy(tenantId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1),
      )
      return toPolicy(row)
    },

    async update(tenantId, actorUserId, change) {
      return withTenant(db, tenantId, async (tx) => {
        const current = await lockedSettings(tx, tenantId)
        const before = toPolicy(current)
        const base = { updatedBy: actorUserId, updatedAt: new Date() }
        let type: string
        let data: Record<string, unknown>
        if (change.kind === "session") {
          await tx
            .update(workspaceSettings)
            .set({
              ...base,
              maxSessionSeconds: change.maxSessionSeconds,
              idleTimeoutSeconds: change.idleTimeoutSeconds,
            })
            .where(eq(workspaceSettings.tenantId, tenantId))
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
          await tx
            .update(workspaceSettings)
            .set({ ...base, requireSecondFactor: change.required })
            .where(eq(workspaceSettings.tenantId, tenantId))
          type = "second_factor_policy.updated"
          data = { before: before.requireSecondFactor, after: change.required }
        } else {
          await tx
            .update(workspaceSettings)
            .set({
              ...base,
              ipAllowlistConsole: change.console,
              ipAllowlistApiKeys: change.apiKeys,
              ipRanges: change.ranges,
              ipGraceUserId: change.grace?.userId ?? null,
              ipGraceAddress: change.grace?.address ?? null,
              ipGraceUntil: change.grace?.until ?? null,
            })
            .where(eq(workspaceSettings.tenantId, tenantId))
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
        await tx.insert(events).values({ tenantId, type, actorUserId, data })
        const [row] = await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.tenantId, tenantId))
          .limit(1)
        return { before, after: toPolicy(row) }
      })
    },

    async sessionFacts(tenantId, sessionId) {
      return withTenant(db, tenantId, async (tx) => {
        const [bound] = await tx
          .select({
            boundAt: ssoSessions.boundAt,
            lastSeenAt: ssoSessions.lastSeenAt,
            revokedAt: ssoSessions.revokedAt,
            max: connections.maxSessionSeconds,
            idle: connections.idleTimeoutSeconds,
          })
          .from(ssoSessions)
          .innerJoin(
            connections,
            and(
              eq(connections.id, ssoSessions.connectionId),
              eq(connections.tenantId, ssoSessions.tenantId),
            ),
          )
          .where(
            and(
              eq(ssoSessions.tenantId, tenantId),
              eq(ssoSessions.sessionId, sessionId),
            ),
          )
          .limit(1)
        if (bound)
          return {
            bound: {
              boundAt: bound.boundAt,
              lastSeenAt: bound.lastSeenAt,
              connectionMaxSessionSeconds: bound.max,
              connectionIdleTimeoutSeconds: bound.idle,
            },
            activity: null,
            revoked: bound.revokedAt !== null,
          }
        const [row] = await tx
          .select()
          .from(sessionActivity)
          .where(
            and(
              eq(sessionActivity.tenantId, tenantId),
              eq(sessionActivity.sessionId, sessionId),
            ),
          )
          .limit(1)
        return {
          bound: null,
          activity: row
            ? { startedAt: row.startedAt, lastSeenAt: row.lastSeenAt }
            : null,
          revoked: row?.revokedAt != null,
        }
      })
    },

    async startActivity(tenantId, row) {
      return withTenant(db, tenantId, async (tx) => {
        const made = await tx
          .insert(sessionActivity)
          .values({
            tenantId,
            sessionId: row.sessionId,
            clerkUserId: row.clerkUserId,
            startedAt: row.startedAt,
            lastSeenAt: row.now,
          })
          .onConflictDoNothing()
          .returning({ sessionId: sessionActivity.sessionId })
        /*
         * ⚠ PRUNED HERE, WHEN A NEW ROW ARRIVES, so the table needs no job: a
         * row nobody has touched for longer than the longest session a
         * workspace may allow can no longer matter.
         */
        if (made.length > 0)
          await tx
            .delete(sessionActivity)
            .where(
              and(
                eq(sessionActivity.tenantId, tenantId),
                lt(
                  sessionActivity.lastSeenAt,
                  new Date(
                    row.now.getTime() -
                      (MAX_SESSION_SECONDS_LIMIT + SECONDS_PER_DAY) * 1000,
                  ),
                ),
              ),
            )
        const [current] = await tx
          .select()
          .from(sessionActivity)
          .where(
            and(
              eq(sessionActivity.tenantId, tenantId),
              eq(sessionActivity.sessionId, row.sessionId),
            ),
          )
          .limit(1)
        return {
          startedAt: current!.startedAt,
          lastSeenAt: current!.lastSeenAt,
          revoked: current!.revokedAt !== null,
        }
      })
    },

    async touchActivity(tenantId, sessionId, at) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(sessionActivity)
          .set({ lastSeenAt: at })
          .where(
            and(
              eq(sessionActivity.tenantId, tenantId),
              eq(sessionActivity.sessionId, sessionId),
              isNull(sessionActivity.revokedAt),
            ),
          ),
      )
    },

    async revokeActivity(tenantId, sessionId, reason, at) {
      const done = await withTenant(db, tenantId, (tx) =>
        tx
          .update(sessionActivity)
          .set({ revokedAt: at, revokedReason: reason })
          .where(
            and(
              eq(sessionActivity.tenantId, tenantId),
              eq(sessionActivity.sessionId, sessionId),
              isNull(sessionActivity.revokedAt),
            ),
          )
          .returning({ sessionId: sessionActivity.sessionId }),
      )
      return done.length > 0
    },
  }
}
