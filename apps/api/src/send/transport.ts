import type { Attachment, Tag } from "@repo/contracts"
import { domainOf } from "./address.js"

/**
 * The boundary between i10 and whoever actually relays the mail.
 *
 * ⚠ AN INTERFACE BECAUSE THE RELAY IS A CHOICE, NOT A FACT. SES is the relay
 * today, and the portability record in the DNS stack exists so customers do not
 * have to know that. This is the same seam on the code side: everything above
 * it — the claim, the batching, the metering, the reconcilers — is written
 * against three outcomes rather than against an AWS SDK.
 *
 * ⚠ AND THE THREE OUTCOMES ARE THE SAME DISCIPLINE AS EVERYWHERE ELSE IN THIS
 * CODEBASE. `clerkauth` refuses to collapse "no" into "we could not ask", and
 * authd answers LDAP `unavailable` rather than `invalidCredentials` for the
 * same reason. Here the split is between a message that will never be accepted
 * and one that was not accepted this time, and collapsing them costs real mail:
 * treat a rate limit as permanent and the message is dropped; treat a malformed
 * address as temporary and it is retried until the attempt cap, burning quota
 * on something that cannot work.
 */

export interface OutboundMessage {
  /** i10's own id. It travels to the provider and comes back on every event. */
  id: string
  tenantId: string
  from: string
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  replyTo: readonly string[]
  subject: string
  text?: string | null
  html?: string | null
  headers?: Record<string, string> | null
  /**
   * Files to send with the message, base64 in `content`.
   *
   * ⚠ THEIR PRESENCE CHANGES HOW THE MESSAGE IS BUILT, NOT JUST WHAT IS IN IT.
   * SES's structured content cannot express an attachment, so a message with
   * one is assembled as raw MIME instead — see send/mime.ts. Everything above
   * this line behaves identically either way; this is the only field that
   * switches the path.
   */
  attachments?: readonly Attachment[] | null
  /** The caller's own labels, echoed back on every provider event. */
  tags?: readonly Tag[] | null
}

export type SendOutcome =
  /** The provider took it. `providerMessageId` is its own id for the message. */
  | { status: "sent"; providerMessageId: string }
  /**
   * It will never be accepted — a malformed address, a body the provider
   * refuses, an identity that is not verified. Retrying spends quota to reach
   * the same answer, so the message stops here.
   */
  | { status: "rejected"; reason: string }
  /**
   * Not this time. A rate limit, a throttle, a five hundred, a socket that went
   * away. The message goes back to the queue.
   */
  | { status: "deferred"; reason: string }

export interface Transport {
  send(message: OutboundMessage): Promise<SendOutcome>
}

/**
 * The RFC 5322 Message-ID, derived from i10's own message id.
 *
 * ⚠ SES DISCARDS THIS HEADER, AND THE DUPLICATE MITIGATION IT WAS WRITTEN FOR
 * DOES NOT EXIST ON THAT ROUTE. Measured 2026-09-08 and documented by AWS: the
 * SendRawEmail reference states SES applies its own `Message-ID` and `Date`
 * headers and that a caller's are overwritten. Confirmed twice — through this
 * code, and through a hand-written raw message sent with the AWS CLI, which
 * bypasses everything here. Both arrived as `…@eu-central-1.amazonses.com`.
 *
 * The intent it was built on: the send path is at-least-once by design — the
 * worker can call the provider, have it accepted, and die before recording the
 * result, and no provider offers a request-level idempotency key. Two
 * deliveries sharing a Message-ID are collapsed by receivers, including Gmail,
 * so a retry that reproduced this value exactly would arrive as one message.
 *
 * ⚠ THAT REASONING IS STILL SOUND AND IS STILL WHY THIS IS DERIVED RATHER THAN
 * RANDOM — it just does not survive SES. It survives a relay we run ourselves,
 * which writes the envelope rather than handing it to somebody who rewrites it.
 *
 * ⚠ SO THE HEADER SURVIVES ON ONE ROUTE AND NOT THE OTHER, AND `sent_route` ON
 * THE ROW SAYS WHICH. `core.domains.transactional_route` is read on the claim,
 * `resolveRoute` decides, and `handleBatch` asks `transportFor`; a direct-routed
 * message keeps this header because `stalwartTransport` writes the envelope
 * itself. An SES-routed one has it overwritten, which is why this stays derived
 * rather than random — the value is already correct wherever it does survive.
 *
 * ⚠ AND db/claim.ts's TRADE IS WEAKER THAN IT READS FOR SES-ROUTED MAIL. Its
 * "a duplicate is a shrug" rests on receivers collapsing them; for SES that
 * collapse does not happen, because each retry is a separate SendEmail call and
 * gets a separate SES-assigned Message-ID.
 *
 * The domain is taken from the From address so the Message-ID aligns with the
 * sending domain, which is what receivers expect and what some filters check.
 *
 * ⚠ THE From MAY CARRY A DISPLAY NAME, AND THAT HAS TO BE UNWRAPPED FIRST. This
 * used to take everything after the last `@`, which is the domain for a bare
 * `noreply@pslhq.app` and is `pslhq.app>` for the far more common
 * `i10 test <noreply@pslhq.app>` — producing `<id@pslhq.app>>`, with a doubled
 * bracket, which is not a valid msg-id.
 *
 * That bug was real and is fixed, but it was NOT what put `amazonses.com` in
 * delivered mail — SES overwrites a well-formed header just the same. Two
 * separate faults with one symptom, and the malformed one masked the other
 * until a valid header was sent and nothing changed.
 */
export function messageIdHeader(id: string, fromAddress: string): string {
  // ⚠ ONE PARSER, SHARED WITH THE DIRECT TRANSPORT. This used to carry its own
  // copy of the unwrapping, and the Stalwart transport carried a second one with
  // the same regex — see send/address.ts for why two copies of a parser that has
  // already been fixed once is the thing worth removing.
  //
  // The fallback is ours rather than null: a From with no domain at all still
  // needs a well-formed Message-ID, and i10.tech is the honest owner of one we
  // had to invent.
  const domain = domainOf(fromAddress) ?? "i10.tech"
  return `<${id}@${domain}>`
}

/**
 * A transport that accepts everything and remembers what it was given.
 *
 * For tests, and for running the worker end to end before SES production access
 * exists. ⚠ It is never the default: the worker takes a transport as a
 * dependency, so shipping without a real one is a visible omission in one place.
 */
export function fakeTransport(
  behaviour: (m: OutboundMessage) => SendOutcome = () => ({
    status: "sent",
    providerMessageId: "fake",
  }),
): Transport & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = []
  return {
    sent,
    async send(message) {
      sent.push(message)
      return behaviour(message)
    },
  }
}
