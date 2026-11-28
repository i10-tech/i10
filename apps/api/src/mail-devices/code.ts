import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { parseKeyEntry, ringEntries } from "./keyring.js"

/**
 * Mail device codes (#383): the secret one enrolled device signs in to IMAP
 * and SMTP with, in place of the person's password.
 *
 *   i10dc1.<device id>.<secret>
 *
 * The device id is the `authd.mail_devices` row's UUID as 32 lowercase hex
 * digits, and the secret is 32 random bytes as 43 characters of unpadded,
 * strict base64url (83 characters in all). Matches
 * `services/authd/internal/devicecode` byte for byte; both languages pin the
 * same `testdata/vectors.json`.
 */

export const DEVICE_CODE_RESERVED_PREFIX = "i10dc"
export const DEVICE_CODE_PREFIX = "i10dc1."
export const DEVICE_ID_LEN = 16
export const DEVICE_ID_HEX_LEN = 32
export const DEVICE_SECRET_LEN = 32
export const DEVICE_SECRET_B64_LEN = 43
export const DEVICE_CODE_LEN =
  DEVICE_CODE_PREFIX.length + DEVICE_ID_HEX_LEN + 1 + DEVICE_SECRET_B64_LEN

/** Domain separator shared with authd's `devicecode.Hash`. */
export const DEVICE_CODE_HASH_LABEL = Buffer.from("i10/mail-device-code/v1\x00", "utf8")

/** Shortest HMAC-SHA256 secret accepted (matches Go `keyring.MinLen`). */
export { MIN_KEY_LEN } from "./keyring.js"

const LOWER_HEX_32 = /^[0-9a-f]{32}$/
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/

export interface MailDeviceCodeKeys {
  /** Every key in `MAIL_DEVICE_CODE_KEYS`, keyed by numeric id (0 to 255). */
  readonly keys: ReadonlyMap<number, Buffer>
  /** Highest key id in the ring: the one `mintCode` hashes under. */
  readonly currentKid: number
}

export interface ParsedDeviceCode {
  /** Dashed lowercase UUID (`8-4-4-4-12`). */
  id: string
  /** 16-byte raw UUID. */
  idBytes: Buffer
  /** 32-byte raw secret. */
  secret: Buffer
}

export interface MintedCode {
  /** The secret handed to the device once, never logged or stored. */
  code: string
  /** Keyed HMAC-SHA256 stored in `authd.mail_devices.code_hash`. */
  codeHash: Buffer
  /** Key id stored in `authd.mail_devices.code_kid`. */
  codeKid: number
}

export type MailDeviceErrorCode =
  | "keys_not_configured"
  | "invalid_platform"
  | "account_not_found"
  | "account_inactive"
  | "tenant_mismatch"
  | "epoch_mismatch"
  | "mailbox_suspended"
  | "mailbox_deleting"
  | "payment_hold"
  | "domain_not_hosted"
  | "account_banned"
  | "account_locked"
  | "sso_required"
  | "managed_no_connection"
  | "connection_inactive"
  // Binding a certificate key and issuing permits (#383 PR 3).
  | "device_not_found"
  | "device_mismatch"
  | "device_not_macos"
  | "device_expired"
  | "device_serial_missing"
  | "serial_mismatch"
  | "device_key_bound"
  | "device_key_changed"
  | "key_in_use"
  | "permit_conflict"
  // Enrollment gate checks (#383 PR 4).
  | "email_mismatch"

export class MailDeviceError extends Error {
  constructor(
    readonly code: MailDeviceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "MailDeviceError"
  }
}

/**
 * Parses `MAIL_DEVICE_CODE_KEYS`: `<id>:<base64 >= 32 bytes>`, comma-separated.
 *
 * Errors never quote the input or secret: a reversed `<secret>:<id>` entry
 * would otherwise leak the key into logs.
 */
export function parseMailDeviceCodeKeys(
  raw: string,
  name = "MAIL_DEVICE_CODE_KEYS",
): MailDeviceCodeKeys {
  const keys = new Map<number, Buffer>()
  let highest = -1

  for (const entry of ringEntries(raw)) {
    const { id: kid, secret } = parseKeyEntry(name, entry)
    if (keys.has(kid)) {
      throw new Error(`${name}: key id ${kid} appears twice`)
    }
    keys.set(kid, secret)
    if (kid > highest) highest = kid
  }

  if (keys.size === 0) {
    throw new Error(`${name}: no key configured`)
  }
  return { keys, currentKid: highest }
}

/** Converts a dashed or compact UUID into its 16 raw bytes. */
export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "").toLowerCase()
  if (!LOWER_HEX_32.test(hex)) {
    throw new Error("invalid device UUID")
  }
  return Buffer.from(hex, "hex")
}

/** Formats 16 raw UUID bytes as `8-4-4-4-12` lowercase text. */
export function bytesToUuid(bytes: Buffer): string {
  if (bytes.byteLength !== DEVICE_ID_LEN) {
    throw new Error("invalid device UUID bytes")
  }
  const h = bytes.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** Reports whether a password belongs to the reserved device-code lane. */
export const hasReservedPrefix = (password: string): boolean =>
  password.startsWith(DEVICE_CODE_RESERVED_PREFIX)

/** Encodes a device id and 32-byte secret in the one canonical `i10dc1.` spelling. */
export function formatDeviceCode(id: string | Buffer, secret: Buffer): string {
  const idBytes = typeof id === "string" ? uuidToBytes(id) : id
  if (idBytes.byteLength !== DEVICE_ID_LEN) {
    throw new Error("device id must be 16 bytes")
  }
  if (secret.byteLength !== DEVICE_SECRET_LEN) {
    throw new Error("device secret must be 32 bytes")
  }
  return `${DEVICE_CODE_PREFIX}${idBytes.toString("hex")}.${secret.toString("base64url")}`
}

/**
 * Parses a device code strictly (exact length, lowercase hex, unpadded
 * base64url with zero trailing bits), or returns null.
 */
export function parseDeviceCode(input: string): ParsedDeviceCode | null {
  if (input.length !== DEVICE_CODE_LEN || !input.startsWith(DEVICE_CODE_PREFIX)) {
    return null
  }
  const rest = input.slice(DEVICE_CODE_PREFIX.length)
  if (rest[DEVICE_ID_HEX_LEN] !== ".") return null
  const idHex = rest.slice(0, DEVICE_ID_HEX_LEN)
  const secretB64 = rest.slice(DEVICE_ID_HEX_LEN + 1)
  if (!LOWER_HEX_32.test(idHex) || !BASE64URL_43.test(secretB64)) return null

  const secret = Buffer.from(secretB64, "base64url")
  // Enforce canonical encoding so the 2 unused bits past byte 32 must be zero.
  if (
    secret.byteLength !== DEVICE_SECRET_LEN ||
    secret.toString("base64url") !== secretB64
  ) {
    return null
  }
  const idBytes = Buffer.from(idHex, "hex")
  return { id: bytesToUuid(idBytes), idBytes, secret }
}

/**
 * Computes `authd.mail_devices.code_hash`:
 *   HMAC-SHA256(key, "i10/mail-device-code/v1" 0x00 | 16-byte id | 32-byte secret)
 */
export function hashDeviceCode(key: Buffer, idBytes: Buffer, secret: Buffer): Buffer {
  if (idBytes.byteLength !== DEVICE_ID_LEN) {
    throw new Error("device id must be 16 bytes")
  }
  if (secret.byteLength !== DEVICE_SECRET_LEN) {
    throw new Error("device secret must be 32 bytes")
  }
  return createHmac("sha256", key)
    .update(DEVICE_CODE_HASH_LABEL)
    .update(idBytes)
    .update(secret)
    .digest()
}

/** Constant-time verification matching Go `devicecode.Matches`. */
export function matchesDeviceCode(
  key: Buffer,
  parsed: ParsedDeviceCode,
  stored: Buffer,
): boolean {
  const expected = hashDeviceCode(key, parsed.idBytes, parsed.secret)
  return expected.byteLength === stored.byteLength && timingSafeEqual(expected, stored)
}

/**
 * Mints a device code and its keyed hash under the highest key id in `keys`.
 *
 * Refuses with a typed error when `keys` is absent, never returning a code.
 */
export function mintCode(
  keys: MailDeviceCodeKeys | null | undefined,
  deviceId: string,
  secret?: Buffer,
): MintedCode {
  if (!keys) {
    throw new MailDeviceError(
      "keys_not_configured",
      "MAIL_DEVICE_CODE_KEYS is not configured.",
    )
  }
  const key = keys.keys.get(keys.currentKid)
  if (!key) {
    throw new MailDeviceError(
      "keys_not_configured",
      "MAIL_DEVICE_CODE_KEYS has no active signing key.",
    )
  }
  const idBytes = uuidToBytes(deviceId)
  const secretBytes = secret ?? randomBytes(DEVICE_SECRET_LEN)
  const code = formatDeviceCode(idBytes, secretBytes)
  const codeHash = hashDeviceCode(key, idBytes, secretBytes)
  return { code, codeHash, codeKid: keys.currentKid }
}
