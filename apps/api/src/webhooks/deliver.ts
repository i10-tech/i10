import type { WebhookJob } from "../queue/webhook-queue.js"
import { envelope, type Logger, type WebhookEventType } from "./events.js"
import { describeError } from "../errors.js"
import { signPayload, timestampFor } from "./signing.js"

/**
 * Delivering one webhook.
 *
 * ⚠ AT LEAST ONCE, AND SAID OUT LOUD IN THE DOCS RATHER THAN HOPED AWAY. A
 * receiver that commits its work and then times out on the response is
 * indistinguishable from one that never received the request, so we send again.
 * The delivery id is stable across attempts precisely so the customer can make
 * their handler idempotent — it is the only thing that lets them.
 *
 * ⚠ AND A DELIVERY MUST NEVER BE ABLE TO HANG A WORKER. A customer's endpoint
 * is code we do not control, on infrastructure we do not control, and the
 * failure that matters is not an error — it is a socket that accepts the
 * connection and then says nothing. Without a hard timeout, one such endpoint
 * occupies a worker slot until the job lease expires, and a handful of them
 * stop every other customer's webhooks.
 */

/** How long a customer's endpoint has to answer. */
export const DELIVERY_TIMEOUT_MS = 10_000

/**
 * ⚠ AFTER THIS MANY CONSECUTIVE FAILURES THE ENDPOINT IS SWITCHED OFF. Not a
 * courtesy to the customer — a protection for the queue. An endpoint whose host
 * no longer exists would otherwise take five attempts for every event that
 * tenant ever generates, forever, in a queue their neighbours share.
 */
export const DISABLE_AFTER_FAILURES = 20

export interface DeliveryRecord {
  id: string
  tenantId: string
  endpointId: string
  url: string
  /** Decrypted at read time by the adapter; never logged. */
  secret: string
  eventType: WebhookEventType
  occurredAt: Date
  payload: Record<string, unknown>
  attempts: number
}

export type DeliveryOutcome =
  | { status: "delivered"; responseStatus: number }
  /** The endpoint answered, and said no. Retryable. */
  | { status: "failed"; responseStatus?: number; reason: string }

export interface DeliverDeps {
  /** Loads the row, or null if it is gone or already delivered. */
  load: (job: WebhookJob) => Promise<DeliveryRecord | null>
  /** Records success, and clears the endpoint's failure count. */
  markDelivered: (delivery: DeliveryRecord, responseStatus: number) => Promise<void>
  /**
   * Records one failed attempt. `final` means the retry budget is gone, and is
   * what advances the endpoint towards being disabled.
   */
  markFailed: (
    delivery: DeliveryRecord,
    outcome: { reason: string; responseStatus?: number },
    final: boolean,
  ) => Promise<void>
  fetch?: typeof fetch
  log: Logger
  timeoutMs?: number
  maxAttempts: number
}

export async function deliverWebhook(
  job: WebhookJob,
  deps: DeliverDeps,
): Promise<DeliveryOutcome | { status: "skipped" }> {
  const delivery = await deps.load(job)

  // ⚠ NOT AN ERROR. The row is gone (the endpoint was deleted), or another
  // worker already delivered it. Throwing would make groupmq retry a job whose
  // work no longer exists.
  if (!delivery) {
    deps.log.info({ deliveryId: job.deliveryId }, "webhook delivery no longer pending")
    return { status: "skipped" }
  }

  const body = JSON.stringify(
    envelope(delivery.id, {
      type: delivery.eventType,
      occurredAt: delivery.occurredAt,
      data: delivery.payload,
    }),
  )
  const now = new Date()
  const doFetch = deps.fetch ?? fetch

  let outcome: DeliveryOutcome
  try {
    const response = await doFetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "i10-webhooks/1",
        // ⚠ THESE THREE NAMES ARE THE SHIPPED SDK's, NOT OURS TO PICK.
        // `@i10/next`'s createWebhookHandler reads `i10-signature` and
        // `i10-timestamp`; anything else and every customer on the SDK gets a
        // 401 that looks like their own secret being wrong.
        "i10-webhook-id": delivery.id,
        "i10-timestamp": timestampFor(now),
        "i10-signature": signPayload(delivery.secret, body, now),
      },
      body,
      // ⚠ NOT OPTIONAL. See the note at the top of this file: a silent socket
      // is the failure that takes the whole queue down, not a 500.
      signal: AbortSignal.timeout(deps.timeoutMs ?? DELIVERY_TIMEOUT_MS),
      // A customer's 302 to somewhere else is not somewhere we should sign a
      // payload for; refusing redirects keeps the request going only where they
      // registered it.
      redirect: "manual",
    })

    outcome =
      // ⚠ ANY 2xx IS SUCCESS, AND NOTHING ELSE IS. A 3xx is a redirect we
      // refused to follow; a 401 or 404 means their route moved. Treating "the
      // server answered at all" as success would silently drop every event for
      // a mis-configured endpoint.
      response.status >= 200 && response.status < 300
        ? { status: "delivered", responseStatus: response.status }
        : {
            status: "failed",
            responseStatus: response.status,
            reason: `endpoint answered ${response.status}`,
          }
  } catch (err) {
    outcome = { status: "failed", reason: describeError(err) }
  }

  if (outcome.status === "delivered") {
    await deps.markDelivered(delivery, outcome.responseStatus)
    return outcome
  }

  // `attempts` is the count BEFORE this one, so this attempt is `attempts + 1`.
  const final = delivery.attempts + 1 >= deps.maxAttempts
  await deps.markFailed(
    delivery,
    {
      reason: outcome.reason,
      ...(outcome.responseStatus ? { responseStatus: outcome.responseStatus } : {}),
    },
    final,
  )

  deps.log.warn(
    {
      deliveryId: delivery.id,
      endpointId: delivery.endpointId,
      attempt: delivery.attempts + 1,
      status: outcome.responseStatus,
      reason: outcome.reason,
      final,
    },
    "webhook delivery failed",
  )

  // ⚠ THROWN SO groupmq SCHEDULES THE RETRY, BUT ONLY WHILE THERE IS BUDGET.
  // Throwing on the final attempt too would make the job fail loudly for a
  // failure the row has already recorded — and the customer's dead endpoint
  // would fill the failed-job list that a real bug needs to be visible in.
  if (!final) throw new Error(outcome.reason)

  return outcome
}
