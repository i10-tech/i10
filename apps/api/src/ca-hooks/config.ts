/**
 * Configuration of the device CA's webhook listener (#383 PR 3,
 * docs/research/mail-device-binding.md section 11, "The CA").
 *
 * Parsed by `env.ts`, so a malformed value refuses the boot (and the PreSync
 * environment check) without quoting it.
 */

/** The four webhook paths, one per step-ca webhook. Nothing else is served. */
export const CA_HOOK_KINDS = [
  "acme-authorize",
  "scep-challenge",
  "scep-authorize",
  "scep-notify",
] as const
export type CaHookKind = (typeof CA_HOOK_KINDS)[number]

/** Enough for an overlapping rotation, not a place to collect old tokens. */
const MAX_TOKEN_HASHES = 4
const SHA256_HEX = /^[0-9a-f]{64}$/
/** step-ca's `Webhook.ID` is free text in `ca.json`; ours are short and plain. */
const WEBHOOK_ID = /^[A-Za-z0-9._-]{1,128}$/
/** RFC 3339 with an explicit zone, so a value never depends on the pod's TZ. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * `CA_HOOK_TOKEN_HASHES`: comma-separated SHA-256 hex digests of the relay's
 * bearer token. More than one is accepted so the token rotates without an
 * outage: add the new hash, move the relay's token, then drop the old hash.
 */
export function parseTokenHashes(raw: string): Buffer[] {
  const parts = raw.split(",").map((part) => part.trim().toLowerCase())
  if (parts.some((part) => !SHA256_HEX.test(part))) {
    throw new Error("each entry must be 64 hexadecimal digits (a SHA-256 digest)")
  }
  const unique = [...new Set(parts)]
  if (unique.length > MAX_TOKEN_HASHES) {
    throw new Error(`at most ${MAX_TOKEN_HASHES} hashes`)
  }
  return unique.map((hex) => Buffer.from(hex, "hex"))
}

/**
 * `CA_HOOK_WEBHOOK_IDS`: `<kind>=<id>` for each of the four kinds, comma-separated,
 * every kind exactly once and no id twice. The id is step-ca's
 * `X-Smallstep-Webhook-ID`, so a hook body can never be replayed at another path.
 */
export function parseWebhookIds(raw: string): Record<CaHookKind, string> {
  const ids = new Map<CaHookKind, string>()
  for (const entry of raw.split(",")) {
    const [kind, id, extra] = entry.trim().split("=")
    if (extra !== undefined || !kind || !id) {
      throw new Error("each entry must be <kind>=<id>")
    }
    if (!(CA_HOOK_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`unknown kind "${kind}" (expected ${CA_HOOK_KINDS.join(", ")})`)
    }
    if (!WEBHOOK_ID.test(id)) {
      throw new Error(`the id for ${kind} must match ${WEBHOOK_ID.source}`)
    }
    if (ids.has(kind as CaHookKind)) {
      throw new Error(`${kind} is listed twice`)
    }
    ids.set(kind as CaHookKind, id)
  }
  const missing = CA_HOOK_KINDS.filter((kind) => !ids.has(kind))
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(", ")}`)
  }
  if (new Set(ids.values()).size !== ids.size) {
    throw new Error("each kind needs its own id")
  }
  return Object.fromEntries(ids) as Record<CaHookKind, string>
}

/**
 * `CA_INTERMEDIATE_NOT_AFTER`: the device intermediate's `notAfter`. step-ca
 * does not clamp a leaf to its issuer (`cas/softcas/softcas.go`), so the
 * authorizing hooks refuse a leaf that would outlive it.
 *
 * ⚠ A CONFIG VALUE, NOT THE CERTIFICATE. The API is never given the device CA's
 * files (only step-ca, the front and Traefik are), and the value changes once
 * a decade, with the year-7 rotation that sets it again.
 */
export function parseIntermediateNotAfter(raw: string): Date {
  const value = raw.trim()
  const at = new Date(value)
  if (!RFC3339.test(value) || Number.isNaN(at.getTime())) {
    throw new Error(
      "must be an RFC 3339 timestamp with a zone, e.g. 2036-11-26T00:00:00Z",
    )
  }
  return at
}
