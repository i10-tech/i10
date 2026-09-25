import type { RawMessage } from "@upyo/core"
import type { SmtpReceipt, SmtpRejectedRecipient } from "@upyo/smtp"
import { describeError } from "../errors.js"
import { addressOf, domainOf } from "./address.js"
import { signMessage } from "./dkim.js"
import { buildRawMessage } from "./mime.js"
import type { DomainSending } from "./signing-key.js"
import {
  messageIdHeader,
  type OutboundMessage,
  type SendOutcome,
  type Transport,
} from "./transport.js"

/**
 * Our own MTA as the relay.
 *
 * ⚠ HAND-OFF, NOT DELIVERY. This hands a finished message to Stalwart's
 * internal `relay` listener over SMTP and stops there. Stalwart owns the queue, the retries, the MX lookups
 * and the DSN generation from that point — all of which it already does
 * properly, and none of which is worth rebuilding inside a worker. The same
 * argument in reverse is why mailbox mail does not go out through the SES API:
 * see docs/decisions/mail-routing.md.
 *
 * ⚠ THE MESSAGE IS BUILT BY `buildRawMessage`, THE SAME FUNCTION THE SES ROUTE
 * USES. A per-domain route lever is only honest if the route is invisible in
 * what arrives, so both paths compose identical bytes and differ only in who
 * carries them and who signs them.
 *
 * ⚠ THE CLIENT IS upyo'S AS OF 2026-09-17, AND `sendRaw` IS WHY IT CAN BE. Its
 * contract is "deliver these serialized bytes unchanged, apart from SMTP
 * dot-stuffing" — documented, not inferred — which is exactly what this
 * transport needs and what stops a second library composing MIME behind our
 * back. upyo's own `dkim` config is deliberately NOT set: `sendRaw` bypasses it
 * by design, and the signature is already on the bytes by the time they get
 * here.
 */

/**
 * The relay client, narrowed to the one method this uses.
 *
 * ⚠ STRUCTURAL RATHER THAN `SmtpTransport`, SO A TEST CAN BE A LITERAL. The
 * concrete class opens sockets in its constructor's shadow and owns a pool;
 * depending on the shape instead keeps every test in this file synchronous and
 * offline, which is what makes the failure cases above testable at all.
 */
export interface RawMailer {
  sendRaw(message: RawMessage): Promise<SmtpReceipt>
}

export interface StalwartTransportOptions {
  /** A client pointed at Stalwart's `relay` listener. */
  mailer: RawMailer
  /**
   * The domain's signing key and published return path, or null if it has none.
   *
   * ⚠ A LOOKUP RATHER THAN A FIELD ON THE MESSAGE, SO THE PRIVATE KEY NEVER
   * RIDES THROUGH THE BATCH. `OutboundMessage` crosses the transport boundary
   * and is logged, counted and held in memory for the width of a batch; an
   * unsealed signing key on it would be one careless `log.debug` away from
   * every customer's key in a log aggregator. The transport asks for the one
   * key it needs, at the moment it needs it.
   *
   * ⚠ AND IT RETURNS THE BOUNCE LABEL FROM THE SAME ROW. The two are read
   * together because they must agree: a message signed as one domain and
   * bounced to a label nobody published is a message with no working return
   * path, which is worse than one with no signature.
   */
  domainSending: (domain: string, tenantId: string) => Promise<DomainSending | null>
  /**
   * Called when the server took the message but refused some of its recipients.
   *
   * ⚠ THIS INFORMATION DID NOT EXIST BEFORE upyo AND DISCARDING IT WOULD BE THE
   * WORST OF THE THREE OPTIONS. SMTP can accept a `DATA` after rejecting
   * individual `RCPT TO`s, so a message to five people can be delivered to four
   * with a `250` on the transaction. `SendOutcome` has no shape for "mostly
   * sent" — and inventing one would ripple through the claim, the metering and
   * the reconcilers for a case that is already rare — so the outcome stays
   * `sent` and this is how the missing recipients become visible.
   *
   * ⚠ AN INJECTED EFFECT, NOT A LOGGER FIELD, WHICH KEEPS THIS TRANSPORT PURE
   * THE WAY `sesTransport` IS. Optional because the tests do not want one.
   */
  onRejectedRecipients?: (event: {
    messageId: string
    tenantId: string
    recipients: readonly SmtpRejectedRecipient[]
  }) => void
}

export function stalwartTransport(opts: StalwartTransportOptions): Transport {
  return {
    async send(message: OutboundMessage): Promise<SendOutcome> {
      const domain = domainOf(message.from)
      if (!domain) {
        return { status: "rejected", reason: `no domain in From: ${message.from}` }
      }

      // ⚠ THE LOOKUP GETS ITS OWN try, AND CONFLATING IT WITH SIGNING COST REAL
      // MAIL. `domainSending` is a database round trip, so it fails for reasons
      // that say nothing about the message — a reset connection, a statement
      // timeout, a failover. Sharing a catch with `signMessage` classified every
      // one of those as `rejected`, which `handleBatch` treats as permanent: the
      // row went to `failed` and a message that a retry seconds later would have
      // delivered was destroyed instead.
      let sending: DomainSending | null
      try {
        sending = await opts.domainSending(domain, message.tenantId)
      } catch (err) {
        return { status: "deferred", reason: describeError(err) }
      }

      // ⚠ REFUSED, NOT SENT UNSIGNED. A message we carry ourselves has no other
      // aligned authentication to fall back on if SPF is broken by a forwarder,
      // and sending it anyway would put the failure in the recipient's spam
      // folder rather than in our own error count. A domain with no key is a
      // provisioning bug, and this is where it becomes visible.
      //
      // ⚠ AND THIS IS `rejected` WHILE THE THROW ABOVE IS `deferred`, WHICH IS
      // THE WHOLE DISTINCTION. A missing key reproduces exactly on every retry;
      // a failed query does not.
      if (!sending) {
        return { status: "rejected", reason: `no DKIM key for ${domain}` }
      }

      let raw: string
      try {
        const unsigned = buildRawMessage(message, message.attachments ?? [])
        raw = await signMessage(unsigned, domain, sending.dkim)
      } catch (err) {
        // Building or signing failing is ours, not the network's, and retrying
        // it reproduces it exactly — so it is permanent rather than deferred.
        //
        // ⚠ AND upyo THROWING HERE IS THE POINT. An unusable key now raises
        // `Failed to import private key` instead of quietly handing back an
        // unsigned message, so this catch is what turns a provisioning fault
        // into a visible rejection rather than mail that fails DMARC silently.
        return { status: "rejected", reason: describeError(err) }
      }

      // ⚠ THE ENVELOPE TAKES BARE ADDRESSES, AND THE HEADERS DO NOT. A
      // recipient may arrive as `Bob <bob@x.test>`; that is what `To:` should
      // show and it is NOT an SMTP address — `RCPT TO` would read the local part
      // as `Bob <bob`, which is invalid. The previous client unwrapped this
      // silently, so every send with a display name in `to` depended on it.
      //
      // ⚠ AND AN UNPARSEABLE RECIPIENT STOPS THE SEND RATHER THAN BEING DROPPED
      // FROM THE ENVELOPE. Filtering it out would deliver the message to
      // everyone else and report `sent`, with one recipient silently missing and
      // nothing anywhere saying so.
      const recipients: `${string}@${string}`[] = []
      for (const recipient of [...message.to, ...message.cc, ...message.bcc]) {
        const address = addressOf(recipient)
        if (!address) {
          return { status: "rejected", reason: `unparseable recipient: ${recipient}` }
        }
        recipients.push(address)
      }

      let receipt: SmtpReceipt
      try {
        receipt = await opts.mailer.sendRaw({
          envelope: {
            // ⚠ VERP, AND THE CUSTOMER'S OWN DOMAIN. The label is theirs and is
            // published with an MX and an SPF TXT (see domains/records.ts), so
            // SPF aligns with the `From:` and a DSN has somewhere to land. The
            // message id in the local part is what makes that DSN attributable
            // without searching `Message-ID` headers an intermediate MTA is
            // free to rewrite.
            from: `bounce+${message.id}@${sending.bounceSubdomain}.${domain}`,
            // ⚠ EVERY RECIPIENT, INCLUDING BCC, AND THIS IS WHAT KEEPS BCC
            // BLIND. `buildRawMessage` deliberately writes no `Bcc:` header, so
            // the envelope is the only thing that says who receives it — the
            // same split SES makes with `Destination`.
            to: recipients,
          },
          // ⚠ BYTES, NOT A STRING, BECAUSE THE WIRE IS BYTES. `buildRawMessage`
          // returns a JavaScript string, which is UTF-16 in memory; encoding it
          // here is the one place the message becomes the thing that will
          // actually be transmitted, and it is the same encoding the signature
          // was computed over.
          content: new TextEncoder().encode(raw),
          // ⚠ `encoding` IS LEFT UNSET ON PURPOSE, WHICH COSTS A SECOND PASS AND
          // BUYS A VALIDATOR. Naming it would let upyo skip straight to
          // transmission; omitting it makes upyo read the buffer once to
          // classify it, and that pass is what enforces CRLF endings, the
          // 998-octet line limit and the absence of NUL. The buffer is already
          // in memory, so the second read is arithmetic, and it is the only
          // thing standing between a malformed message and a receiver that
          // interprets it however it likes. It is how the unfolded 16 KB `To:`
          // header and the raw UTF-8 attachment filename in send/mime.ts were
          // found.
        })
      } catch (err) {
        // ⚠ `sendRaw` RETURNS FAILURES RATHER THAN THROWING THEM, so reaching
        // this catch means something outside the SMTP conversation went wrong —
        // in practice an abort. Nothing about the message, so: temporary.
        return { status: "deferred", reason: describeError(err) }
      }

      if (!receipt.successful) return classify(receipt)

      if (receipt.rejectedRecipients.length > 0) {
        opts.onRejectedRecipients?.({
          messageId: message.id,
          tenantId: message.tenantId,
          recipients: receipt.rejectedRecipients,
        })
      }

      // ⚠ OUR OWN Message-ID, NOT `receipt.messageId` — BECAUSE ON THIS ROUTE
      // THAT FIELD IS SYNTHETIC.
      //
      // Stalwart answers `250 2.0.0 Message queued for delivery.`, with no queue
      // identifier — unlike Postfix's `queued as ABC123`. upyo looks for one
      // with `/(?:Message-ID:|id=)[\s<]*([^>\s]+)/`, finds nothing, and falls
      // back to `smtp-${Date.now()}-${random}`. Storing that would refill
      // `core.messages.provider_message_id` with values that look like ids and
      // resolve nowhere — which is the exact bug this column already had once,
      // when it held nodemailer's client-side UUID.
      //
      // What DOES identify the message is the header we wrote ourselves.
      // `mime.ts` emits `messageIdHeader(id, from)`, it reaches the wire
      // unmodified (measured — SES overwrites it, Stalwart does not), it is
      // covered by the DKIM signature, and it is the value that appears in
      // Stalwart's logs and in any DSN a receiving server generates. So on
      // this route the column means "the id this message travels under",
      // which is the same question it answers for SES.
      //
      // ⚠ IT IS DERIVABLE FROM `messages.id`, AND IS STILL STORED. Recomputing
      // it at read time would mean every reader knowing the derivation and
      // re-deriving it identically — including the display-name unwrapping
      // that has been wrong once already. One column, written once, by the
      // same function that wrote the header.
      const id = messageIdHeader(message.id, message.from)

      // Mirrors sesTransport: an acceptance we cannot name is not something to
      // record as sent, because nothing could later be joined to it. Here that
      // is near-unreachable — the id is derived rather than returned — but the
      // guard costs nothing and keeps the two transports the same shape.
      if (!id) {
        return { status: "deferred", reason: "relay returned no message id" }
      }
      return { status: "sent", providerMessageId: id }
    },
  }
}

/**
 * ⚠ SMTP'S REPLY CODE IS THE WHOLE OF THE PERMANENT/TEMPORARY DECISION, AND IT
 * IS THE ONE PLACE THIS TRANSPORT MUST NOT GUESS. 5xx means the message will
 * never be accepted and retrying spends the attempt budget to reach the same
 * answer; 4xx means not now. Collapsing them costs real mail in both
 * directions — the same split `sesTransport.classify` makes for a different
 * provider's vocabulary.
 *
 * ⚠ AND WE DO NOT TRUST `receipt.retryable`, WHICH IS THE IMPORTANT PART. upyo
 * sets it from a structured classification when it recognises the failure and
 * from SUBSTRING MATCHING ON THE ERROR TEXT when it does not — and that fallback
 * ends `{ category: "unknown", retryable: false }`. Taken at face value, a TLS
 * handshake failure ("unable to verify the first certificate" matches nothing)
 * would be permanent, and every message in the queue would be destroyed by a
 * certificate that expired an hour ago. Our rule is the opposite and always has
 * been: an error we cannot read is temporary.
 *
 * ⚠ THE `smtp.` PREFIX IS WHAT SEPARATES THE TWO, AND IT IS NOT A COINCIDENCE.
 * upyo emits `code: "smtp.…"` only from branches where it recognised a specific
 * condition — a numeric reply, or a deterministic local fault like an envelope
 * it will not accept or a message past the server's size limit. Its text-matching
 * fallback produces bare codes (`network`, `unknown`, `timeout`) with no prefix.
 * So the prefix means "upyo knows what this is", and its absence means "upyo
 * guessed" — which is exactly the line we want to draw.
 */
function classify(receipt: Extract<SmtpReceipt, { successful: false }>): SendOutcome {
  const reason = receipt.errorMessages.join("; ") || "relay failed"
  const error = receipt.errors?.[0]
  const code = error?.code ?? ""

  const reply = /^smtp\.(\d{3})$/.exec(code)
  if (reply) {
    // ⚠ A 5xx ON `EHLO`, `STARTTLS` OR THE GREETING IS NOT A VERDICT ON THE
    // MESSAGE, AND TREATING IT AS ONE IS A QUEUE-WIDE EXTINCTION EVENT. The
    // server is refusing us, so it answers the same for every message, and a
    // permanent classification would burn the entire backlog to `failed` within
    // one batch, with each row's reason naming the message rather than the
    // cause. The session is ours to fix and the mail is still deliverable, so
    // it waits.
    //
    // The message-phase commands — `MAIL FROM`, `RCPT TO`, `DATA` — are the
    // only ones whose 5xx is about this message.
    const command = commandOf(error?.providerDetails)
    if (command !== null && !MESSAGE_PHASE.has(command)) {
      return { status: "deferred", reason }
    }

    // ⚠ AND THE SAME EVENT CAN ARRIVE IN THE MESSAGE PHASE, BECAUSE THE RELAY
    // TAKES NO CREDENTIAL. What `535` on AUTH used to mean — "not you" — now
    // comes back as a refusal of the envelope, and it is still about us: a
    // rule in plan.ndjson not applied, a listener that still demands AUTH, a
    // return path the sender rule refuses. Each answers identically for every
    // message, so each waits for the fix rather than failing the queue.
    if (command !== null && isRelayRefusal(command, error?.providerDetails)) {
      return { status: "deferred", reason }
    }

    const status = Number(reply[1])
    return status >= 500 && status < 600
      ? { status: "rejected", reason }
      : { status: "deferred", reason }
  }

  // A recognised local fault: an envelope upyo will not accept, a message over
  // the server's advertised size, a capability the server does not have. Each
  // is a fact about this message or this configuration and reproduces exactly,
  // so retrying only spends the attempt budget.
  if (code.startsWith("smtp.")) return { status: "rejected", reason }

  // Everything else — a socket that never opened, a TLS handshake that failed, a
  // connection closed mid-command, or a message upyo could only guess at. None
  // of those is evidence about the message.
  return { status: "deferred", reason }
}

/**
 * The SMTP commands whose rejection is about the message rather than about us.
 */
const MESSAGE_PHASE = new Set(["MAIL FROM", "RCPT TO", "DATA"])

/**
 * Stalwart's refusals of the relay itself, as command and enhanced status.
 *
 * ⚠ READ FROM STALWART'S SOURCE (v0.16.19, `smtp/src/inbound`), NOT FROM THE
 * RFCs, BECAUSE THE CODES ARE ITS CHOICES:
 *
 *   RCPT TO    550 5.1.2 Relay not allowed.          — `allowRelaying` said no
 *   MAIL FROM  503 5.5.1 You must authenticate first. — the port demands AUTH
 *   MAIL FROM  550 5.7.1 Sender address not allowed.  — `isSenderAllowed` said no
 *
 * ⚠ THE ENHANCED CODE AND NOT THE TEXT. Wording changes between releases; the
 * status code is what the reply is classified by everywhere else. And it is
 * narrow on purpose: `5.1.1` (no such local mailbox) and `5.3.4` (too big) are
 * genuinely about the message and must still fail it.
 */
const RELAY_REFUSALS = new Set(["RCPT TO 5.1.2", "MAIL FROM 5.5.1", "MAIL FROM 5.7.1"])

function isRelayRefusal(command: string, details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false
  const enhanced = (details as { enhancedStatusCode?: unknown }).enhancedStatusCode
  if (typeof enhanced !== "object" || enhanced === null) return false
  const code = (enhanced as { code?: unknown }).code
  return typeof code === "string" && RELAY_REFUSALS.has(`${command} ${code}`)
}

/**
 * ⚠ READ DEFENSIVELY, BECAUSE THE SHAPE IS THE LIBRARY'S AND THE DECISION IS
 * OURS. `providerDetails` is typed `unknown` on `ReceiptError`; a narrowing that
 * silently stopped matching would send every relay failure down the
 * message-phase branch and quietly reclassify a refusal of us as undeliverable
 * mail. Returning null when the shape is not what we expect keeps the caller on
 * the reply code alone, which is the conservative half.
 */
function commandOf(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null
  const command = (details as { command?: unknown }).command
  return typeof command === "string" ? command : null
}

export { classify as classifyStalwartReceipt }
