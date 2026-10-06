import type { WebhookJob } from "../queue/webhook-queue.js"
import { envelope, type Logger, type WebhookEventType } from "./events.js"
import { describeError } from "../errors.js"
import { timestampFor } from "./signing.js"
import { signWithKeys, type SigningKey } from "./keys.js"
import { pinnedRequest, vetHost, type EgressVerdict } from "./egress.js"
import { applyTransformation, type Transformed, type Transformer } from "./transform.js"
import {
  parseQueueUrl,
  sqsSendMessage,
  type AwsCredentials,
  type QueueAddress,
} from "./sqs.js"
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
  /** Its place in the endpoint's stream; null for rows from before #277. */
  sequence: number | null
  /** When it first failed, if it has. */
  firstFailedAt: Date | null
  /** Which queue it is retried on. */
  lane: DeliveryLane
  /** The endpoint's deliveries-per-second limit, if the customer set one. */
  rateLimit: number | null
  /** The customer's own headers for this endpoint, already checked on write. */
  headers: Record<string, string>
  /** The endpoint's transformation, when it has one switched on (#302). */
  transformation: string | null
  /** What the transformation made of this delivery, once it has run. */
  transformed: Transformed | null
  /**
   * For an SQS destination (#303), the keys to sign `SendMessage` with; `url`
   * is then the queue URL. Null for an HTTP endpoint.
   */
  sqs: AwsCredentials | null
}

export type DeliveryLane = "ordered" | "retry"

export type AttemptTrigger = "scheduled" | "manual" | "recover" | "replay" | "test"
export type AttemptErrorKind =
  "status" | "timeout" | "connect" | "tls" | "blocked" | "unresolved" | "transform"

/** One attempt, as the attempt log keeps it (#280). */
export interface AttemptLog {
  attempt: number
  trigger: AttemptTrigger
  lane: DeliveryLane
  url: string
  /** What we sent. ⚠ Never the signature. */
  requestHeaders: Record<string, string>
  responseStatus?: number
  responseHeaders?: Record<string, string>
  /** The first `RESPONSE_BODY_CAP` bytes of what came back. */
  responseBody?: string
  durationMs: number
  errorKind?: AttemptErrorKind
  error?: string
}

/** How much of an endpoint's answer the attempt log keeps. */
export const RESPONSE_BODY_CAP = 20_000

/**
 * How long a failing event may hold its endpoint's later events before it is
 * moved aside (docs/decisions/webhooks.md, decision 1).
 */
export const HOLD_MS = 5 * 60_000

/** What a failed attempt means for the delivery and for its endpoint. */
export interface FailureDecision {
  /** When the next attempt is owed; null when the budget is spent. */
  nextAttemptAt: Date | null
  /** The lane the next attempt runs on. */
  lane: DeliveryLane
  /**
   * ⚠ HOW THE ENDPOINT MAY BE SWITCHED OFF. `gone`: it answered 410, so at
   * once. Otherwise, when this was the last attempt, only if it has had no
   * success for `disableAfterSeconds` - a stretch of time, not a count.
   */
  disable:
    | { kind: "gone"; reason: string }
    | { kind: "after"; seconds: number }
    /** A replay or a resend: a person asked for one attempt, not a verdict. */
    | { kind: "none" }
}

export type DeliveryOutcome =
  | { status: "delivered"; responseStatus: number }
  /**
   * Not attempted, and not the customer's doing: our transformation sandbox
   * did not answer. The row is released untouched - no attempt recorded, no
   * budget spent, no mark against the endpoint - and tried again at `until`.
   */
  | { status: "deferred"; until: Date }
  /**
   * It did not arrive. `retryAt` is when the next attempt is owed, already
   * written to the row; absent when the budget is spent.
   */
  | {
      status: "failed"
      responseStatus?: number
      reason: string
      retryAt?: Date
      /** Where the retry runs; differs from the delivery's lane when it was just moved aside. */
      lane?: DeliveryLane
      /** The endpoint never answered in time; what the circuit breaker counts. */
      timedOut?: boolean
    }

export interface DeliverDeps {
  /** Loads the row, or null if it is gone or already delivered. */
  load: (job: WebhookJob) => Promise<DeliveryRecord | null>
  /** Records success and its attempt, and ends the endpoint's failing run. */
  markDelivered: (
    delivery: DeliveryRecord,
    responseStatus: number,
    attempt: AttemptLog,
  ) => Promise<void>
  /**
   * Records one failed attempt and what it decided: when the delivery is next
   * owed (or that it is finished), and whether the endpoint is switched off.
   */
  markFailed: (
    delivery: DeliveryRecord,
    outcome: { reason: string; responseStatus?: number },
    decision: FailureDecision,
    attempt: AttemptLog,
  ) => Promise<void>
  /** Retry timing. Production's are in schedule.ts; the lab passes a scaled copy. */
  rules?: RetryRules
  /** How long a failing head may hold its endpoint. Defaults to `HOLD_MS`. */
  holdMs?: number
  /**
   * Waits for the endpoint's turn under its rate limit, after the row is
   * claimed and before anything is signed (so the timestamp is the send's).
   */
  beforeSend?: (delivery: DeliveryRecord) => Promise<void>
  /** Runs an endpoint's transformation in the sandbox (#302). */
  transformer?: Transformer
  /** Fixes what a transformation produced onto the delivery, for every later attempt. */
  saveTransformed?: (delivery: DeliveryRecord, request: Transformed) => Promise<void>
  /** Lets go of a claimed row without recording anything, for a deferral. */
  release?: (delivery: DeliveryRecord) => Promise<void>
  /**
   * Reads an SQS queue URL. Production's accepts only AWS's own SQS hosts;
   * the conformance lab's also accepts its local queue.
   */
  parseQueue?: (url: string) => QueueAddress | { error: string }
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
class EgressRefused extends Error {
  constructor(
    message: string,
    readonly kind: "blocked" | "unresolved",
  ) {
    super(message)
  }
}

/**
 * Reads at most `cap` bytes of a response and drops the rest. A receiver that
 * streams a gigabyte back must not hold the worker or fill the attempt log.
 */
async function readCapped(
  response: Response,
  cap: number,
): Promise<string | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < cap) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch {
    // The deadline fired or the socket closed mid-body; keep what arrived.
  } finally {
    void reader.cancel().catch(() => {})
  }
  const all = new Uint8Array(Math.min(size, cap))
  let at = 0
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, all.length - at))
    all.set(part, at)
    at += part.length
    if (at >= all.length) break
  }
  return new TextDecoder().decode(all)
}

/** The endpoint's own transformation failed, so nothing was sent. */
class TransformFailed extends Error {}

const errorKindOf = (err: unknown): AttemptErrorKind => {
  if (err instanceof EgressRefused) return err.kind
  if (err instanceof TransformFailed) return "transform"
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return "timeout"
  }
  const code = (err as { code?: unknown })?.code
  if (typeof code === "string" && /CERT|TLS|SSL/.test(code)) return "tls"
  return "connect"
}

const MAX_RESPONSE_HEADERS = 50
const headersOf = (h: Headers): Record<string, string> =>
  Object.fromEntries(
    [...h.entries()]
      .slice(0, MAX_RESPONSE_HEADERS)
      .map(([k, v]) => [k, v.slice(0, 1024)]),
  )

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

  const event = envelope(delivery.id, {
    type: delivery.eventType,
    occurredAt: delivery.occurredAt,
    sequence: delivery.sequence,
    data: delivery.payload,
  })

  /*
   * ⚠ TRANSFORMED ONCE, THEN FIXED (#302). The first attempt runs the
   * endpoint's function and stores what it made; every retry and resend sends
   * those same bytes, so a receiver deduplicating on `webhook-id` never sees
   * one id with two bodies - and editing the function later changes what new
   * events become, not what an event already was. A function that fails is
   * not stored, so the next attempt runs the (perhaps fixed) code again.
   */
  let request: Transformed = delivery.transformed ?? {
    method: "POST",
    url: delivery.url,
    headers: delivery.headers,
    body: JSON.stringify(event),
  }
  let transformError: string | undefined
  if (!delivery.transformed && delivery.transformation) {
    const call = deps.transformer
      ? await deps.transformer.run(delivery.transformation, {
          payload: event,
          method: "POST",
          url: delivery.url,
          headers: delivery.headers,
        })
      : ({ status: "unavailable", error: "no transformer configured" } as const)
    if (call.status === "unavailable") {
      // ⚠ OURS, NOT THEIRS. Recording this as a failed attempt would spend the
      // customer's retries and run their endpoint's disable clock on our
      // outage. The row is released untouched and the job tried later.
      deps.log.warn(
        { deliveryId: delivery.id, err: call.error },
        "webhook transformer unavailable; deferring",
      )
      await deps.release?.(delivery)
      return { status: "deferred", until: new Date(Date.now() + 30_000) }
    }
    if (call.status === "error") {
      transformError = `The transformation failed: ${call.error}`
    } else {
      const applied = applyTransformation(delivery.url, call.value)
      if (!applied.ok)
        transformError = `The transformation's result was refused: ${applied.reason}`
      else {
        request = applied.request
        await deps.saveTransformed?.(delivery, request)
      }
    }
  }

  if (deps.beforeSend && !transformError) await deps.beforeSend(delivery)

  const body = request.body
  const now = new Date()
  const doFetch = deps.fetch ?? fetch
  // ⚠ ONE DEADLINE FOR RESOLUTION AND REQUEST TOGETHER. A resolver that never
  // answers is the same silent socket as an endpoint that never answers, and
  // it must not get a budget of its own on top of the request's.
  const signal = AbortSignal.timeout(deps.timeoutMs ?? DELIVERY_TIMEOUT_MS)
  // A transformed request carries a path; it always goes to the endpoint's
  // current origin, which is the one vetted below.
  const url = new URL(request.url, delivery.url)

  // ⚠ AN SQS DESTINATION IS THE SAME DELIVERY WITH A DIFFERENT LAST HOP
  // (#303): the signed envelope becomes a SendMessage, the Standard Webhooks
  // headers become message attributes, and the API call goes to the queue's
  // own SQS host - checked again here, not only on write.
  let target = url
  let sqsError: string | undefined
  const queue = delivery.sqs ? (deps.parseQueue ?? parseQueueUrl)(delivery.url) : null
  if (queue && "error" in queue) sqsError = queue.error
  else if (queue) target = new URL(`${queue.endpoint}/`)

  let outcome: DeliveryOutcome
  // What the endpoint told us about itself, for the retry decision.
  const signals: FailureSignals = {}
  // For the attempt log: what we sent, what came back, and how it failed.
  let sent: Record<string, string> = {}
  let received:
    { status: number; headers: Record<string, string>; body?: string } | undefined
  let errorKind: AttemptErrorKind | undefined
  const startedAt = performance.now()
  try {
    if (transformError) throw new TransformFailed(transformError)
    if (sqsError) throw new EgressRefused(sqsError, "blocked")
    // ⚠ RESOLVED AND VETTED ON EVERY ATTEMPT, THEN CONNECTED TO BY ADDRESS.
    // See egress.ts: the string check at registration cannot see what DNS says
    // today, and connecting by name would resolve a second time.
    const verdict = await (deps.vet ?? ((host, s) => vetHost(host, { signal: s })))(
      target.hostname,
      signal,
    )
    if (!verdict.ok) throw new EgressRefused(verdict.reason, verdict.kind)
    const pinned = pinnedRequest(target, verdict)

    sent = {
      // ⚠ THE CUSTOMER'S HEADERS FIRST, OURS AFTER, so ours win even if the
      // reserved-name check on write were ever bypassed (webhooks/headers.ts).
      ...request.headers,
      host: pinned.host,
      "content-type": "application/json",
      "user-agent": "i10-webhooks/1",
      // ⚠ THESE THREE NAMES ARE THE STANDARD WEBHOOKS SPEC's, NOT OURS TO
      // PICK. They are what lets a customer verify with any conforming
      // library in any language rather than only with `@i10/next` - which is
      // the entire reason the format moved. All three are signed material.
      "webhook-id": delivery.id,
      "webhook-timestamp": timestampFor(now),
    }
    const signature = signWithKeys(delivery.keys, delivery.id, body, now)
    let wire: { method: string; headers: Record<string, string>; body: string } = {
      method: request.method,
      // The signature goes on the request only; the attempt log keeps `sent`.
      headers: { ...sent, "webhook-signature": signature },
      body,
    }
    if (queue && !("error" in queue) && delivery.sqs) {
      const message = await sqsSendMessage({
        queue,
        queueUrl: delivery.url,
        credentials: delivery.sqs,
        body,
        attributes: {
          "webhook-id": delivery.id,
          "webhook-timestamp": sent["webhook-timestamp"]!,
          "webhook-signature": signature,
          "webhook-event-type": delivery.eventType,
        },
        groupId: delivery.endpointId,
        deduplicationId: delivery.id,
        now,
      })
      // What the log keeps of it: the AWS headers but never `authorization`,
      // and the webhook's own headers as the attributes they became.
      sent = {
        ...Object.fromEntries(
          Object.entries(message.headers).filter(([k]) => k !== "authorization"),
        ),
        host: pinned.host,
        "webhook-id": delivery.id,
        "webhook-timestamp": sent["webhook-timestamp"]!,
      }
      wire = {
        method: "POST",
        headers: { ...message.headers, host: pinned.host },
        body: message.body,
      }
    }
    const response = await doFetch(pinned.url, {
      method: wire.method,
      headers: wire.headers,
      body: wire.body,
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
    received = {
      status: response.status,
      headers: headersOf(response.headers),
      // Read inside the same deadline; a body that never ends is cut off.
      body: await readCapped(response, RESPONSE_BODY_CAP),
    }
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
    errorKind = errorKindOf(err)
    outcome = {
      status: "failed",
      // Already a sentence for the customer; describeError would reword it.
      reason:
        err instanceof EgressRefused || err instanceof TransformFailed
          ? err.message
          : describeError(err),
    }
  }

  const made = delivery.attempts + 1
  const log = (lane: DeliveryLane): AttemptLog => ({
    attempt: made,
    trigger: job.trigger ?? "scheduled",
    lane,
    url: delivery.sqs ? delivery.url : url.toString(),
    requestHeaders: sent,
    ...(received
      ? {
          responseStatus: received.status,
          responseHeaders: received.headers,
          ...(received.body !== undefined ? { responseBody: received.body } : {}),
        }
      : {}),
    durationMs: Math.round(performance.now() - startedAt),
    ...(outcome.status === "failed"
      ? { errorKind: errorKind ?? "status", error: outcome.reason.slice(0, 2000) }
      : {}),
  })

  if (outcome.status === "delivered") {
    await deps.markDelivered(delivery, outcome.responseStatus, log(delivery.lane))
    return outcome
  }

  // `attempts` is the count BEFORE this one, so this attempt is `made`.
  const rules = deps.rules ?? RULES
  const policy = rules.policies[delivery.retryPolicy]
  const gone = isPermanentlyGone(signals.status)
  // ⚠ A 410 ENDS THE DELIVERY AND THE ENDPOINT TOGETHER. The receiver said in
  // so many words that it is not coming back; a day of retries would be noise
  // at its door and at ours.
  // ⚠ A RESEND OR A REPLAY IS ONE ATTEMPT (#282), as in Svix. A person asked
  // for it now; if it fails they see the attempt and decide, rather than the
  // delivery quietly retrying for a day - and it is no evidence against the
  // endpoint, so it never counts towards switching it off.
  const asked =
    job.trigger === "manual" || job.trigger === "recover" || job.trigger === "replay"
  const delay =
    gone || asked ? null : nextDelayMs(delivery.retryPolicy, made, signals, rules)
  const nextAttemptAt = delay === null ? null : new Date(Date.now() + delay)

  /*
   * ⚠ ORDERED WHILE HEALTHY, AND ONLY WHILE (decision 1). On the ordered lane a
   * retry keeps its endpoint's later events waiting behind it. Once waiting for
   * the next attempt would hold them past the hold - measured from this
   * delivery's FIRST failure - it moves to the retry lane and they go on. A
   * receiver can still reorder by `sequence`. The move is one-way: an event
   * that has been set aside is not put back in front of ones that went on.
   */
  const failingSince = delivery.firstFailedAt ?? new Date()
  const lane: DeliveryLane =
    delivery.lane === "ordered" &&
    nextAttemptAt !== null &&
    nextAttemptAt.getTime() - failingSince.getTime() > (deps.holdMs ?? HOLD_MS)
      ? "retry"
      : delivery.lane

  await deps.markFailed(
    delivery,
    {
      reason: outcome.reason,
      ...(outcome.responseStatus ? { responseStatus: outcome.responseStatus } : {}),
    },
    {
      nextAttemptAt,
      lane,
      disable: gone
        ? { kind: "gone", reason: "The endpoint answered 410 Gone." }
        : asked
          ? { kind: "none" }
          : { kind: "after", seconds: policy.disableAfterSeconds },
    },
    log(delivery.lane),
  )

  deps.log.warn(
    {
      deliveryId: delivery.id,
      endpointId: delivery.endpointId,
      attempt: made,
      status: outcome.responseStatus,
      reason: outcome.reason,
      final: nextAttemptAt === null,
      lane,
    },
    "webhook delivery failed",
  )

  // ⚠ RETURNED, NOT THROWN. The engine hands `retryAt` to groupmq so the
  // retry stays in its endpoint's group; on the final attempt there is nothing
  // to hand over - the row already says `failed`, and a customer's dead
  // endpoint must not fill the failed-job list a real bug needs.
  const failed = signals.timedOut ? { ...outcome, timedOut: true } : outcome
  return nextAttemptAt ? { ...failed, retryAt: nextAttemptAt, lane } : failed
}
