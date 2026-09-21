import { createHash } from "node:crypto"
import type { SendEmail } from "@repo/contracts"
import type { SendClass, SendJob } from "../queue/send-queue.js"
import { shouldSend, type Metering } from "./metering.js"
import { domainOf } from "./address.js"
import { maySendFrom, scopedDomains } from "../auth/scope.js"

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
   * The key is restricted to other domains than the one it tried to send from.
   *
   * ⚠ IT IS CHECKED HERE RATHER THAN IN THE ROUTES, THOUGH IT IS
   * AUTHORIZATION. There are two send routes and there will be more — a
   * scheduled resend, a broadcast — and a restriction that has to be
   * remembered at each entry point is a restriction that will be missed at one
   * of them. This function is the throat every send passes through, and it
   * already refuses over-quota tenants for the same reason.
   */
  | { status: "forbidden"; message: string }
  /**
   * The `from` domain is not one this tenant has verified.
   *
   * ⚠ NOTHING ENFORCED THIS, AND THE FAILURE IT LEFT WAS THE WORST SHAPE THERE
   * IS: the API answered 200, wrote the message, queued it — and SES refused it
   * at delivery as "an identity that is not verified". The caller got an id and
   * a success, the mail went nowhere, and the only trace was a `failed` row in
   * a log they had no reason to open. Somebody following the onboarding snippet
   * with a domain still waiting on Amazon saw the product work perfectly and
   * deliver nothing.
   *
   * ⚠ IT IS SEPARATE FROM `forbidden` BECAUSE THE REMEDY IS DIFFERENT, and
   * `domain_not_verified` has been sitting unused in `errorNames` since that
   * file was written. `forbidden` means this KEY may not use that domain and
   * the fix is a different key; this means NOBODY may send from it yet and the
   * fix is to finish verifying it. One status for both would tell half the
   * callers to go and look at the wrong thing.
   */
  | { status: "unverified_domain"; message: string }

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
  /**
   * When it is due, parsed once here rather than at each of the three places
   * that need it — the row, the queue delay and the claim.
   *
   * Null means now. A time in the past also means now: the contract says so,
   * and a delayed job whose moment has passed is just a job.
   */
  scheduledAt: Date | null
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
    scheduledAt: scheduleOf(payload),
  }
}

/**
 * The requested send time, or null for now.
 *
 * The contract has already validated the format, so an unparseable value here
 * would be a bug rather than a bad request — and null (send now) is a safer
 * answer to a bug than a crash or a message that silently never goes.
 */
function scheduleOf(payload: SendEmail): Date | null {
  if (!payload.scheduled_at) return null
  const at = new Date(payload.scheduled_at)
  return Number.isNaN(at.getTime()) ? null : at
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
    /**
     * ⚠ NULLABLE, BECAUSE i10'S OWN MAIL HAS NO KEY. Authentication email is
     * sent by the `email.created` webhook rather than by a customer's request —
     * there is no key to attribute it to, and `core.messages.api_key_id` was
     * always nullable for exactly this. Inventing a sentinel uuid would put a
     * row in the message log pointing at a key that does not exist.
     */
    apiKeyId: string | null
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

  /**
   * Which of these domains this tenant may actually send from.
   *
   * ⚠ IT ASKS ABOUT THE REQUEST'S DOMAINS RATHER THAN LISTING THE TENANT'S, the
   * same shape as `suppressedFor` above and for the same reason: a tenant with
   * four hundred domains should not have four hundred rows crossing the wire
   * so that one address can be checked against them.
   *
   * ⚠ AND THE ANSWER IS A SET OF WHAT IS ALLOWED, NOT OF WHAT IS REFUSED, so
   * an adapter that returns nothing fails CLOSED. A port shaped the other way
   * round would turn "the query errored and I returned an empty set" into
   * "everything is permitted", which is the wrong way for this particular
   * question to break.
   */
  sendableFrom: (tenantId: string, domains: string[]) => Promise<Set<string>>

  /**
   * Pushes the batch. Called only after the transaction commits.
   *
   * `runAt` delays the job — see the scheduling note in `acceptSend`.
   */
  enqueue: (queue: SendClass, job: SendJob, opts?: { runAt?: Date }) => Promise<void>
}

export interface Logger {
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/**
 * The first `from` domain this key is not allowed to use, if there is one.
 *
 * ⚠ A MISSING OR UNPARSEABLE `from` IS REFUSED RATHER THAN WAVED THROUGH, but
 * only for a key that is actually restricted. `maySendFrom` answers false for
 * a null domain, which is the right answer: a restricted key that cannot be
 * shown to be within its restriction is outside it.
 */
function refusedDomain(
  scopes: readonly string[],
  payloads: SendEmail[],
): string | null {
  for (const payload of payloads) {
    const domain = domainOf(payload.from)
    if (!maySendFrom(scopes, domain)) return domain ?? payload.from
  }
  return null
}

export async function acceptSend(
  input: {
    tenantId: string
    /** Null for i10's own mail — see `AcceptOps.persist`. */
    apiKeyId: string | null
    /**
     * What the presenting key is allowed to send from.
     *
     * ⚠ OPTIONAL, AND ABSENT MEANS UNRESTRICTED. i10's own mail has no key at
     * all, and a caller that has not been taught about scopes must not be
     * silently prevented from sending — the failure mode of getting this
     * backwards is every message in the product refused at once.
     */
    scopes?: readonly string[]
    payloads: SendEmail[]
    endpoint: "single" | "batch"
    idempotencyKey?: string
  },
  deps: AcceptOps & { metering: Metering; log: Logger },
): Promise<AcceptOutcome> {
  const queue = classFor(input.endpoint)

  /*
   * ⚠ BEFORE THE QUOTA CHECK AND BEFORE ANYTHING IS WRITTEN. A refusal that
   * has already spent a quota unit, or already persisted a message, is a
   * refusal that cost the customer something — and on a batch it would leave
   * some elements written and some not.
   *
   * ⚠ AND EVERY PAYLOAD IS CHECKED, NOT THE FIRST. A batch is one request with
   * many `from` addresses; a key scoped to acme.com sending forty-nine
   * legitimate messages and one from the production domain is exactly the case
   * this exists to stop, and it is the one a first-element check misses.
   */
  const refused = input.scopes ? refusedDomain(input.scopes, input.payloads) : null
  if (refused) {
    return {
      status: "forbidden",
      message:
        `This key can only send from ${scopedDomains(input.scopes ?? []).join(", ")}. ` +
        `It cannot send from ${refused}.`,
    }
  }

  /*
   * ⚠ AFTER THE SCOPE CHECK AND BEFORE EVERYTHING ELSE, because it costs a
   * query and the scope check does not. A key that may not touch this domain
   * at all should be refused without asking the database whether the domain is
   * verified — the answer would not change the outcome.
   *
   * ⚠ AND IT IS THE SAME PLACE FOR THE SAME REASON AS THE SCOPE CHECK: this
   * function is the throat every send passes through. There are two send routes
   * today and there will be more, and a gate that has to be remembered at each
   * entry point is a gate that will be missed at one of them.
   *
   * ⚠ A `from` WITH NO PARSEABLE DOMAIN IS REFUSED HERE RATHER THAN WAVED
   * THROUGH. It cannot be verified, by definition, and the alternative is
   * accepting a message that SES will reject for a different reason later.
   */
  const wanted = [
    ...new Set(input.payloads.map((p) => domainOf(p.from)?.toLowerCase() ?? "")),
  ]
  const sendable = await deps.sendableFrom(
    input.tenantId,
    wanted.filter((d) => d !== ""),
  )

  const unverified = wanted.find((domain) => !sendable.has(domain))
  if (unverified !== undefined) {
    return {
      status: "unverified_domain",
      message:
        unverified === ""
          ? "The `from` address has no domain we can check. Use an address on a domain you have verified."
          : `${unverified} is not verified for this workspace, so mail cannot be sent from it yet. ` +
            `Add it under Domains, publish the records, and verify it first.`,
    }
  }

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
  //
  // ⚠ AND ONE JOB PER DUE TIME, NOT ONE JOB PER REQUEST. A job carries a single
  // delay, so a batch whose elements are scheduled differently cannot be one
  // job — the earliest due time would drag the rest forward, or the latest
  // would hold the rest back. Partitioning is what keeps `scheduled_at` a
  // per-message promise rather than a per-request one.
  for (const [dueAt, refs] of byDueTime(written.refs, messages)) {
    try {
      // ⚠ THE DELAY IS THE OPTIMISATION; THE DATABASE IS THE GUARANTEE. Redis
      // holding a job back is what keeps a scheduled message off the worker
      // until it is due, but the claim ALSO refuses a row whose `scheduled_at`
      // is in the future — so a promoted-early job, or a sweep that re-enqueues
      // one, still cannot send it ahead of time.
      const job = { tenantId: input.tenantId, messages: refs }
      if (dueAt !== null && dueAt > Date.now()) {
        await deps.enqueue(queue, job, { runAt: new Date(dueAt) })
      } else {
        await deps.enqueue(queue, job)
      }
    } catch (err) {
      // The rows are committed. The stale-claim sweep will find them, so this
      // is late rather than lost — and reporting a failure would make an SDK
      // retry and send everything twice.
      deps.log.error(
        { err, tenantId: input.tenantId, count: refs.length, dueAt },
        "enqueue failed after commit — the sweep will pick these up",
      )
    }
  }

  return { status: "accepted", ids: written.ids }
}

/**
 * Groups the written refs by when they are due, dropping the ones with nothing
 * left to send to.
 *
 * The key is `null` for "now" and a millisecond timestamp otherwise, so two
 * messages asking for the same moment share one job and one delay.
 */
function byDueTime(
  refs: SendJob["messages"],
  messages: readonly PreparedMessage[],
): Map<number | null, SendJob["messages"]> {
  const groups = new Map<number | null, SendJob["messages"]>()

  refs.forEach((ref, i) => {
    const message = messages[i]!
    if (message.to.length === 0) return
    const key = message.scheduledAt ? message.scheduledAt.getTime() : null
    const group = groups.get(key)
    if (group) group.push(ref)
    else groups.set(key, [ref])
  })

  return groups
}
