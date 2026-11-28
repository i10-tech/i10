/**
 * One `<id>:<base64 secret>` key entry, parsed EXACTLY as Go's
 * `keyring.ParseKey` (services/authd/internal/keyring) parses it, so a key
 * ring in Doppler means the same thing to the API, enrolld and enrollctl.
 * `services/authd/internal/keyring/testdata/parse-key-vectors.json` drives
 * both languages' tests.
 *
 * Go's rules, mirrored here:
 *   - the entry is trimmed with Go's `strings.TrimSpace` (unicode.IsSpace);
 *   - the id is everything before the FIRST colon: decimal digits only (no
 *     sign), leading zeros allowed, 0 to 255;
 *   - the secret is padded standard base64, or else unpadded base64url; CR and
 *     LF inside it are ignored (as Go's decoder ignores them), and unused
 *     trailing bits are not checked;
 *   - it decodes to at least MIN_KEY_LEN bytes.
 *
 * ⚠ ERRORS NEVER QUOTE THE ENTRY: a key written the wrong way round
 * (`<secret>:<id>`) would put the secret in a log.
 */

export const MIN_KEY_LEN = 32

export interface KeyEntry {
  readonly id: number
  readonly secret: Buffer
}

// unicode.IsSpace: \t \n \v \f \r, space, U+0085, U+00A0 and category Z.
const GO_SPACE =
  "[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]"
const GO_TRIM = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, "g")
const DECIMAL = /^[0-9]+$/
const STD_PADDED = /^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const RAW_URL = /^[A-Za-z0-9_-]*$/

function decodeSecret(text: string): Buffer | null {
  const s = text.replace(/[\r\n]/g, "")
  if (s.length % 4 === 0 && STD_PADDED.test(s)) return Buffer.from(s, "base64")
  if (s.length % 4 !== 1 && RAW_URL.test(s)) return Buffer.from(s, "base64url")
  return null
}

/** Go's `strings.TrimSpace`. */
export function goTrimSpace(s: string): string {
  return s.replace(GO_TRIM, "")
}

/**
 * The non-empty entries of a comma-separated ring, as Go's `ParseRing` sees
 * them (an entry that is only whitespace is skipped).
 */
export function ringEntries(raw: string): string[] {
  return raw.split(",").filter((part) => goTrimSpace(part) !== "")
}

export function parseKeyEntry(name: string, entry: string): KeyEntry {
  const trimmed = goTrimSpace(entry)
  const colon = trimmed.indexOf(":")
  if (colon < 0) {
    throw new Error(`${name}: a key is <id>:<base64 secret>`)
  }
  const idText = trimmed.slice(0, colon)
  const digits = idText.replace(/^0+(?=.)/, "")
  if (!DECIMAL.test(idText) || digits.length > 3 || Number(digits) > 255) {
    throw new Error(`${name}: the key id (${idText.length} bytes) is not 0 to 255`)
  }
  const id = Number(digits)
  const secret = decodeSecret(trimmed.slice(colon + 1))
  if (!secret) {
    throw new Error(`${name}: key ${id} is not base64`)
  }
  if (secret.byteLength < MIN_KEY_LEN) {
    throw new Error(
      `${name}: key ${id} is ${secret.byteLength} bytes, need at least ${MIN_KEY_LEN}`,
    )
  }
  return { id, secret }
}
