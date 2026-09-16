import type { Transporter } from "nodemailer"
import { describeError } from "../errors.js"
import { domainOf } from "./address.js"
import { signMessage } from "./dkim.js"
import { buildRawMessage } from "./mime.js"
import type { DomainSending } from "./signing-key.js"
import type { OutboundMessage, SendOutcome, Transport } from "./transport.js"

/**
 * Our own MTA as the relay.
 *
 * ⚠ SUBMISSION, NOT DELIVERY. This hands a finished message to Stalwart over
 * SMTP and stops there. Stalwart owns the queue, the retries, the MX lookups
 * and the DSN generation from that point — all of which it already does
 * properly, and none of which is worth rebuilding inside a worker. The same
 * argument in reverse is why mailbox mail does not go out through the SES API:
 * see docs/decisions/mail-routing.md.
 *
 * ⚠ THE MESSAGE IS BUILT BY `buildRawMessage`, THE SAME FUNCTION THE SES ROUTE
 * USES. A per-domain route lever is only honest if the route is invisible in
 * what arrives, so both paths compose identical bytes and differ only in who
 * carries them and who signs them.
 */

export interface StalwartTransportOptions {
  /** A nodemailer transporter pointed at Stalwart's submission port. */
  mailer: Pick<Transporter, "sendMail">
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
        return { status: "rejected", reason: describeError(err) }
      }

      try {
        const info = await opts.mailer.sendMail({
          raw,
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
            to: [...message.to, ...message.cc, ...message.bcc],
          },
        })

        const id = (info as { messageId?: string }).messageId
        // Mirrors sesTransport: an acceptance we cannot name is not something to
        // record as sent, because nothing could later be joined to it.
        if (!id) {
          return { status: "deferred", reason: "submission returned no message id" }
        }
        return { status: "sent", providerMessageId: id }
      } catch (err) {
        return classify(err)
      }
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
 * ⚠ AND NO CODE AT ALL IS TEMPORARY. A socket that never opened, a TLS
 * handshake that failed, a connection Stalwart closed mid-command — none of
 * those is evidence about the message.
 */
function classify(err: unknown): SendOutcome {
  const code = (err as { responseCode?: number }).responseCode
  if (typeof code === "number" && code >= 500 && code < 600) {
    return { status: "rejected", reason: describeError(err) }
  }
  return { status: "deferred", reason: describeError(err) }
}
