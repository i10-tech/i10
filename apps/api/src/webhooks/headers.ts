/**
 * Which request headers a customer may set on their own endpoint.
 *
 * ⚠ THE HEADERS THAT CARRY TRUST, OR THAT THE TRANSPORT OWNS, ARE OURS. In the
 * Svix lab (2026-10-05) a custom endpoint header named `webhook-signature`
 * replaced the real signature. Nothing about that is useful to a customer and
 * all of it is confusing: a receiver that verifies would reject every event,
 * and one that does not would be trusting a value we never produced. The
 * transport headers (`host`, `content-length`, ...) are refused for the same
 * reason - they decide where and how the request goes, and that is decided by
 * the vetted endpoint URL alone (egress.ts).
 */

export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  // Standard Webhooks, and Svix's own names for them.
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "svix-id",
  "svix-timestamp",
  "svix-signature",
  // What the body is and who sent it.
  "content-type",
  "content-length",
  "content-encoding",
  "user-agent",
  // The transport's.
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "expect",
])

export const MAX_CUSTOM_HEADERS = 20
const MAX_VALUE_LENGTH = 1024

/** An RFC 9110 token: what a header name may be made of. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export type HeaderVerdict =
  { ok: true; headers: Record<string, string> } | { ok: false; reason: string }

/**
 * Validates a customer's custom headers and returns them with lowercased
 * names, ready to merge UNDER ours (ours are applied last regardless).
 */
export function checkCustomHeaders(input: Record<string, unknown>): HeaderVerdict {
  const entries = Object.entries(input)
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return { ok: false, reason: `At most ${MAX_CUSTOM_HEADERS} custom headers.` }
  }
  const out: Record<string, string> = {}
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase()
    if (!TOKEN.test(name))
      return { ok: false, reason: `\`${rawName}\` is not a valid header name.` }
    if (
      RESERVED_HEADERS.has(name) ||
      name.startsWith("webhook-") ||
      name.startsWith("svix-")
    ) {
      return {
        ok: false,
        reason: `\`${rawName}\` is set by i10 and cannot be overridden.`,
      }
    }
    if (typeof value !== "string")
      return { ok: false, reason: `\`${rawName}\` must be a string.` }
    // ⚠ CR AND LF ARE HOW ONE HEADER BECOMES TWO. The same guard the send
    // path applies to MIME headers (#247).
    if (/[\r\n\0]/.test(value))
      return { ok: false, reason: `\`${rawName}\` contains a line break.` }
    if (value.length > MAX_VALUE_LENGTH) {
      return {
        ok: false,
        reason: `\`${rawName}\` is longer than ${MAX_VALUE_LENGTH} characters.`,
      }
    }
    if (name in out) return { ok: false, reason: `\`${rawName}\` is given twice.` }
    out[name] = value
  }
  return { ok: true, headers: out }
}
