/**
 * Public identifiers.
 *
 * Rows are keyed by UUIDv7 in Postgres — native `uuid`, so 16 bytes rather than
 * 36, and time-ordered, so inserts into the message tables stay at the right
 * edge of the index instead of scattering across it. What customers see is a
 * prefixed string, because `msg_…` in a log line says what it is and `dom_…`
 * pasted where a message id belongs is rejected rather than looked up.
 *
 * ⚠ THE PREFIX IS PART OF THE CONTRACT, THE ENCODING IS NOT. Hex without
 * dashes, so the mapping is obvious and reversible with no library and no
 * alphabet to get wrong. Changing the encoding later would invalidate every id
 * a customer has stored.
 */

const PREFIXES = {
  tenant: "ten",
  domain: "dom",
  apiKey: "key",
  message: "msg",
  event: "evt",
} as const

export type IdKind = keyof typeof PREFIXES

const HEX32 = /^[0-9a-f]{32}$/

/** `0199a3f2-…` → `msg_0199a3f2…`. */
export function encodeId(kind: IdKind, uuid: string): string {
  const hex = uuid.replaceAll("-", "").toLowerCase()
  if (!HEX32.test(hex)) throw new TypeError(`Not a uuid: ${uuid}`)
  return `${PREFIXES[kind]}_${hex}`
}

/**
 * `msg_0199a3f2…` → `0199a3f2-…`, or null.
 *
 * ⚠ IT RETURNS NULL RATHER THAN THROWING, AND THE KIND IS CHECKED. These
 * arrive from customer requests, so a malformed one is a 404 or a 422 — an
 * ordinary answer, not an exception to handle at every call site. Checking the
 * kind is what stops a domain id in a message route from becoming a lookup that
 * happens to find nothing for a confusing reason.
 */
export function decodeId(kind: IdKind, id: string): string | null {
  const prefix = `${PREFIXES[kind]}_`
  if (!id.startsWith(prefix)) return null

  const hex = id.slice(prefix.length)
  if (!HEX32.test(hex)) return null

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

/**
 * The timestamp inside a UUIDv7, as milliseconds since the epoch.
 *
 * ⚠ THIS IS WHAT MAKES `GET /emails/{id}` AFFORDABLE. `core.messages` is
 * partitioned by `created_at`, so its primary key has to be `(id, created_at)`
 * and a lookup by bare id would have to touch every partition. It does not have
 * to, because the id carries its own creation time: RFC 9562 puts a 48-bit
 * big-endian millisecond timestamp in the first six bytes of a v7. Deriving the
 * partition from the id turns a fan-out into a single-partition seek.
 *
 * Returns null for anything that is not a v7 — an id minted by an older scheme,
 * or a v4 from a test fixture — so the caller falls back to a full lookup
 * rather than reading a random number as a date.
 */
export function timestampFromUuidV7(uuid: string): Date | null {
  const hex = uuid.replaceAll("-", "").toLowerCase()
  if (!HEX32.test(hex)) return null

  // Version is the high nibble of byte 6; variant is the top bits of byte 8.
  if (hex[12] !== "7") return null
  const variant = parseInt(hex[16]!, 16)
  if ((variant & 0b1100) !== 0b1000) return null

  return new Date(Number(BigInt(`0x${hex.slice(0, 12)}`)))
}
