import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { parseKeyEntry, ringEntries } from "./keyring.js"

/**
 * Signed edge enrollment link tokens (docs/research/enrollment-at-scale.md).
 *
 * Wire format: `v1.<32-hex-eid>.<minimal-hex-exp>.<23-b64url-kid+mac>` (~68 chars).
 * Shared byte-for-byte with `services/authd/internal/enrolltoken` (verified
 * against `services/authd/internal/enrolltoken/testdata/vectors.json`).
 *
 * Key rotation: `ENROLL_EDGE_HMAC_KEY` is a comma-separated list of
 * `<id>:<base64 >= 32 bytes>` entries (id 0..255). Signing uses the FIRST key
 * in the list; verification accepts every key in the list.
 */

export const LINK_TOKEN_VERSION = "v1"
const LINK_MAC_LABEL = Buffer.from("i10/enroll-edge-link/v1\0", "utf8")
const LINK_MAC_BYTES = 16 // 128-bit truncated HMAC-SHA256
const LINK_PAYLOAD_BYTES = 1 + LINK_MAC_BYTES
const LINK_MAC_B64_LEN = 23

const UUID_RE =
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i
const LOWER_HEX_RE = /^[0-9a-f]+$/

export interface EdgeLinkKeyEntry {
  readonly id: number
  readonly secret: Buffer
}

export interface EdgeLinkKeyRing {
  /** Active signing key (first entry in ENROLL_EDGE_HMAC_KEY). */
  readonly signingKey: EdgeLinkKeyEntry
  /** All accepted verification keys, keyed by 1-byte id. */
  readonly byId: ReadonlyMap<number, Buffer>
}

export interface VerifiedEdgeLink {
  enrollmentId: string
  expiresAt: Date
  keyId: number
}

/**
 * Parses `ENROLL_EDGE_HMAC_KEY` (`<id>:<base64 >= 32 bytes>`, comma-separated),
 * each entry exactly as Go's `keyring.ParseKey` does (keyring.ts). Preserves
 * order so the first entry is the active signing key. Never quotes secret
 * bytes in any thrown error message.
 */
export function parseEdgeLinkKeys(raw: string): EdgeLinkKeyRing {
  const parts = ringEntries(raw)
  if (parts.length === 0) {
    throw new Error("ENROLL_EDGE_HMAC_KEY must list at least one <id>:<base64> key")
  }
  const byId = new Map<number, Buffer>()
  let first: EdgeLinkKeyEntry | null = null

  for (const entry of parts) {
    const { id, secret } = parseKeyEntry("ENROLL_EDGE_HMAC_KEY", entry)
    if (byId.has(id)) {
      throw new Error(`ENROLL_EDGE_HMAC_KEY key id ${id} appears twice`)
    }
    byId.set(id, secret)
    if (!first) {
      first = { id, secret }
    }
  }

  return { signingKey: first!, byId }
}

/** Generates an RFC 9562 UUIDv7 in canonical lowercase string form. */
export function newUuidV7(now: Date = new Date()): string {
  const b = randomBytes(16)
  const ms = BigInt(now.getTime())
  b[0] = Number((ms >> 40n) & 0xffn)
  b[1] = Number((ms >> 32n) & 0xffn)
  b[2] = Number((ms >> 24n) & 0xffn)
  b[3] = Number((ms >> 16n) & 0xffn)
  b[4] = Number((ms >> 8n) & 0xffn)
  b[5] = Number(ms & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70 // version 7
  b[8] = (b[8]! & 0x3f) | 0x80 // RFC 4122 variant
  return formatUuid(b)
}

function parseUuidBytes(uuid: string): Buffer {
  const m = UUID_RE.exec(uuid)
  if (!m) throw new Error("invalid UUID")
  return Buffer.from(`${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`.toLowerCase(), "hex")
}

function formatUuid(bytes: Buffer): string {
  const h = bytes.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function computeLinkMac(
  secret: Buffer,
  kid: number,
  eidBytes: Buffer,
  expSec: bigint,
): Buffer {
  const expBuf = Buffer.alloc(8)
  expBuf.writeBigUInt64BE(expSec, 0)
  const h = createHmac("sha256", secret)
  h.update(LINK_MAC_LABEL)
  h.update(Buffer.from([kid]))
  h.update(eidBytes)
  h.update(expBuf)
  return h.digest().subarray(0, LINK_MAC_BYTES)
}

/**
 * Signs an edge link token under the ring's active signing key (first entry).
 */
export function signEdgeLinkToken(
  ring: EdgeLinkKeyRing,
  enrollmentId: string,
  expiresAt: Date,
): string {
  const eidBytes = parseUuidBytes(enrollmentId)
  const expSec = Math.floor(expiresAt.getTime() / 1000)
  if (!Number.isFinite(expSec) || expSec <= 0) {
    throw new Error("edge link expiry must be positive")
  }
  const { id, secret } = ring.signingKey
  const mac = computeLinkMac(secret, id, eidBytes, BigInt(expSec))
  const payload = Buffer.concat([Buffer.from([id]), mac])
  const eidHex = eidBytes.toString("hex")
  const expHex = expSec.toString(16)
  const macB64 = payload.toString("base64url")
  return `${LINK_TOKEN_VERSION}.${eidHex}.${expHex}.${macB64}`
}

/**
 * Verifies an edge link token's format, canonical base64url encoding,
 * constant-time HMAC-SHA256, and expiry against `now`. Returns null on any
 * invalidity or expiry.
 */
export function verifyEdgeLinkToken(
  ring: EdgeLinkKeyRing,
  token: string,
  now: Date = new Date(),
): VerifiedEdgeLink | null {
  if (token.length < 40 || token.length > 128) return null
  const parts = token.split(".")
  if (parts.length !== 4) return null
  const [ver, eidHex, expHex, macB64] = parts as [string, string, string, string]
  if (
    ver !== LINK_TOKEN_VERSION ||
    eidHex.length !== 32 ||
    expHex.length === 0 ||
    expHex.length > 16 ||
    macB64.length !== LINK_MAC_B64_LEN
  ) {
    return null
  }
  if (!LOWER_HEX_RE.test(eidHex) || !LOWER_HEX_RE.test(expHex)) return null
  if (expHex.length > 1 && expHex.startsWith("0")) return null

  let expSec: bigint
  try {
    expSec = BigInt(`0x${expHex}`)
  } catch {
    return null
  }
  if (expSec <= 0n || expSec > 0x7fffffffffffffffn) return null

  const rawMac = Buffer.from(macB64, "base64url")
  if (rawMac.length !== LINK_PAYLOAD_BYTES) return null
  // Reject non-canonical trailing bits or padding.
  if (rawMac.toString("base64url") !== macB64) return null

  const kid = rawMac[0]!
  const secret = ring.byId.get(kid)
  if (!secret) return null

  const eidBytes = Buffer.from(eidHex, "hex")
  const expected = computeLinkMac(secret, kid, eidBytes, expSec)
  const got = rawMac.subarray(1)
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return null
  }

  const nowSec = BigInt(Math.floor(now.getTime() / 1000))
  if (nowSec > expSec) return null

  return {
    enrollmentId: formatUuid(eidBytes),
    expiresAt: new Date(Number(expSec) * 1000),
    keyId: kid,
  }
}
