import type { WebhookJob } from "../queue/webhook-queue.js"
import { envelope, type Logger, type WebhookEventType } from "./events.js"
import { describeError } from "../errors.js"
import { timestampFor } from "./signing.js"
import { signWithKeys, type SigningKey } from "./keys.js"
import { pinnedRequest, vetHost, type EgressVerdict } from "./egress.js"
import {
  isPermanentlyGone,
  nextDelayMs,
  RULES,
  type FailureSignals,
  type RetryPolicy,
  type RetryRules,
} from "./schedule.js"

/**
 * Delivering one webhook.
 *
 * ⚠ AT LEAST ONCE, AND SAID OUT LOUD IN THE DOCS RATHER THAN HOPED AWAY. A
 * receiver that commits its work and then times out on the response is
 * indistinguishable from one that never received the request, so we send again.
 * The delivery id is stable across attempts precisely so the customer can make
 * their handler idempotent - it is the only thing that lets them.
 *
 * ⚠ AND A DELIVERY MUST NEVER BE ABLE TO HANG A WORKER. A customer's endpoint
 * is code we do not control, on infrastructure we do not control, and the
 * failure that matters is not an error - it is a socket that accepts the
 * connection and then says nothing. Without a hard timeout, one such endpoint
 * occupies a worker slot until the job lease expires, and a handful of them
 * stop every other customer's webhooks.
 */

/** How long a customer's endpoint has to answer. */
export const DELIVERY_TIMEOUT_MS = 10_000

export interface DeliveryRecord {
  id: string
  tenantId: string
  endpointId: string
  url: string
  /**
   * Every key that signs this attempt: the current one first, then any the
   * customer chose to keep through a rotation. Decrypted at read time by the
   * adapter; never logged.
   */
  keys: SigningKey[]
  eventType: WebhookEventType
  occurredAt: Date
  payload: Record<string, unknown>
  attempts: number
  /** Fixed when the event happened; decides the retry window. */
  retryPolicy: RetryPolicy
}

/** What a failed attempt means for the delivery and for its endpoint. */
export interface FailureDecision {
  /** When the next attempt is owed; null when the budget is spent. */
  nextAttemptAt: Date | null
  /**
   * ⚠ HOW THE ENDPOINT MAY BE SWITCHED OFF. `gone`: it answered 410, so at
   * once. Otherwise, when this was the last attempt, only if it has had no
   * success for `disableAfterSeconds` - a stretch of time, not a count.
   */
  disable: { kind: "gone"; reason: string } | { kind: "after"; seconds: number }
}

export type DeliveryOutcome =
  | { status: "delivered"; responseStatus: number }
  /**
   * It did not arrive. `retryAt` is when the next attempt is owed, already
   * written to the row; absent when the budget is spent.
   */
  | { status: "failed"; responseStatus?: number; reason: string; retryAt?: Date }

export interface DeliverDeps {
  /** Loads the row, or null if it is gone or already delivered. */
  load: (job: WebhookJob) => Promise<DeliveryRecord | null>
  /** Records success, and clears the endpoint's failure count. */
  markDelivered: (delivery: DeliveryRecord, responseStatus: number) => Promise<void>
  /**
   * Records one failed attempt and what it decided: when the delivery is next
   * owed (or that it is finished), and whether the endpoint is switched off.
   */
  markFailed: (
    delivery: DeliveryRecord,
    outcome: { reason: string; responseStatus?: number },
    decision: FailureDecision,
  ) => Promise<void>
  /** Retry timing. Production's are in schedule.ts; the lab passes a scaled copy. */
  rules?: RetryRules
  fetch?: typeof fetch
  /**
   * Decides where a hostname may be connected to. Defaults to the system
   * resolver with nothing allow-listed.
   *
   * ⚠ THE DEFAULT IS THE SAFE ONE ON PURPOSE. A caller that forgets to pass
   * this gets full vetting, not none; only a test or the conformance lab has
   * reason to replace it.
   */
  vet?: (host: string, signal: AbortSignal) => Promise<EgressVerdict>
  log: Logger
  timeoutMs?: number
}

/**
 * The endpoint resolved somewhere we will not connect to, or did not resolve.
 * An ordinary failed attempt as far as retries go: DNS can be fixed.
 */
class EgressRefused extends Error {}

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
  // ⚠ ONE DEADLINE FOR RESOLUTION AND REQUEST TOGETHER. A resolver that never
  // answers is the same silent socket as an endpoint that never answers, and
  // it must not get a budget of its own on top of the request's.
  const signal = AbortSignal.timeout(deps.timeoutMs ?? DELIVERY_TIMEOUT_MS)
  const url = new URL(delivery.url)

  let outcome: DeliveryOutcome
  // What the endpoint told us about itself, for the retry decision.
  const signals: FailureSignals = {}
  try {
    // ⚠ RESOLVED AND VETTED ON EVERY ATTEMPT, THEN CONNECTED TO BY ADDRESS.
    // See egress.ts: the string check at registration cannot see what DNS says
    // today, and connecting by name would resolve a second time.
    const verdict = await (deps.vet ?? ((host, s) => vetHost(host, { signal: s })))(
      url.hostname,
      signal,
    )
    if (!verdict.ok) throw new EgressRefused(verdict.reason)
    const pinned = pinnedRequest(url, verdict)

    const response = await doFetch(pinned.url, {
      method: "POST",
      headers: {
        host: pinned.host,
        "content-type": "application/json",
        "user-agent": "i10-webhooks/1",
        // ⚠ THESE THREE NAMES ARE THE STANDARD WEBHOOKS SPEC's, NOT OURS TO
        // PICK. They are what lets a customer verify with any conforming
        // library in any language rather than only with `@i10/next` - which is
        // the entire reason the format moved. All three are signed material.
        "webhook-id": delivery.id,
        "webhook-timestamp": timestampFor(now),
        "webhook-signature": signWithKeys(delivery.keys, delivery.id, body, now),
      },
      body,
      // ⚠ NOT OPTIONAL. See the note at the top of this file: a silent socket
      // is the failure that takes the whole queue down, not a 500.
      signal,
      // A customer's 302 to somewhere else is not somewhere we should sign a
      // payload for; refusing redirects keeps the request going only where they
      // registered it.
      redirect: "manual",
      // The certificate is checked against the customer's hostname, not the
      // address we connected to - which is what makes the pin safe for TLS.
      ...(pinned.serverName ? { tls: { serverName: pinned.serverName } } : {}),
    })

    signals.status = response.status
    signals.retryAfter = response.headers.get("retry-after")
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
    signals.timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    outcome = {
      status: "failed",
      // Already a sentence for the customer; describeError would reword it.
      reason: err instanceof EgressRefused ? err.message : describeError(err),
    }
  }

  if (outcome.status === "delivered") {
    await deps.markDelivered(delivery, outcome.responseStatus)
    return outcome
  }

  // `attempts` is the count BEFORE this one, so this attempt is `attempts + 1`.
  const made = delivery.attempts + 1
  const rules = deps.rules ?? RULES
  const policy = rules.policies[delivery.retryPolicy]
  const gone = isPermanentlyGone(signals.status)
  // ⚠ A 410 ENDS THE DELIVERY AND THE ENDPOINT TOGETHER. The receiver said in
  // so many words that it is not coming back; a day of retries would be noise
  // at its door and at ours.
  const delay = gone ? null : nextDelayMs(delivery.retryPolicy, made, signals, rules)
  const nextAttemptAt = delay === null ? null : new Date(Date.now() + delay)
  await deps.markFailed(
    delivery,
    {
      reason: outcome.reason,
      ...(outcome.responseStatus ? { responseStatus: outcome.responseStatus } : {}),
    },
    {
      nextAttemptAt,
      disable: gone
        ? { kind: "gone", reason: "The endpoint answered 410 Gone." }
        : { kind: "after", seconds: policy.disableAfterSeconds },
    },
  )

  deps.log.warn(
    {
      deliveryId: delivery.id,
      endpointId: delivery.endpointId,
      attempt: made,
      status: outcome.responseStatus,
      reason: outcome.reason,
      final: nextAttemptAt === null,
    },
    "webhook delivery failed",
  )

  // ⚠ RETURNED, NOT THROWN. The engine hands `retryAt` to groupmq so the
  // retry stays in its endpoint's group; on the final attempt there is nothing
  // to hand over - the row already says `failed`, and a customer's dead
  // endpoint must not fill the failed-job list a real bug needs.
  return nextAttemptAt ? { ...outcome, retryAt: nextAttemptAt } : outcome
}
