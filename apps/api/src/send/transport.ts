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
 * ⚠ THIS IS THE ONLY THING THAT MAKES A DUPLICATE HARMLESS, AND IT IS WHY IT IS
 * DERIVED RATHER THAN RANDOM. The send path is at-least-once by design: the
 * worker can call the provider, have it accepted, and die before recording the
 * result, and no provider offers a request-level idempotency key that would let
 * the retry be recognised. What it can do is send a message that is byte-wise
 * the SAME message — and receiving systems, including Gmail, collapse two
 * deliveries sharing a Message-ID into one.
 *
 * So a retry must produce this exact value again. Anything time-based or random
 * here silently turns the accepted duplicate rate into a delivered duplicate
 * rate.
 *
 * The domain is taken from the From address so the Message-ID aligns with the
 * sending domain, which is what receivers expect and what some filters check.
 */
export function messageIdHeader(id: string, fromAddress: string): string {
  const at = fromAddress.lastIndexOf("@")
  const domain =
    at === -1
      ? "i10.tech"
      : fromAddress
          .slice(at + 1)
          .trim()
          .toLowerCase()
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
