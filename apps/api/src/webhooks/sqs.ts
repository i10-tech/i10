import { createHash, createHmac } from "node:crypto"
import { SignatureV4 } from "@smithy/signature-v4"

/**
 * Amazon SQS as a webhook destination (#303): instead of a POST to the
 * customer's server, a `SendMessage` to their queue.
 *
 * ⚠ THE SAME ENGINE, A DIFFERENT LAST HOP. Retries, ordering, fairness, the
 * attempt log, replay and health all apply unchanged; only the request is
 * built here. It is signed with SigV4 by AWS's own signer, then sent through
 * the same vetted, address-pinned fetch as every webhook - never a second
 * HTTP stack with its own idea of where it may connect.
 *
 * ⚠ ONLY AWS'S OWN SQS HOSTS. The queue URL is checked on write and again at
 * every send: `https://sqs.<region>.amazonaws.com/<account>/<queue>`. Anything
 * else would let an "SQS destination" be a signed POST to anywhere.
 *
 * ⚠ THE CUSTOMER'S KEYS ARE SEALED LIKE A SIGNING SECRET AND NEVER RETURNED.
 * They should belong to a user that can do nothing but `sqs:SendMessage` on
 * this one queue; the docs say so, and we cannot check it.
 */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface QueueAddress {
  region: string
  account: string
  name: string
  fifo: boolean
  /** Where the API call goes: the queue URL's origin. */
  endpoint: string
}

const QUEUE_URL =
  /^https:\/\/sqs\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com\/(\d{12})\/([A-Za-z0-9_-]{1,75}(\.fifo)?)$/

/** Parses an SQS queue URL, or says what is wrong with it. */
export function parseQueueUrl(url: string): QueueAddress | { error: string } {
  const m = QUEUE_URL.exec(url)
  if (!m) {
    return {
      error:
        "`url` must be an SQS queue URL: https://sqs.<region>.amazonaws.com/<account>/<queue>.",
    }
  }
  return {
    region: m[1]!,
    account: m[2]!,
    name: m[3]!,
    fifo: Boolean(m[4]),
    endpoint: `https://sqs.${m[1]}.amazonaws.com`,
  }
}

const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/

export function checkCredentials(c: {
  access_key_id: string
  secret_access_key: string
}): { ok: true; credentials: AwsCredentials } | { ok: false; reason: string } {
  if (!ACCESS_KEY_ID.test(c.access_key_id))
    return { ok: false, reason: "`access_key_id` is not an AWS access key id." }
  if (c.secret_access_key.length < 16 || /\s/.test(c.secret_access_key))
    return { ok: false, reason: "`secret_access_key` is not an AWS secret access key." }
  return {
    ok: true,
    credentials: { accessKeyId: c.access_key_id, secretAccessKey: c.secret_access_key },
  }
}

/** SHA-256 for the signer, from node:crypto; HMAC when it is given a key. */
type Source = string | ArrayBuffer | ArrayBufferView
const bytes = (d: Source): string | Uint8Array =>
  typeof d === "string"
    ? d
    : d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)

export class Sha256 {
  private readonly hash
  constructor(secret?: Source) {
    this.hash = secret ? createHmac("sha256", bytes(secret)) : createHash("sha256")
  }
  update(data: Source): void {
    this.hash.update(bytes(data))
  }
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()))
  }
}

export interface SqsRequest {
  /** The API endpoint to send to: the queue URL's origin plus `/`. */
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * The signed `SendMessage` for one webhook.
 *
 * ⚠ THE WEBHOOK'S OWN HEADERS RIDE ALONG AS MESSAGE ATTRIBUTES, so a consumer
 * can verify a message exactly as an HTTP receiver verifies a request -
 * `webhook-id`, `webhook-timestamp`, `webhook-signature` over the body.
 *
 * ⚠ A FIFO QUEUE GETS THE ENDPOINT AS ITS GROUP AND THE DELIVERY AS ITS
 * DEDUPLICATION ID. One group keeps the endpoint's order, which is what
 * `sequence` promises; the delivery id makes a retry of a send SQS already
 * accepted a no-op inside SQS's five-minute window.
 */
export async function sqsSendMessage(input: {
  queue: QueueAddress
  queueUrl: string
  credentials: AwsCredentials
  body: string
  attributes: Record<string, string>
  groupId: string
  deduplicationId: string
  now?: Date
}): Promise<SqsRequest> {
  const host = new URL(input.queue.endpoint).host
  const payload = JSON.stringify({
    QueueUrl: input.queueUrl,
    MessageBody: input.body,
    MessageAttributes: Object.fromEntries(
      Object.entries(input.attributes).map(([k, v]) => [
        k,
        { DataType: "String", StringValue: v },
      ]),
    ),
    ...(input.queue.fifo
      ? { MessageGroupId: input.groupId, MessageDeduplicationId: input.deduplicationId }
      : {}),
  })
  const signer = new SignatureV4({
    service: "sqs",
    region: input.queue.region,
    credentials: input.credentials,
    sha256: Sha256,
  })
  const signed = await signer.sign(
    {
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/",
      query: {},
      headers: {
        host,
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonSQS.SendMessage",
      },
      body: payload,
    },
    { signingDate: input.now ?? new Date() },
  )
  return {
    url: `${input.queue.endpoint}/`,
    headers: signed.headers as Record<string, string>,
    body: payload,
  }
}
