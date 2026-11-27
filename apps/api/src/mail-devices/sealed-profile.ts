import { createHash } from "node:crypto"
import { encryptCmsEnvelopedData, type CmsRecipient } from "./cms.js"
import type { MailDevicePlatform } from "./store.js"

/**
 * Sealed Apple configuration profile builder (#383 PR 4,
 * docs/research/mail-device-binding.md section 12, Review 1 rules M1 & M3).
 *
 * Separate from `autoconfig/apple-profile.ts`'s passwordless builder:
 *   - Identifiers and UUIDs are derived from the **device row id**
 *     (`tech.i10.mail-device.<deviceId>`), so re-enrolling adds a profile
 *     beside the old one instead of overwriting it (needed for Mac renewal).
 *   - Carries the minted device code in `IncomingPassword` and
 *     `OutgoingPassword` with `OutgoingPasswordSameAsIncomingPassword: true`.
 *   - For `macos`, adds the hardware-bound `com.apple.security.acme` payload
 *     with CN = serial and OU = ACME permit nonce. Never added for iPhone/iPad.
 *   - Encrypts the inner `<array>` plist to the device's phase 4 SCEP
 *     certificate as CMS EnvelopedData (AES-256-CBC, RSA PKCS#1 v1.5) inside
 *     `EncryptedPayloadContent`, with `PayloadScope` = `System` for iPhone and
 *     iPad and `User` for a Mac.
 */

export const DEFAULT_ACME_DIRECTORY_URL = "https://ca.i10.tech/acme/apple/directory"

export interface SealedProfileInput {
  deviceId: string
  email: string
  displayName?: string
  platform: MailDevicePlatform
  serial: string
  /** The minted device code, sealed into the encrypted payload and never logged. */
  deviceCode: string
  /** Required for `macos`: the ACME permit's per-permit OU nonce. */
  acmeNonce?: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  organization: string
  acmeDirectoryUrl?: string
}

/** Deterministic v4-shaped UUID from a seed, matching Apple's parser requirements. */
function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex")
  const version = `4${h.slice(13, 16)}`
  const variant = `${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}`
  return [h.slice(0, 8), h.slice(8, 12), version, variant, h.slice(20, 32)].join("-")
}

/**
 * Builds the inner XML plist (`<array>` of payload dicts) encrypted inside
 * `EncryptedPayloadContent`. Exported for unit testing.
 */
export function buildInnerPayloadsPlist(input: SealedProfileInput): string {
  const identifier = `tech.i10.mail-device.${input.deviceId}`
  const displayName = input.displayName ?? input.email
  const mailIdentifier = `${identifier}.mail`

  const mailPayload: PlistDict = {
    PayloadType: "com.apple.mail.managed",
    PayloadVersion: 1,
    PayloadIdentifier: mailIdentifier,
    PayloadUUID: uuidFrom(mailIdentifier),
    PayloadDisplayName: displayName,
    PayloadOrganization: input.organization,

    EmailAccountType: "EmailTypeIMAP",
    EmailAccountName: displayName,
    EmailAccountDescription: input.email,
    EmailAddress: input.email,

    IncomingMailServerHostName: input.imapHost,
    IncomingMailServerPortNumber: input.imapPort,
    IncomingMailServerUseSSL: true,
    IncomingMailServerAuthentication: "EmailAuthPassword",
    IncomingMailServerUsername: input.email,
    IncomingPassword: input.deviceCode,

    OutgoingMailServerHostName: input.smtpHost,
    OutgoingMailServerPortNumber: input.smtpPort,
    OutgoingMailServerUseSSL: true,
    OutgoingMailServerAuthentication: "EmailAuthPassword",
    OutgoingMailServerUsername: input.email,
    OutgoingPassword: input.deviceCode,
    OutgoingPasswordSameAsIncomingPassword: true,
  }

  const payloads: PlistValue[] = [mailPayload]

  if (input.platform === "macos") {
    if (!input.acmeNonce) {
      throw new Error("macos sealed profile requires acmeNonce")
    }
    const acmeIdentifier = `${identifier}.acme`
    const acmePayload: PlistDict = {
      PayloadType: "com.apple.security.acme",
      PayloadVersion: 1,
      PayloadIdentifier: acmeIdentifier,
      PayloadUUID: uuidFrom(acmeIdentifier),
      PayloadDisplayName: `${input.organization} Secure Enclave key`,
      PayloadOrganization: input.organization,
      DirectoryURL: input.acmeDirectoryUrl ?? DEFAULT_ACME_DIRECTORY_URL,
      ClientIdentifier: input.serial,
      KeyType: "ECSECPrimeRandom",
      KeySize: 384,
      HardwareBound: true,
      Attest: true,
      // Two single-value RDNs: CN = serial, OU = per-permit nonce.
      Subject: [[["CN", input.serial]], [["OU", input.acmeNonce]]],
      // id-kp-clientAuth
      ExtendedKeyUsage: ["1.3.6.1.5.5.7.3.2"],
    }
    payloads.push(acmePayload)
  }

  return wrapPlist(payloads)
}

/**
 * Builds the complete encrypted `.mobileconfig` profile (UTF-8 XML bytes) with
 * `EncryptedPayloadContent` encrypted to `recipient`.
 */
export function buildSealedMobileConfig(
  input: SealedProfileInput,
  recipient: CmsRecipient,
): Buffer {
  const innerXml = buildInnerPayloadsPlist(input)
  const cmsDer = encryptCmsEnvelopedData(Buffer.from(innerXml, "utf8"), recipient)

  const identifier = `tech.i10.mail-device.${input.deviceId}`
  const scope = input.platform === "macos" ? "User" : "System"

  const outer: PlistDict = {
    PayloadType: "Configuration",
    PayloadVersion: 1,
    PayloadIdentifier: identifier,
    PayloadUUID: uuidFrom(identifier),
    PayloadDisplayName: `${input.organization} Mail (${input.email})`,
    PayloadDescription: `Configures ${input.email} for Mail on this device.`,
    PayloadOrganization: input.organization,
    PayloadRemovalDisallowed: false,
    PayloadScope: scope,
    EncryptedPayloadContent: { kind: "data", bytes: cmsDer },
  }

  return Buffer.from(wrapPlist(outer), "utf8")
}

// ── Minimal XML plist serializer supporting `<data>` ─────────────────────────

interface PlistData {
  kind: "data"
  bytes: Buffer
}

type PlistValue = string | number | boolean | PlistData | PlistDict | PlistValue[]
interface PlistDict {
  [key: string]: PlistValue
}

function isPlistData(value: PlistValue): value is PlistData {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "data" &&
    Buffer.isBuffer(value.bytes)
  )
}

function wrapPlist(root: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(root, 0),
    "</plist>",
    "",
  ].join("\n")
}

function plistValue(value: PlistValue, depth: number): string {
  const pad = "\t".repeat(depth)

  if (Array.isArray(value)) {
    const items = value.map((v) => plistValue(v, depth + 1)).join("\n")
    return `${pad}<array>\n${items}\n${pad}</array>`
  }

  if (isPlistData(value)) {
    return `${pad}<data>${value.bytes.toString("base64")}</data>`
  }

  if (typeof value === "object") {
    const inner = Object.entries(value)
      .map(
        ([k, v]) =>
          `${"\t".repeat(depth + 1)}<key>${escapeXml(k)}</key>\n${plistValue(v, depth + 1)}`,
      )
      .join("\n")
    return `${pad}<dict>\n${inner}\n${pad}</dict>`
  }

  if (typeof value === "boolean") return `${pad}<${value}/>`
  if (typeof value === "number") return `${pad}<integer>${value}</integer>`
  return `${pad}<string>${escapeXml(value)}</string>`
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}
