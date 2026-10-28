import type { WebhookEventName } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { enqueueDelivery, type WebhookJob } from "../queue/webhook-queue.js"
import type { Queue } from "groupmq"
import { fanOutToSubscribers, type FannedOut } from "./fanout.js"
import type { Logger } from "./events.js"

/**
 * The identity events (#345) as customer webhooks: `member.provisioned`,
 * `member.deprovisioned`, `sso.connection.failed`, `sso.certificate.expiring`.
 *
 * ⚠ RECORDED AFTER THE AUDIT EVENT COMMITS, NEVER INSIDE THE IDENTITY
 * TRANSACTION (identity/audit-tap.ts calls this once `store.record` returned).
 * A webhook for a change that then rolled back would tell a customer something
 * that did not happen; the reverse - the change committed and this failed - is
 * a missed notification, logged, and the audit log still holds the truth.
 *
 * ⚠ NEVER THROWS. The caller is a sign-in, a deprovision or a nightly pass,
 * and none of them may fail because a customer's webhook could not be queued.
 *
 * ⚠ THE ROWS ARE THE RECORD, THE QUEUE IS A PROMPT (#279). A process without a
 * queue - the daily re-check job - writes the rows and queues nothing; the
 * worker's sweep finds a delivery that is due and unattended within a minute
 * or two and sends it.
 */
export type IdentityWebhookType = Extract<
  WebhookEventName,
  | "member.provisioned"
  | "member.deprovisioned"
  | "sso.connection.failed"
  | "sso.certificate.expiring"
>

export interface IdentityWebhooks {
  emit(
    tenantId: string,
    type: IdentityWebhookType,
    data: Record<string, unknown>,
    at?: Date,
  ): Promise<void>
}

export function identityWebhooks(opts: {
  db: Database
  /** The delivery queue, when this process has one. */
  queue?: Queue<WebhookJob>
  log: Pick<Logger, "warn">
}): IdentityWebhooks {
  return {
    async emit(tenantId, type, data, at = new Date()) {
      try {
        const deliveries: FannedOut[] = await withTenant(opts.db, tenantId, (tx) =>
          fanOutToSubscribers(tx, {
            tenantId,
            type,
            data: { ...data, created_at: at.toISOString() },
            occurredAt: at,
          }),
        )
        const queue = opts.queue
        if (!queue) return
        await Promise.all(
          deliveries.map((d) =>
            enqueueDelivery(
              queue,
              { deliveryId: d.id, endpointId: d.endpointId, tenantId: d.tenantId },
              { orderMs: d.occurredAt.getTime() },
            ),
          ),
        )
      } catch (err) {
        opts.log.warn(
          { err: String(err), tenantId, type },
          "could not record an identity webhook; the audit log has the event",
        )
      }
    },
  }
}
