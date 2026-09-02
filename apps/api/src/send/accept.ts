import { createHash } from "node:crypto"
import type { SendEmail } from "@repo/contracts"
import type { SendClass, SendJob } from "../queue/send-queue.js"
import { shouldSend, type Metering } from "./metering.js"

/**
 * Accepting a send.
 *
 * `POST /emails` returns an id synchronously, and that id has to be real before
 * the response is written — it is what the caller stores, logs and later asks
 * about. So the order is fixed:
 *
 *   1. QUOTA     cheap, cached, before anything is written.
 *   2. PERSIST   messages and bodies, in one transaction with the idempotency
 *                key, so a crash leaves either all of it or none.
 *   3. ENQUEUE   after the commit. Never inside it.
 *
 * ⚠ ENQUEUE AFTER COMMIT, NEVER BEFORE OR WITHIN. A job whose rows are not
 * committed yet finds nothing to claim and is dropped, and the message is then
 * lost with no error anywhere. Committing first means the worst case is a
 * committed row that no job points at — which the stale-claim sweep picks up.
 * Late is recoverable; lost is not.
 *
 * ⚠ AND A FAILED ENQUEUE IS NOT A FAILED REQUEST. The rows exist and the sweep
 * will find them, so returning 500 would tell the caller nothing was accepted
 * while the mail goes out anyway — and an SDK that retries on 500 would then
 * send it twice.
 */

export type AcceptOutcome =
  | { status: "accepted"; ids: string[] }
  /** The same key and the same body. Returns the FIRST ids, sends nothing. */
  | { status: "replayed"; ids: string[] }
  /**
   * The same key with a different body. ⚠ A 409, never a silent replay and
   * never a second send: both would be wrong, and which one the caller wanted
   * is unknowable. Their key is ambiguous and only they can resolve it.
   */
  | { status: "conflict"; message: string }
  | { status: "quota_exceeded"; message: string }

/**
 * A stable fingerprint of the request body.
 *
 * ⚠ IT IS WHAT MAKES `Idempotency-Key` SAFE RATHER THAN DANGEROUS. Without it,
 * a client that reuses a key for a different email — a loop with a fixed key, a
 * copy-pasted example — silently gets the first message's id back and the
 * second email is never sent. With it, that is a 409 they can see.
 *
 * ⚠ KEY ORDER MUST NOT MATTER. `JSON.stringify` preserves insertion order, so
 * two identical payloads serialised by different SDK versions would hash
 * differently and a legitimate retry would look like a conflict. Sorting makes
 * the hash a property of the content.
 */
export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex")
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
  return `{${entries.join(",")}}`
}

/** One message as it will be written, after suppression filtering. */
export interface PreparedMessage {
  payload: SendEmail
  /** Recipients that survived the suppression list. */
  to: string[]
  cc: string[]
  bcc: string[]
}

/**
 * Removes suppressed recipients.
 *
 * ⚠ BEFORE THE SEND, NOT AFTER THE BOUNCE. A suppression exists because an
 * address hard-bounced, complained, or unsubscribed — sending to it again costs
 * reputation that is shared by every tenant on the same SES account, so one
 * customer ignoring their list degrades deliverability for all of them.
 *
 * ⚠ AND A MESSAGE WITH NO SURVIVING `to` IS NOT AN ERROR. The caller did
 * nothing wrong; the address is simply unreachable and they were told so when
 * it bounced. It is accepted, recorded, and never queued — so the dashboard
 * shows what happened, which "422 invalid recipient" would not.
 */
export function withoutSuppressed(
  payload: SendEmail,
  suppressed: ReadonlySet<string>,
): PreparedMessage {
  const keep = (list: readonly string[] | undefined) =>
    (list ?? []).filter((a) => !suppressed.has(addrSpec(a)))

  return {
    payload,
    to: keep(asList(payload.to)),
    cc: keep(asList(payload.cc)),
    bcc: keep(asList(payload.bcc)),
  }
}

/**
 * The bare address out of `Name <addr@example.com>`, lowercased.
 *
 * ⚠ SUPPRESSION IS COMPARED ON THIS, NOT ON THE RAW STRING. `to` accepts a
 * display name, so a hard-bounced address that has been suppressed would
 * otherwise become sendable again simply by writing `Bob <bob@x.com>` — a
 * bypass that costs shared SES reputation and that nobody would ever notice,
 * because the send succeeds.
 *
 * Deliberately not a full RFC 5322 parser: it is one angle-bracket pair or the
 * whole string, which covers every form the contract's own validation admits.
 */
export function addrSpec(address: string): string {
  const angled = /<([^>]*)>/.exec(address)
  return (angled?.[1] ?? address).trim().toLowerCase()
}

/** The contract allows a single address or a list; downstream wants a list. */
export function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * ⚠ THE CLASS DECIDES WHICH QUEUE, AND THE TWO NEVER SHARE ONE. `POST /emails`
 * is a single message somebody is probably waiting for — a password reset, a
 * receipt — so it is transactional. `POST /emails/batch` is by definition not
 * that. Routing them together would let a thousand-message batch queue in front
 * of a reset, which is the failure the split exists to prevent.
 */
export const classFor = (endpoint: "single" | "batch"): SendClass =>
  endpoint === "single" ? "transactional" : "bulk"

/** The persistence the accept path needs, injected so it can be tested. */
export interface AcceptOps {
  /**
   * Writes the messages, their bodies and the idempotency row in ONE
   * transaction, and returns the ids in the order given.
   *
   * Returns `replayed` when the key has been seen with the same request hash,
   * and `conflict` when it has been seen with a different one. Both decisions
   * belong inside the transaction — made outside, two concurrent replays of the
   * same key would both miss and both insert.
   */
  persist: (input: {
    tenantId: string
    apiKeyId: string
    queue: SendClass
    messages: PreparedMessage[]
    idempotencyKey?: string
    requestHash: string
  }) => Promise<
    | { status: "written"; refs: SendJob["messages"]; ids: string[] }
    | { status: "replayed"; ids: string[] }
    | { status: "conflict" }
  >

  /**
   * Addresses this tenant may not send to, in `addrSpec()` form — bare and
   * lowercased, because that is what `withoutSuppressed` compares against.
   */
  suppressedFor: (tenantId: string, addresses: string[]) => Promise<Set<string>>

  /** Pushes the batch. Called only after the transaction commits. */
  enqueue: (queue: SendClass, job: SendJob) => Promise<void>
}

export interface Logger {
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export async function acceptSend(
  input: {
    tenantId: string
    apiKeyId: string
    payloads: SendEmail[]
    endpoint: "single" | "batch"
    idempotencyKey?: string
  },
  deps: AcceptOps & { metering: Metering; log: Logger },
): Promise<AcceptOutcome> {
  const queue = classFor(input.endpoint)

  // ⚠ FIRST, AND CHEAPLY. Rejecting an over-quota tenant before writing
  // anything is the difference between a 429 in milliseconds and a database
  // full of messages that will never be allowed to send.
  const quota = await deps.metering.checkQuota(input.tenantId, input.payloads.length)
  if (!shouldSend(quota)) {
    return {
      status: "quota_exceeded",
      message: quota.status === "exceeded" ? quota.message : "Sending quota exceeded.",
    }
  }

  const everyAddress = input.payloads.flatMap((p) => [
    ...asList(p.to),
    ...asList(p.cc),
    ...asList(p.bcc),
  ])
  const suppressed = await deps.suppressedFor(input.tenantId, everyAddress)
  const messages = input.payloads.map((p) => withoutSuppressed(p, suppressed))

  const written = await deps.persist({
    tenantId: input.tenantId,
    apiKeyId: input.apiKeyId,
    queue,
    messages,
    idempotencyKey: input.idempotencyKey,
    requestHash: hashRequest(input.payloads),
  })

  if (written.status === "conflict") {
    return {
      status: "conflict",
      message:
        "This Idempotency-Key was already used with a different request body. " +
        "Use a new key, or resend the original body.",
    }
  }
  // ⚠ A REPLAY ENQUEUES NOTHING. The first request already did; queueing again
  // would be a second job for messages that may already have been sent, and the
  // claim would be the only thing standing between that and a duplicate.
  if (written.status === "replayed") {
    return { status: "replayed", ids: written.ids }
  }

  // ⚠ ONLY MESSAGES WITH A SURVIVING RECIPIENT ARE QUEUED. The rest are
  // recorded so the dashboard can explain them, and never sent.
  const sendable = written.refs.filter((_, i) => messages[i]!.to.length > 0)

  if (sendable.length > 0) {
    try {
      await deps.enqueue(queue, { tenantId: input.tenantId, messages: sendable })
    } catch (err) {
      // The rows are committed. The stale-claim sweep will find them, so this
      // is late rather than lost — and reporting a failure would make an SDK
      // retry and send everything twice.
      deps.log.error(
        { err, tenantId: input.tenantId, count: sendable.length },
        "enqueue failed after commit — the sweep will pick these up",
      )
    }
  }

  return { status: "accepted", ids: written.ids }
}
