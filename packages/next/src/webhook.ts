import { createHmac, timingSafeEqual } from "node:crypto"

export interface WebhookEvent {
  type: string
  created_at: string
  data: Record<string, unknown>
}

export interface WebhookHandlerOptions {
  /** The signing secret shown once when the endpoint is created. */
  secret: string
  onEvent: (event: WebhookEvent) => Promise<void> | void
  /**
   * How far a timestamp may be from now before the request is rejected.
   * Defaults to five minutes.
   */
  toleranceSeconds?: number
}

const ID_HEADER = "webhook-id"
const SIGNATURE_HEADER = "webhook-signature"
const TIMESTAMP_HEADER = "webhook-timestamp"

/**
 * Constant-time verification of a Standard Webhooks signature.
 *
 * i10 signs `${id}.${timestamp}.${body}` with HMAC-SHA256 and sends the digest
 * base64-encoded as `v1,<digest>` in `webhook-signature`. That is the published
 * spec, so this function is a convenience rather than a requirement — any
 * conforming library verifies an i10 webhook.
 *
 * The id and timestamp are inside the signed payload rather than merely
 * alongside it. A signature covering only the body is replayable forever, and a
 * delivered `email.bounced` replayed a thousand times is a suppression list
 * that suppresses everyone.
 */
export function verifySignature(
  rawBody: string,
  id: string,
  signature: string,
  timestamp: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const sent = Number(timestamp)
  if (!Number.isFinite(sent)) return false
  if (Math.abs(Date.now() / 1000 - sent) > toleranceSeconds) return false

  // The secret is `whsec_` followed by base64, and the DECODED BYTES are what
  // key the HMAC. Keying with the printable string is the classic mistake here
  // and produces a digest that disagrees with every conforming implementation.
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  const key = Buffer.from(raw, "base64")
  if (key.length === 0) return false

  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest()

  // A space-delimited list, so a secret can be rotated with both live. Any one
  // match is a pass; an entry we cannot parse is skipped rather than fatal,
  // because the list may carry versions this SDK does not implement.
  for (const part of signature.split(" ")) {
    const [version, encoded] = part.split(",", 2)
    if (version !== "v1" || !encoded) continue

    const candidate = Buffer.from(encoded, "base64")
    // timingSafeEqual throws on a length mismatch, which would itself leak the
    // expected length through the exception path.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true
    }
  }
  return false
}

/**
 * Builds a Next route handler. Mount it as the POST export of an App Router
 * route:
 *
 *   export const POST = createWebhookHandler({ secret, onEvent })
 */
export function createWebhookHandler(options: WebhookHandlerOptions) {
  return async function POST(request: Request): Promise<Response> {
    const id = request.headers.get(ID_HEADER)
    const signature = request.headers.get(SIGNATURE_HEADER)
    const timestamp = request.headers.get(TIMESTAMP_HEADER)
    // ⚠ THE ID IS REQUIRED NOW, NOT OPTIONAL METADATA. It is signed material,
    // so a request without it cannot be verified at all.
    if (!id || !signature || !timestamp) {
      return new Response("Missing signature headers.", { status: 400 })
    }

    // Read the RAW body. Parsing first and re-serialising changes key order and
    // whitespace, and the signature is over bytes.
    const rawBody = await request.text()

    if (
      !verifySignature(
        rawBody,
        id,
        signature,
        timestamp,
        options.secret,
        options.toleranceSeconds,
      )
    ) {
      return new Response("Invalid signature.", { status: 401 })
    }

    await options.onEvent(JSON.parse(rawBody) as WebhookEvent)
    return new Response(null, { status: 204 })
  }
}
