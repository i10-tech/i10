import { isIP } from "node:net"
import { trustedClientIp } from "./rate-limit.js"

/**
 * Addresses and ranges for the workspace IP allowlist (#345, sso.md 2.11).
 * Pure: no I/O, so the suite drives every rule directly.
 *
 * ⚠ ONE CANONICAL FORM, OR THE LIST DOES NOT MEAN WHAT IT SAYS. The same
 * client reaches us as `203.0.113.7`, as `::ffff:203.0.113.7` (a dual-stack
 * socket) or as `::ffff:cb00:7107`. An IPv4-mapped address is an IPv4 address
 * in every parse here, so an IPv4 range matches it and an IPv6 range never
 * does; a list that missed the mapped form would lock out the very office it
 * names, one that matched it against IPv6 ranges would let a mapped form slip
 * past a range it should not.
 */

export type Family = 4 | 6

export interface Address {
  family: Family
  value: bigint
}

export interface Cidr extends Address {
  prefix: number
}

/** At most this many ranges per workspace (the brief's cap). */
export const MAX_RANGES = 100

const BITS: Record<Family, number> = { 4: 32, 6: 128 }

function parseV4(text: string): bigint | null {
  const parts = text.split(".")
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    // ⚠ NO LEADING ZEROS: `010` is octal to some parsers and decimal to
    // others, and a range must not mean two things.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function parseV6(text: string): bigint | null {
  if (isIP(text) !== 6 || text.includes("%")) return null
  let s = text.toLowerCase()
  const tail = s.slice(s.lastIndexOf(":") + 1)
  if (tail.includes(".")) {
    const v4 = parseV4(tail)
    if (v4 === null) return null
    s = `${s.slice(0, s.lastIndexOf(":") + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = 8 - head.length - rest.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? fill : 0).fill("0"),
    ...rest,
  ]
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) | BigInt(`0x${group}`)
  }
  return value
}

/** An address as text, or null. IPv4-mapped IPv6 is returned as IPv4. */
export function parseAddress(text: string): Address | null {
  if (typeof text !== "string" || text.length > 45) return null
  if (text.includes(":")) {
    const value = parseV6(text)
    if (value === null) return null
    return value >> 32n === 0xffffn
      ? { family: 4, value: value & 0xffffffffn }
      : { family: 6, value }
  }
  const value = parseV4(text)
  return value === null ? null : { family: 4, value }
}

const mask = (family: Family, prefix: number): bigint =>
  prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(BITS[family] - prefix)

/**
 * One range as an admin types it: `203.0.113.0/24`, `2001:db8::/32`, or a bare
 * address (a single host). Host bits are cleared, so `10.0.0.5/24` is
 * `10.0.0.0/24`.
 *
 * ⚠ A /0 IS REFUSED: an allowlist that lets everybody in is a list that
 * silently does nothing, and it is never what the admin meant to type. An
 * IPv4-mapped IPv6 range must be long enough to be a whole IPv4 range.
 */
export function parseCidr(text: string): Cidr | null {
  if (typeof text !== "string" || text.length > 64) return null
  const slash = text.indexOf("/")
  const addressText = slash === -1 ? text : text.slice(0, slash)
  const prefixText = slash === -1 ? null : text.slice(slash + 1)
  if (prefixText !== null && !/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) return null
  const address = parseAddress(addressText.trim())
  if (!address) return null
  const mapped = addressText.includes(":") && address.family === 4
  let prefix = prefixText === null ? BITS[address.family] : Number(prefixText)
  if (mapped && prefixText !== null) {
    if (prefix < 96) return null
    prefix -= 96
  }
  if (prefix < 1 || prefix > BITS[address.family]) return null
  return {
    family: address.family,
    value: address.value & mask(address.family, prefix),
    prefix,
  }
}

function formatV6(value: bigint): string {
  const groups: number[] = []
  for (let i = 7; i >= 0; i -= 1)
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn))
  // The longest run of zero groups (at least two) becomes `::`, the first on a tie.
  let bestStart = -1
  let bestLength = 0
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i += 1
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j += 1
    if (j - i > bestLength) {
      bestStart = i
      bestLength = j - i
    }
    i = j
  }
  const hex = (g: number) => g.toString(16)
  if (bestLength < 2) return groups.map(hex).join(":")
  const left = groups.slice(0, bestStart).map(hex).join(":")
  const right = groups
    .slice(bestStart + bestLength)
    .map(hex)
    .join(":")
  return `${left}::${right}`
}

/** An address as text, canonical, for the audit log and the lockout grace. */
export function formatAddress(address: Address): string {
  return address.family === 4
    ? [24n, 16n, 8n, 0n].map((s) => String((address.value >> s) & 0xffn)).join(".")
    : formatV6(address.value)
}

/** The text a range is stored and shown as. */
export function formatCidr(cidr: Cidr): string {
  return `${formatAddress(cidr)}/${cidr.prefix}`
}

export type RangesResult =
  | { ok: true; ranges: string[] }
  | { ok: false; error: "too_many" | "invalid"; index?: number }

/**
 * An admin's list, validated and normalised: each range canonical, duplicates
 * dropped, in a stable order (IPv4 first, then by address and length).
 */
export function normaliseRanges(input: readonly unknown[]): RangesResult {
  if (input.length > MAX_RANGES) return { ok: false, error: "too_many" }
  const parsed = new Map<string, Cidr>()
  for (const [index, item] of input.entries()) {
    const cidr = typeof item === "string" ? parseCidr(item.trim()) : null
    if (!cidr) return { ok: false, error: "invalid", index }
    parsed.set(formatCidr(cidr), cidr)
  }
  const ordered = [...parsed.entries()].sort(([, a], [, b]) =>
    a.family !== b.family
      ? a.family - b.family
      : a.value < b.value
        ? -1
        : a.value > b.value
          ? 1
          : a.prefix - b.prefix,
  )
  return { ok: true, ranges: ordered.map(([text]) => text) }
}

/** Whether `address` is inside any of the (already normalised) `ranges`. */
export function inRanges(address: Address, ranges: readonly Cidr[]): boolean {
  return ranges.some(
    (r) =>
      r.family === address.family &&
      (address.value & mask(r.family, r.prefix)) === r.value,
  )
}

/** Stored ranges as `Cidr`s. A stored value that does not parse is dropped, never widened. */
export function readRanges(stored: readonly string[]): Cidr[] {
  return stored.flatMap((text) => {
    const cidr = parseCidr(text)
    return cidr ? [cidr] : []
  })
}

/**
 * The address a request came from, or null when it cannot be known.
 *
 * ⚠ ONLY WHAT THE API ALREADY TRUSTS (`trustedClientIp`): the console's
 * signed context, else Cloudflare's `cf-connecting-ip`. Never
 * `x-forwarded-for` and never the socket (in-cluster it is the console's pod).
 * An address that does not parse is unknown, and unknown is refused under an
 * active allowlist.
 */
export function clientAddress(
  headers: Headers,
  contextSecret: string | undefined,
): Address | null {
  const ip = trustedClientIp(headers, contextSecret)
  return ip ? parseAddress(ip) : null
}
