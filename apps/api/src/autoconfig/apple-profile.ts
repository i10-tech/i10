import { createHash } from "node:crypto"

/**
 * Apple configuration profiles (`.mobileconfig`).
 *
 * Apple Mail is the one client that cannot be configured by DNS alone. It reads
 * RFC 6186 SRV records and Thunderbird-style autoconfig, which between them fix
 * the hostnames and ports — but everything past that is a form the user fills
 * in, and every field is a chance to type `i0.tech` instead of `i10.tech`. A
 * configuration profile removes the form: the account arrives complete and the
 * only thing anyone types is the password.
 *
 * It is also the ONLY route by which Apple Mail would ever speak OAuth to us. A
 * hand-added generic IMAP account in Apple Mail offers password authentication
 * and nothing else; `EmailAccountType` and the OAuth keys are only reachable
 * through a profile. That is not built here — it is the reason this file exists
 * as a seam rather than a string constant.
 *
 * Format: an XML property list. Apple's reference is "Configuration Profile
 * Reference", payload type `com.apple.mail.managed`.
 */

export interface MailAccount {
  /** The full address. It is both the account identity and the IMAP username. */
  email: string
  /** Shown in the account list. Defaults to the address. */
  displayName?: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  /** Shown to the user while they decide whether to trust the profile. */
  organization: string
}

/**
 * ⚠ THE PROFILE CARRIES NO PASSWORD, AND MUST NOT.
 *
 * The payload format has a `Password` key and it is tempting: filling it in
 * makes installation a single tap with nothing typed. It also writes a working
 * mailbox credential into a file that lands in ~/Downloads, survives in the
 * browser cache, and gets forwarded to colleagues by anyone who found it
 * useful. Left out, iOS and macOS prompt for it at install time and store it in
 * the keychain, which is where it belongs.
 *
 * Consequences of that choice, both intended: the endpoint that serves this
 * needs no authentication, because the profile is not a secret; and it can be
 * generated for an address whose mailbox does not exist yet, which is exactly
 * what onboarding wants.
 */
export function buildMobileConfig(account: MailAccount): string {
  const {
    email,
    displayName = email,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    organization,
  } = account

  // ⚠ DETERMINISTIC, NOT RANDOM, AND THIS IS THE WHOLE REINSTALL STORY. iOS
  // keys an installed profile by PayloadIdentifier + PayloadUUID. Matching
  // values REPLACE the existing profile; different ones ADD a second account
  // beside the first, and the user ends up with two copies of their mailbox and
  // no way to tell which is which. Deriving both from the address means
  // downloading the profile again is a repair, not a duplicate.
  const identifier = `tech.i10.mail.${slug(email)}`
  const profileUuid = uuidFrom(identifier)
  const payloadUuid = uuidFrom(`${identifier}.imap`)

  const mailPayload: PlistDict = {
    PayloadType: "com.apple.mail.managed",
    PayloadVersion: 1,
    PayloadIdentifier: `${identifier}.imap`,
    PayloadUUID: payloadUuid,
    PayloadDisplayName: displayName,
    PayloadOrganization: organization,

    // The only other value is EmailTypePOP. i10 does not serve POP3, and a
    // profile that names it produces an account that fails at first sync.
    EmailAccountType: "EmailTypeIMAP",
    EmailAccountName: displayName,
    EmailAccountDescription: email,
    EmailAddress: email,

    // ⚠ UseSSL TRUE IS NOT AN OPINION ON 993 AND 465. Both are implicit-TLS
    // ports: the handshake happens before the protocol says a word. With
    // UseSSL false, Apple Mail connects in the clear and waits for a STARTTLS
    // banner that never comes, and the user is told the server "does not
    // support SSL" — which is the exact wrong diagnosis.
    IncomingMailServerHostName: imapHost,
    IncomingMailServerPortNumber: imapPort,
    IncomingMailServerUseSSL: true,
    IncomingMailServerAuthentication: "EmailAuthPassword",
    IncomingMailServerUsername: email,

    OutgoingMailServerHostName: smtpHost,
    OutgoingMailServerPortNumber: smtpPort,
    OutgoingMailServerUseSSL: true,
    OutgoingMailServerAuthentication: "EmailAuthPassword",
    OutgoingMailServerUsername: email,

    // One email, one password — the rule the whole identity bridge exists to
    // hold. Telling Apple the two credentials are the same is what stops it
    // prompting twice and inviting the user to invent a second one.
    OutgoingPasswordSameAsIncoming: true,
  }

  const profile: PlistDict = {
    PayloadType: "Configuration",
    PayloadVersion: 1,
    PayloadIdentifier: identifier,
    PayloadUUID: profileUuid,
    PayloadDisplayName: `${organization} Mail (${email})`,
    PayloadDescription: `Configures ${email} for Mail on this device.`,
    PayloadOrganization: organization,
    // Removable. A mail account the user cannot delete from their own phone is
    // a thing an employer installs, not a thing a provider offers.
    PayloadRemovalDisallowed: false,
    PayloadContent: [mailPayload],
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(profile, 0),
    "</plist>",
    "",
  ].join("\n")
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * ⚠ THE ADDRESS ARRIVES IN A QUERY STRING. Interpolating it into a response
 * header unfiltered is header injection: a CR or LF ends the header and starts
 * whatever the caller wrote next. Everything outside the allow-list becomes a
 * hyphen, so there is nothing left to inject with.
 */
export function profileFilename(email: string): string {
  return `i10-${slug(email)}.mobileconfig`
}

function slug(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * A UUID derived from a string, formatted as a v4 so Apple's parser accepts it.
 *
 * Not RFC 4122 v5 — that would need a namespace UUID and buy nothing, because
 * nothing outside this file ever compares these against another producer's.
 * What matters is only that the same address yields the same UUID forever.
 */
function uuidFrom(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex")
  const version = `4${h.slice(13, 16)}`
  // The variant nibble must be 8, 9, a or b.
  const variant = `${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}`
  return [h.slice(0, 8), h.slice(8, 12), version, variant, h.slice(20, 32)].join("-")
}

// ── the smallest plist writer that is correct ────────────────────────────────
//
// A dependency for this would be a dependency for four value types. What it
// must get right is escaping: the address is caller-supplied and goes into
// element content, so `&` and `<` have to become entities or the profile is
// malformed and Apple rejects it with no explanation at all.

type PlistValue = string | number | boolean | PlistDict | PlistValue[]
interface PlistDict {
  [key: string]: PlistValue
}

function plistValue(value: PlistValue, depth: number): string {
  const pad = "\t".repeat(depth)

  if (Array.isArray(value)) {
    const items = value.map((v) => plistValue(v, depth + 1)).join("\n")
    return `${pad}<array>\n${items}\n${pad}</array>`
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
