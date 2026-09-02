import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2"
import { buildRawMessage } from "./mime.js"
import {
  messageIdHeader,
  type OutboundMessage,
  type SendOutcome,
  type Transport,
} from "./transport.js"

/**
 * SES as the relay.
 *
 * ⚠ ONE `SendEmail` PER MESSAGE, AND THERE IS NO ALTERNATIVE. `SendBulkEmail`
 * exists but its `DefaultContent` accepts a `Template` and nothing else, so a
 * product where customers send their own content cannot use it. It would not
 * help anyway: SES's quota counts MESSAGES, not API calls, so fifty in one
 * request would still spend fifty of the send rate. Throughput comes from
 * concurrency and connection reuse, which is why the batching lives in the
 * queue and the concurrency lives in the worker.
 *
 * ⚠ AND A MESSAGE WITH AN ATTACHMENT TAKES A DIFFERENT SHAPE THROUGH THE SAME
 * CALL. `Content.Simple` has no room for a file, so those are built as raw MIME
 * in send/mime.ts and sent as `Content.Raw` — same command, same tags, same
 * configuration set, same classification of what came back. `Destination` is
 * still supplied alongside the raw bytes, which is what keeps `Bcc` blind: the
 * recipients come from there and the header is never written.
 *
 * ⚠ AND THE CLIENT IS CONSTRUCTED ONCE. Its connection pool and credential
 * cache are the reason repeated sends are fast; building one per message turns
 * every send into a TLS handshake and, on some credential providers, an STS
 * call.
 */

export interface SesTransportOptions {
  client: SESv2Client
  /**
   * The SES configuration set. ⚠ WITHOUT IT THERE ARE NO EVENTS, AND WITHOUT
   * EVENTS THE SES RECONCILER IS BLIND — it reads `core.message_events`, which
   * only exists because SES publishes to a configuration set's destination.
   * Leaving this unset does not fail a send; it silently removes half the
   * safety net.
   */
  configurationSetName?: string
}

export function sesTransport(opts: SesTransportOptions): Transport {
  return {
    async send(message: OutboundMessage): Promise<SendOutcome> {
      try {
        const result = await opts.client.send(
          new SendEmailCommand(toSesInput(message, opts.configurationSetName)),
        )

        // A 200 with no MessageId is not something SES documents, but treating
        // it as sent would record a message we cannot join any event to, and
        // treating it as rejected would drop mail SES may have taken. Deferred
        // is the honest answer: unknown, ask again.
        if (!result.MessageId) {
          return { status: "deferred", reason: "SES returned no MessageId" }
        }
        return { status: "sent", providerMessageId: result.MessageId }
      } catch (err) {
        return classify(err)
      }
    },
  }
}

function toSesInput(
  m: OutboundMessage,
  configurationSetName?: string,
): SendEmailCommandInput {
  return {
    FromEmailAddress: m.from,
    Destination: {
      ToAddresses: [...m.to],
      CcAddresses: m.cc.length ? [...m.cc] : undefined,
      BccAddresses: m.bcc.length ? [...m.bcc] : undefined,
    },
    ReplyToAddresses: m.replyTo.length ? [...m.replyTo] : undefined,
    ConfigurationSetName: configurationSetName,

    // ⚠ THIS TAG IS THE JOIN KEY FOR EVERYTHING DOWNSTREAM. SES echoes it on
    // every event it publishes, and `core.message_events` is matched back to
    // `core.messages` by it. Without it the events arrive carrying only SES's
    // own id, the reconcilers cannot tell whose message they describe, and
    // bounce handling has nothing to suppress against.
    //
    // ⚠ AND ITS VALUE IS CONSTRAINED. SES allows only letters, digits, hyphens
    // and underscores in a tag value, so a raw UUID with its dashes is fine and
    // anything prefixed like `msg_…` would be rejected at send time.
    EmailTags: buildTags(m),

    Content: content(m),
  }
}

/**
 * ⚠ SIMPLE UNLESS THERE IS AN ATTACHMENT, AND THE CONDITION IS EXACTLY THAT.
 * `Content.Simple` cannot express a file, so a message carrying one has to be
 * assembled as raw MIME — but building every message that way would put a
 * hand-written encoder on the path of every password reset in the product, to
 * no benefit. The common case stays the one SES validates for us.
 */
function content(m: OutboundMessage): SendEmailCommandInput["Content"] {
  const attachments = m.attachments ?? []

  if (attachments.length > 0) {
    return {
      Raw: { Data: Buffer.from(buildRawMessage(m, attachments), "utf8") },
    }
  }

  return {
    Simple: {
      Subject: { Data: m.subject, Charset: "UTF-8" },
      Body: {
        ...(m.text ? { Text: { Data: m.text, Charset: "UTF-8" } } : {}),
        ...(m.html ? { Html: { Data: m.html, Charset: "UTF-8" } } : {}),
      },
      Headers: buildHeaders(m),
    },
  }
}

/**
 * i10's join key first, then the caller's own labels.
 *
 * ⚠ OURS CANNOT BE OVERWRITTEN. `i10_message_id` is what matches an SES event
 * back to a row in `core.messages`; a customer tag of the same name would
 * detach every delivery, bounce and complaint for that send from the message
 * they describe — and suppression, which is built from those events, would stop
 * working for exactly the sends that need it. The contract already refuses an
 * `i10_` prefix; this is the second lock on the same door.
 */
function buildTags(m: OutboundMessage): { Name: string; Value: string }[] {
  const tags = [{ Name: "i10_message_id", Value: m.id }]
  const seen = new Set(["i10_message_id"])

  for (const tag of m.tags ?? []) {
    if (seen.has(tag.name)) continue
    seen.add(tag.name)
    tags.push({ Name: tag.name, Value: tag.value })
  }
  return tags
}

/**
 * ⚠ THE Message-ID IS THE DUPLICATE MITIGATION AND MUST SURVIVE A RETRY.
 * The send path is at-least-once; a resend of the same row produces the same
 * header, and receiving systems collapse the two deliveries. Letting SES mint
 * its own would make every retry a visibly separate email.
 */
function buildHeaders(m: OutboundMessage): { Name: string; Value: string }[] {
  const headers = [
    { Name: "Message-ID", Value: messageIdHeader(m.id, m.from) },
    ...Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
  ]
  // A caller-supplied Message-ID would defeat the whole mechanism, so ours wins.
  const seen = new Set<string>()
  return headers.filter((h) => {
    const key = h.Name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Which SES failures are worth trying again.
 *
 * ⚠ THE SPLIT IS THE POINT, AND BOTH MISTAKES COST. Treating a throttle as
 * permanent drops mail the customer paid for; treating a malformed address as
 * temporary retries it to the attempt cap, spending quota to reach the same
 * answer and delaying everything behind it.
 *
 * Names are matched rather than instances, because the SDK's error classes are
 * not reliably `instanceof`-able across bundling and version boundaries — a
 * check that silently stops matching would quietly reclassify every failure.
 */
function classify(err: unknown): SendOutcome {
  const name = (err as { name?: string } | null)?.name ?? ""
  const message = err instanceof Error ? err.message : String(err)
  const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode

  switch (name) {
    // The message itself is unacceptable, or the identity is not usable. No
    // number of retries changes either.
    case "MessageRejected":
    case "MailFromDomainNotVerifiedException":
    case "BadRequestException":
    case "NotFoundException":
      return { status: "rejected", reason: `${name}: ${message}` }

    // ⚠ ACCOUNT-LEVEL AND PERMANENT FOR THIS MESSAGE, BUT THE REAL PROBLEM IS
    // NOT THIS MESSAGE. Every send will fail the same way until somebody
    // intervenes with AWS, so retrying only converts an outage into a very
    // expensive one.
    case "AccountSuspendedException":
      return { status: "rejected", reason: `${name}: ${message}` }

    // Paused, throttled, or over a limit — all of which pass.
    case "SendingPausedException":
    case "TooManyRequestsException":
    case "LimitExceededException":
    case "ThrottlingException":
      return { status: "deferred", reason: `${name}: ${message}` }
  }

  // ⚠ ANYTHING UNRECOGNISED IS DEFERRED, NOT REJECTED. A 4xx we have not seen
  // before is more likely a new SES error name than a message that can never be
  // sent, and the cost of being wrong is asymmetric: a needless retry versus a
  // dropped email. 4xx other than 429 is the one case worth stopping on, since
  // those are almost always the request being wrong.
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
    return { status: "rejected", reason: `HTTP ${status}: ${message}` }
  }
  return { status: "deferred", reason: message }
}

export { classify as classifySesError }
