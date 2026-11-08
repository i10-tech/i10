import type { IdentityWebhooks } from "../webhooks/identity-events.js"
import type { IdentityAlerts } from "./alerts.js"
import {
  FAILURE_ALERT_EVERY_MS,
  FAILURE_TYPES,
  NOT_THE_CONNECTIONS_FAULT,
  healthOf,
  type ConnectionHealthStore,
} from "./health.js"
import type { AuditEvent, IdentityStore, Logger } from "./ports.js"

/**
 * What the identity audit log's events set going afterwards (#345): customer
 * webhooks, and the failure alert.
 *
 * ⚠ A TAP ON `store.record`, SO IT RUNS AFTER THE ROW COMMITTED. Every call
 * site that audits an identity change already goes through `record`, in the
 * API and in the nightly job; wrapping the store once at construction covers
 * all of them without any site knowing, and a new site that audits a tapped
 * event gets its webhook for free. The few events written inside a larger
 * transaction (`sso.bypass_used`, directory events) are not tapped here and do
 * not need to be.
 *
 * ⚠ NEVER THROWS, NEVER SLOWS A SIGN-IN BEYOND A FEW INDEXED QUERIES. The tap
 * is awaited so tests and the nightly job see its effects, but every step is
 * caught and logged: a webhook, an email or a health read that fails costs a
 * notification, never the flow that triggered it.
 */
export type AuditTap = (tenantId: string, event: AuditEvent) => Promise<void>

export interface TapDeps {
  webhooks?: IdentityWebhooks
  health?: ConnectionHealthStore
  alerts?: IdentityAlerts
  store?: Pick<IdentityStore, "relinkRequests">
  /** The connection's status: only an active one can be failing. */
  connectionStatus(tenantId: string, connectionId: string): Promise<string | null>
  log: Pick<Logger, "warn" | "error">
  now?: () => Date
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

export function auditTap(d: TapDeps): AuditTap {
  const now = () => (d.now ?? (() => new Date()))()

  async function failed(tenantId: string, event: AuditEvent): Promise<void> {
    const connectionId = event.connectionId
    if (!d.webhooks || !d.health || !connectionId) return
    if (NOT_THE_CONNECTIONS_FAULT.includes(event.reason ?? "")) return
    const at = now()
    const [counts, status] = await Promise.all([
      d.health.counts(tenantId, connectionId),
      d.connectionStatus(tenantId, connectionId),
    ])
    const health = healthOf(counts, status ?? "draft", at)
    // Only a connection that can sign people in has sign-ins to fail.
    if (status !== "active") return
    const trigger = health.reason ?? "sign_in_failed"
    const snapshot = {
      trigger,
      reason: event.reason ?? null,
      failures_last_hour: health.failuresLastHour,
      failures_last_24h: health.failuresLast24Hours,
      last_success_at: health.lastSuccessAt,
    }
    // ⚠ AT MOST ONE PER CONNECTION PER 15 MINUTES, claimed in the database.
    if (
      !(await d.health.claimAlert(
        tenantId,
        connectionId,
        snapshot,
        FAILURE_ALERT_EVERY_MS,
      ))
    )
      return
    await d.webhooks.emit(
      tenantId,
      "sso.connection.failed",
      { connection_id: connectionId, ...snapshot },
      at,
    )
  }

  async function run(tenantId: string, event: AuditEvent): Promise<void> {
    const data = event.data ?? {}
    switch (event.type) {
      case "managed.claimed":
        if (!d.webhooks || !event.subjectUserId) return
        await d.webhooks.emit(tenantId, "member.provisioned", {
          user_id: event.subjectUserId,
          connection_id: event.connectionId ?? null,
          source: event.reason ?? "claimed",
        })
        return
      case "member.deprovisioned": {
        if (!d.webhooks || !event.subjectUserId) return
        const keys = Array.isArray(data.apiKeys) ? data.apiKeys : []
        await d.webhooks.emit(tenantId, "member.deprovisioned", {
          user_id: event.subjectUserId,
          connection_id: event.connectionId ?? null,
          mode: data.mode === "account" ? "account" : "membership",
          cause: event.reason ?? null,
          actor_user_id: event.actorUserId ?? null,
          sessions_revoked: typeof data.sessions === "number" ? data.sessions : 0,
          // ⚠ IDS AND NAMES, rebuilt field by field: nothing else the audit
          // data may one day carry reaches a customer's endpoint.
          api_keys: keys.flatMap((k: unknown) => {
            const key = k as { id?: unknown; name?: unknown }
            return typeof key.id === "string" && typeof key.name === "string"
              ? [{ id: key.id, name: key.name }]
              : []
          }),
        })
        return
      }
      case "sso.certificate.expiring": {
        const connectionId = event.connectionId
        const dataDirId = str(data.directoryId)
        const targetId = connectionId ?? dataDirId
        const fingerprint = str(data.fingerprint)
        const notAfter = str(data.notAfter)
        const days = typeof data.days === "number" ? data.days : null
        const credential =
          data.kind === "client_secret"
            ? "client secret"
            : data.kind === "scim_token"
              ? "SCIM token"
              : "certificate"
        const idOrFingerprint =
          fingerprint ??
          (data.kind === "client_secret"
            ? `${connectionId}:${notAfter}`
            : data.kind === "scim_token"
              ? (str(data.hint) ?? str(data.tokenId) ?? "token")
              : connectionId)
        if (!targetId || !idOrFingerprint || !notAfter || days === null) return
        await Promise.all([
          connectionId && fingerprint
            ? d.webhooks?.emit(tenantId, "sso.certificate.expiring", {
                connection_id: connectionId,
                fingerprint,
                not_after: notAfter,
                days,
              })
            : Promise.resolve(),
          d.alerts?.certificateExpiring(tenantId, {
            connectionId: targetId,
            fingerprint: idOrFingerprint,
            notAfter: new Date(notAfter),
            days,
            credential,
          }),
        ])
        return
      }
      case "identity.relink_requested": {
        const connectionId = event.connectionId
        if (!d.alerts || !d.health || !connectionId) return
        const claimed = await d.health.claimAlert(
          tenantId,
          connectionId,
          { connectionId },
          60 * 60_000,
          "identity.relink_requested_alert",
        )
        if (!claimed) return
        const count = d.store
          ? (await d.store.relinkRequests(tenantId, connectionId, now())).length
          : 1
        await d.alerts.relinkRequested(tenantId, {
          connectionId,
          count: count > 0 ? count : 1,
        })
        return
      }
      case "directory.sync_failed": {
        if (!d.alerts || !d.health) return
        const directoryId =
          typeof data.directoryId === "string" ? data.directoryId : null
        if (!directoryId) return
        const error =
          event.reason ??
          (typeof data.error === "string" ? data.error : undefined) ??
          "unknown"
        const claimed = await d.health.claimAlert(
          tenantId,
          { directoryId },
          { directoryId, reason: error, error },
          24 * 60 * 60_000,
          "directory.sync_failed_alert",
        )
        if (!claimed) return
        await d.alerts.directorySyncFailed(tenantId, {
          directoryId,
          error,
        })
        return
      }
      default:
        if ((FAILURE_TYPES as readonly string[]).includes(event.type))
          await failed(tenantId, event)
    }
  }

  return async (tenantId, event) => {
    try {
      await run(tenantId, event)
    } catch (err) {
      d.log.warn(
        { err: String(err), tenantId, type: event.type },
        "an identity event's follow-up failed; the audit log has the event",
      )
    }
  }
}

/** The store, with `record` followed by the tap. Everything else is the store's own. */
export function tapped(store: IdentityStore, tap: AuditTap): IdentityStore {
  return {
    ...store,
    async record(tenantId, event) {
      await store.record(tenantId, event)
      await tap(tenantId, event)
    },
  }
}
