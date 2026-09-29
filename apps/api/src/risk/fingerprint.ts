import { createHash } from "node:crypto"

/**
 * Content fingerprints and link hosts (#170), computed at accept.
 *
 * ⚠ TWO FINGERPRINTS, BECAUSE A FARM OPERATOR'S FIRST MOVE DEFEATS ONE. An
 * exact hash of the normalised content catches the lazy farm: fifty workspaces
 * sending byte-identical mail. A random token in every message defeats it, so
 * a MinHash signature sits beside it, cut into LSH bands: two messages whose
 * word pairs overlap heavily share at least one band with near certainty, and
 * unrelated mail shares none. `fingerprint_peers` counts both.
 *
 * ⚠ MINHASH, NOT SIMHASH, AND THAT WAS MEASURED. A 64-bit SimHash over an
 * email-sized text put genuine near-duplicates (a name changed, a token
 * appended) 5 to 16 bits apart - so the usual three-bit threshold missed
 * them, and a threshold wide enough to catch them needs bands too narrow to
 * mean anything. MinHash with 8 bands of 4 rows put the same pairs 3 to 5
 * shared bands apart and unrelated mail at 0, for about 0.13 ms per 5 KB
 * message. Band equality is also what an index can serve: the peer query is a
 * GIN overlap, not a pairwise scan, which is what lets it scale.
 *
 * ⚠ NORMALISING IS WHAT MAKES "THE SAME MAIL" MEAN THE SAME MAIL. Digits,
 * query strings, tracking tokens, addresses and whitespace differ per
 * recipient in perfectly ordinary mail; left in, every personalised message
 * would be unique and nothing would ever match.
 *
 * ⚠ AND ONLY THE FINGERPRINTS LEAVE THIS FILE. Neither can be turned back into
 * the email, and nothing here stores content.
 */

/** Below this much normalised text there is nothing distinctive to match. */
export const MIN_FINGERPRINT_CHARS = 60
/** Enough of a body to characterise it; bounded so a huge body costs nothing. */
const MAX_CHARS = 20_000

/** Signature length and banding: 8 bands of 4 rows. See the note above. */
export const MINHASH_K = 32
export const BAND_ROWS = 4
export const BAND_COUNT = MINHASH_K / BAND_ROWS

export interface Fingerprint {
  exact: string
  /** `"<band>:<hash>"`, one per band. Two messages sharing any are near-duplicates. */
  bands: string[]
}

export function normalise(
  subject: string | null | undefined,
  html: string | null | undefined,
  text: string | null | undefined,
): string {
  const body = html ? htmlToText(html) : (text ?? "")
  return `${subject ?? ""}\n${body}`
    .slice(0, MAX_CHARS * 2)
    .toLowerCase()
    .replace(/https?:\/\/([^\s/"'<>?#]+)[^\s"'<>]*/g, "url:$1")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, "@")
    .replace(/[0-9]+/g, "0")
    .replace(/\b[a-z0-9_-]*[0-9][a-z0-9_-]*[a-z][a-z0-9_-]{10,}\b/g, "tok")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS)
}

export function htmlToText(html: string): string {
  return html
    .slice(0, MAX_CHARS * 4)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href\s*=\s*["']?([^"'\s>]+)[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;|&#\d+;/g, " ")
}

export function fingerprint(
  subject: string | null | undefined,
  html: string | null | undefined,
  text: string | null | undefined,
): Fingerprint | null {
  const norm = normalise(subject, html, text)
  if (norm.length < MIN_FINGERPRINT_CHARS) return null
  const exact = createHash("sha256").update(norm).digest("hex").slice(0, 32)
  return { exact, bands: lshBands(minhash(norm)) }
}

/**
 * The MinHash signature of a text's word pairs.
 *
 * ⚠ EVERY STEP IS FORCED UNSIGNED (`>>> 0`). JavaScript's bitwise operators
 * return SIGNED 32-bit integers; a minimum taken across signed and unsigned
 * values silently orders them wrong, and the first version of this function
 * reported two identical-but-for-a-name emails as 6% similar because of it.
 */
const MULT = Array.from(
  { length: MINHASH_K },
  (_, i) => (Math.imul(i + 1, 0x9e3779b1) | 1) >>> 0,
)
const ADD = Array.from(
  { length: MINHASH_K },
  (_, i) => Math.imul(i + 7, 0x85ebca6b) >>> 0,
)

export function minhash(norm: string): number[] {
  const words = norm.split(" ").filter(Boolean)
  const features = new Set<number>()
  for (let i = 0; i < words.length; i++)
    features.add(fnv32(`${words[i]} ${words[i + 1] ?? ""}`))
  const sig = new Array<number>(MINHASH_K).fill(0xffffffff)
  for (const f of features) {
    for (let k = 0; k < MINHASH_K; k++) {
      let h = (Math.imul(MULT[k]!, f) + ADD[k]!) >>> 0
      h = (h ^ (h >>> 15)) >>> 0
      h = Math.imul(h, 0x2c1b3c6d) >>> 0
      h = (h ^ (h >>> 12)) >>> 0
      if (h < sig[k]!) sig[k] = h
    }
  }
  return sig
}

export function lshBands(sig: readonly number[]): string[] {
  const out: string[] = []
  for (let b = 0; b < BAND_COUNT; b++) {
    out.push(
      `${b}:${fnv32(sig.slice(b * BAND_ROWS, (b + 1) * BAND_ROWS).join(",")).toString(16)}`,
    )
  }
  return out
}

/** The share of signature slots two texts agree on: an estimate of their Jaccard similarity. */
export function similarity(a: readonly number[], b: readonly number[]): number {
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return a.length ? same / a.length : 0
}

function fnv32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The hostnames a message links to.
 *
 * ⚠ HOSTS, NEVER URLS. A URL routinely carries a recipient's token or address;
 * a reputation lookup needs only the host, so nothing else is kept.
 */
export function linkHosts(
  html: string | null | undefined,
  text: string | null | undefined,
  limit = 50,
): string[] {
  const source = `${html ?? ""}\n${text ?? ""}`.slice(0, MAX_CHARS * 4)
  const hosts = new Set<string>()
  for (const m of source.matchAll(
    /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[:/?#"'\s<>]|$)/gi,
  )) {
    const host = m[1]!.toLowerCase().replace(/\.$/, "")
    if (host.length <= 253) hosts.add(host)
    if (hosts.size >= limit) break
  }
  return [...hosts]
}

/**
 * Content every developer sends while trying the product: our own docs'
 * examples. ⚠ ALLOWLISTED, OR EVERY NEW WORKSPACE WOULD LOOK LIKE A FARM MEMBER
 * ON ITS FIRST DAY - they all paste the same snippet.
 */
const EXAMPLES: readonly [string, string][] = [
  ["Hello World", "<strong>It works!</strong> Your first email sent with i10."],
  ["hello world", "Congrats on sending your first email!"],
  ["Welcome", "<p>Thanks for signing up. We're glad to have you.</p>"],
]
export const ALLOWLISTED = new Set(
  EXAMPLES.map(([s, h]) =>
    createHash("sha256")
      .update(normalise(s, h, null))
      .digest("hex")
      .slice(0, 32),
  ),
)
