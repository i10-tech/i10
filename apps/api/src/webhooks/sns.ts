import { createVerify } from "node:crypto"

/**
 * Verifying that a notification really came from SNS.
 *
 * ⚠ THIS ENDPOINT IS PUBLIC AND WHAT IT WRITES IS DESTRUCTIVE. A forged
 * `Bounce` adds an address to a tenant's suppression list, which stops their
 * mail to that person permanently and silently; a forged `Complaint` does the
 * same and damages the reputation record. Anyone who learns the URL — and a URL
 * in a config file is not a secret — can do that to every customer at once
 * unless each message is proved to be Amazon's.
 *
 * ⚠ AND THE SIGNATURE IS OVER A CANONICAL STRING SNS DEFINES, NOT OVER THE BODY.
 * It is the message's own fields, in a fixed order, each as `key\nvalue\n` —
 * so re-serialising the JSON is harmless here, unlike the Svix scheme next
 * door. Which fields depends on the message type, and getting that list wrong
 * fails closed: every message is rejected.
 *
 * ⚠ THE CERTIFICATE URL IS ATTACKER-CONTROLLED UNTIL IT IS CHECKED. It arrives
 * inside the message being verified, so fetching it before validating the host
 * is an SSRF with a signature check bolted on afterwards — the attacker points
 * it at their own server, serves their own certificate, and signs whatever they
 * like. The host allowlist below is the whole of that defence.
 */

export interface SnsMessage {
  Type: string
  MessageId: string
  TopicArn: string
  Message: string
  Timestamp: string
  SignatureVersion: string
  Signature: string
  SigningCertURL: string
  Subject?: string
  Token?: string
  SubscribeURL?: string
  UnsubscribeURL?: string
}

/**
 * The fields SNS signs, in the order it signs them.
 *
 * ⚠ THE TWO CONFIRMATION TYPES SHARE ONE LIST BECAUSE THEY SHARE ONE FORMAT.
 * Written twice, a correction to Amazon's field order gets applied to one and
 * missed on the other — and the symptom is that unsubscribes stop verifying
 * while subscriptions still do, which reads like an AWS fault.
 */
const CONFIRMATION_FIELDS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const

const SIGNED_FIELDS: Record<string, readonly string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: CONFIRMATION_FIELDS,
  UnsubscribeConfirmation: CONFIRMATION_FIELDS,
}

/**
 * ⚠ THE ONLY HOSTS A CERTIFICATE OR A SUBSCRIBE URL MAY LIVE ON. Anchored at
 * both ends: `sns.eu-central-1.amazonaws.com.evil.test` matches a careless
 * `endsWith("amazonaws.com")` and is not Amazon.
 */
const AWS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

export function isAwsUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === "https:" && AWS_HOST.test(parsed.hostname)
}

/** Fetches a signing certificate, with a small cache. Injected in tests. */
export type CertificateFetcher = (url: string) => Promise<string>

/** A handful of entries covers every AWS region a deployment actually uses. */
const CERT_CACHE_MAX = 8
/** Long enough to be a cache, short enough that a rotation heals by itself. */
const CERT_CACHE_TTL_MS = 6 * 60 * 60 * 1000

export function cachingCertificateFetcher(
  doFetch: typeof fetch = fetch,
  timeoutMs = 3000,
  ttlMs = CERT_CACHE_TTL_MS,
): CertificateFetcher {
  // ⚠ THE PROMISE IS CACHED, NOT THE RESOLVED STRING. SES publishes events in
  // bursts, so a cold pod takes a burst of notifications at once — and a cache
  // that only fills after `await` lets every one of them issue its own outbound
  // fetch for the same certificate, which is precisely what this exists to
  // stop. Storing the in-flight promise makes the burst share one request.
  //
  // ⚠ AND IT IS BOUNDED AND EXPIRING. The key is a URL from the request body;
  // the host is validated, but the path is not, so an unbounded map is a
  // memory leak anyone can drive. A TTL also means a rotated certificate heals
  // on its own rather than at the next restart.
  const cache = new Map<string, { at: number; pem: Promise<string> }>()

  return async (url) => {
    const hit = cache.get(url)
    if (hit && Date.now() - hit.at < ttlMs) return hit.pem

    const pem = (async () => {
      const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error(`certificate fetch failed: ${response.status}`)
      return response.text()
    })()

    // A rejected fetch must not be remembered, or one blip poisons the cache
    // for its whole TTL.
    pem.catch(() => cache.delete(url))

    cache.set(url, { at: Date.now(), pem })
    if (cache.size > CERT_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return pem
  }
}

export type SnsVerdict = { ok: true } | { ok: false; reason: string }

export async function verifySnsMessage(
  message: SnsMessage,
  fetchCertificate: CertificateFetcher,
): Promise<SnsVerdict> {
  const fields = SIGNED_FIELDS[message.Type]
  if (!fields) return { ok: false, reason: `unknown message type ${message.Type}` }

  // ⚠ BEFORE THE FETCH, NEVER AFTER. See the note at the top of this file.
  if (!isAwsUrl(message.SigningCertURL)) {
    return { ok: false, reason: "signing certificate is not hosted by AWS" }
  }

  // SignatureVersion 1 is SHA1, 2 is SHA256. ⚠ The version travels in the
  // message, so an attacker chooses it — which is only safe because both are
  // verified against Amazon's certificate and neither is forgeable without the
  // private key. Anything else is refused rather than guessed.
  const algorithm =
    message.SignatureVersion === "1"
      ? "RSA-SHA1"
      : message.SignatureVersion === "2"
        ? "RSA-SHA256"
        : null
  if (!algorithm) {
    return {
      ok: false,
      reason: `unsupported SignatureVersion ${message.SignatureVersion}`,
    }
  }

  let certificate: string
  try {
    certificate = await fetchCertificate(message.SigningCertURL)
  } catch (err) {
    return { ok: false, reason: `could not fetch signing certificate: ${String(err)}` }
  }

  const verifier = createVerify(algorithm)
  verifier.update(canonicalString(message, fields), "utf8")

  try {
    const valid = verifier.verify(certificate, message.Signature, "base64")
    return valid ? { ok: true } : { ok: false, reason: "signature does not verify" }
  } catch (err) {
    return { ok: false, reason: `signature check failed: ${String(err)}` }
  }
}

/**
 * `key\nvalue\n` for each present field, in SNS's order.
 *
 * A field that is absent is SKIPPED rather than written empty — `Subject` is
 * optional on a Notification, and including it as an empty string produces a
 * string Amazon never signed.
 */
export function canonicalString(
  message: SnsMessage,
  fields: readonly string[],
): string {
  let out = ""
  for (const field of fields) {
    const value = (message as unknown as Record<string, unknown>)[field]
    if (value === undefined || value === null) continue
    out += `${field}\n${String(value)}\n`
  }
  return out
}
