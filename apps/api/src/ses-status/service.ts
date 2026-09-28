import { workspaceOfSesTenant } from "../domains/identity.js"
import { SYSTEM_SES_TENANT } from "../system-mail.js"
import type { SesSendingStatus, TenantStatusEvent } from "./event.js"
import type { SesStatusStore } from "./store.js"

/**
 * What happens when SES says a tenant's sending status changed (#157).
 *
 * ⚠ ONE ENTRY POINT FOR BOTH SOURCES. The EventBridge event is the fast path and
 * the daily poll is the net under it; both come here, so a change is recorded,
 * refused at accept and told to the owner the same way however we heard.
 */
export type StatusOutcome =
  /** The workspace's current status moved. */
  | "changed"
  /** Recorded in the history; the current status did not move. */
  | "unchanged"
  /** Our own tenant - alerted, never stored against a workspace. */
  | "system"
  /** Not a tenant of ours, or a workspace that no longer exists. */
  | "ignored"

export interface OwnerNotice {
  /**
   * Emails the workspace owner. `paused` is true for a pause, false for a
   * resume after one.
   */
  send(input: {
    tenantId: string
    paused: boolean
    cause: string | null
    /** Makes the email idempotent across the event and the poll. */
    key: string
  }): Promise<void>
}

export interface StatusServiceDeps {
  store: SesStatusStore
  notice?: OwnerNotice
  log?: {
    info?: (o: object, m: string) => void
    warn?: (o: object, m: string) => void
    error?: (o: object, m: string) => void
  }
  /** Sentry, for the one case nobody else will notice. */
  alert?: (error: Error, context: Record<string, unknown>) => void
}

export interface StatusService {
  apply(event: TenantStatusEvent, source: "event" | "poll"): Promise<StatusOutcome>
}

const isPaused = (s: SesSendingStatus) => s === "disabled"

export function sesStatusService({
  store,
  notice,
  log,
  alert,
}: StatusServiceDeps): StatusService {
  return {
    async apply(event, source) {
      /*
       * ⚠ OUR OWN TENANT PAUSED MEANS SIGN-IN CODES STOP. There is no workspace
       * to refuse at accept or owner to email - the only right response is to
       * wake a human, which is what the alert is for.
       */
      if (event.sesTenant === SYSTEM_SES_TENANT) {
        const message = `our own SES tenant ${SYSTEM_SES_TENANT} is ${event.status}`
        if (isPaused(event.status)) {
          log?.error?.({ ...event, source }, message)
          alert?.(new Error(message), {
            phase: "ses-tenant-status",
            cause: event.cause,
          })
        } else {
          log?.info?.({ ...event, source }, message)
        }
        return "system"
      }

      const tenantId = workspaceOfSesTenant(event.sesTenant)
      if (!tenantId) {
        log?.warn?.(
          { sesTenant: event.sesTenant },
          "status change for a tenant that is not ours",
        )
        return "ignored"
      }

      let result: Awaited<ReturnType<SesStatusStore["record"]>>
      try {
        result = await store.record({
          tenantId,
          status: event.status,
          cause: event.cause,
          origin: event.origin,
          changedAt: event.changedAt,
          source,
        })
      } catch (error) {
        // ⚠ A WORKSPACE DELETED SINCE ITS TENANT WAS MADE: the foreign key
        // refuses the row. Nothing to pause, nobody to tell.
        if ((error as { code?: string }).code === "23503") {
          log?.warn?.(
            { sesTenant: event.sesTenant },
            "status change for a deleted workspace",
          )
          return "ignored"
        }
        throw error
      }

      if (!result.changed) return "unchanged"

      log?.warn?.(
        {
          tenantId,
          from: result.previous,
          to: event.status,
          cause: event.cause,
          source,
        },
        "SES sending status changed",
      )

      // ⚠ A PAUSE, AND THE RESUME AFTER ONE. `reinstated` after `enabled` - or
      // any other move that does not cross the paused line - tells the owner
      // nothing they need to act on.
      const paused = isPaused(event.status)
      if (notice && paused !== isPaused(result.previous)) {
        try {
          await notice.send({
            tenantId,
            paused,
            cause: event.cause,
            key: `ses-status:${tenantId}:${event.status}:${event.changedAt.toISOString()}`,
          })
          await store.markNotified(tenantId, event.changedAt)
        } catch (error) {
          // ⚠ THE PAUSE STANDS WITHOUT THE EMAIL. Accept refuses sends and the
          // console shows the banner either way; the email is a courtesy, and
          // failing the webhook over it would make SNS redeliver a change we
          // have already recorded.
          log?.error?.(
            { err: error, tenantId },
            "could not email the owner about sending status",
          )
        }
      }
      return "changed"
    },
  }
}
