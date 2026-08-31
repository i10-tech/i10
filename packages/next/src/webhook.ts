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

const SIGNATURE_HEADER = "i10-signature"
const TIMESTAMP_HEADER = "i10-timestamp"

/**
 * Constant-time verification of `i10-signature` over `${timestamp}.${body}`.
 *
 * The timestamp is inside the signed payload, not merely alongside it — a
 * signature that covers only the body is replayable forever, and a delivered
 * `email.bounced` replayed a thousand times is a suppression list that
 * suppresses everyone.
 */
export function verifySignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const sent = Number(timestamp)
  if (!Number.isFinite(sent)) return false
  if (Math.abs(Date.now() / 1000 - sent) > toleranceSeconds) return false

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")

  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(signature, "utf8")
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // expected length through the exception path.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Builds a Next route handler. Mount it as the POST export of an App Router
 * route:
 *
 *   export const POST = createWebhookHandler({ secret, onEvent })
 */
export function createWebhookHandler(options: WebhookHandlerOptions) {
  return async function POST(request: Request): Promise<Response> {
    const signature = request.headers.get(SIGNATURE_HEADER)
    const timestamp = request.headers.get(TIMESTAMP_HEADER)
    if (!signature || !timestamp) {
      return new Response("Missing signature headers.", { status: 400 })
    }

    // Read the RAW body. Parsing first and re-serialising changes key order and
    // whitespace, and the signature is over bytes.
    const rawBody = await request.text()

    if (
      !verifySignature(
        rawBody,
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
