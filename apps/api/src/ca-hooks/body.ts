import { createPublicKey, X509Certificate } from "node:crypto"
import { z } from "zod"
import { sha256 } from "../mail-devices/permits.js"

/**
 * The webhook bodies step-ca v0.30.2 sends, and the checks the device CA's
 * templates must pass (#383 PR 3, docs/research/mail-device-binding.md
 * section 11). Pure: no database, no clock but the `now` it is given.
 *
 * Field names are read from the source, never assumed:
 *   - `webhook/types.go` `RequestBody`, `X509Certificate`, `X509CertificateRequest`
 *   - go.step.sm/crypto v0.77.1 `x509util.Certificate` and `CertificateRequest`
 *     (`extKeyUsage` as names such as "clientAuth", `sans` as {type, value},
 *     `[]byte` fields as standard base64)
 *   - `webhook/options.go` `WithX509Certificate`: `notBefore`, `notAfter` and
 *     `publicKey` come from the leaf about to be signed; the rest is the
 *     rendered template (`authority/tls.go`, before step-ca's own modifiers)
 *   - `authority/provisioner/scep.go`: `SCEPCHALLENGE` adds `scepChallenge` and
 *     `scepTransactionID`; a `NOTIFYING` success carries the certificate's DER in
 *     `x509Certificate.raw`; a failure has no `x509Certificate` at all
 */

const STD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const GO_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
/** Apple serials are short and plain; anything else is not one. */
const SERIAL = /^[\x21-\x7e]{1,64}$/

/** A Go `time.Time` as `encoding/json` writes it (RFC 3339, up to nanoseconds). */
export function parseGoTime(value: string): Date | null {
  const match = GO_TIME.exec(value)
  if (!match) return null
  const [, base, fraction = "", zone] = match
  const at = new Date(`${base}${fraction.slice(0, 4)}${zone}`)
  return Number.isNaN(at.getTime()) ? null : at
}

const base64Bytes = z
  .string()
  .regex(STD_BASE64)
  .transform((value) => Buffer.from(value, "base64"))
const goTime = z.string().transform((value, ctx) => {
  const at = parseGoTime(value)
  if (!at) {
    ctx.addIssue({ code: "custom", message: "not a time" })
    return z.NEVER
  }
  return at
})
const names = z.array(z.string()).nullish()

/**
 * A CSR's subject, as the device sent it. Lenient: a CSR is never signed as
 * it stands, only read for its CN and key.
 */
const requestSubject = z
  .object({
    commonName: z.string().optional(),
  })
  .nullish()

/**
 * A rendered template's subject. ⚠ STRICT: x509util writes every other field
 * with `omitempty` (`x509util/name.go`), so our templates never send one, and
 * `extraNames` (whose `2.5.4.3` would replace the CN) is refused.
 */
const templateSubject = z
  .object({
    commonName: z.string().optional(),
    organizationalUnit: names,
  })
  .strict()
  .nullish()

/** A value our templates never set: null, absent, or empty. */
const unset = z
  .union([z.null(), z.literal(""), z.array(z.unknown()).length(0)])
  .optional()

/**
 * `x509util.Certificate` v0.77.1 (`x509util/certificate.go`) plus the leaf's
 * validity and key (`webhook.X509Certificate`): the AUTHORIZING body.
 *
 * ⚠ STRICT, OVER EXACTLY THOSE FIELDS: an unknown key is refused rather than
 * dropped, so nothing that changes the signed certificate can pass unread.
 * `version`, `issuer` and `publicKeyAlgorithm` are accepted as they come:
 * `Certificate.GetCertificate` never copies them into the leaf.
 */
const certificateTemplate = z
  .object({
    version: z.number().optional(),
    subject: templateSubject,
    rawSubject: z.string().nullish(),
    issuer: z.unknown().optional(),
    serialNumber: unset,
    dnsNames: names,
    emailAddresses: names,
    ipAddresses: names,
    uris: names,
    // ⚠ STRICT: `asn1Value` overrides `value` when the SAN is encoded.
    sans: z.array(z.object({ type: z.string(), value: z.string() }).strict()).nullish(),
    extensions: z
      .array(
        z
          .object({ id: z.string(), critical: z.boolean(), value: base64Bytes })
          .strict(),
      )
      .nullish(),
    keyUsage: names,
    extKeyUsage: names,
    unknownExtKeyUsage: names,
    subjectKeyId: unset,
    authorityKeyId: unset,
    ocspServer: unset,
    issuingCertificateURL: unset,
    crlDistributionPoints: unset,
    policyIdentifiers: unset,
    basicConstraints: z.object({ isCA: z.boolean() }).nullish(),
    nameConstraints: z.unknown().nullish(),
    signatureAlgorithm: z.literal("").optional(),
    publicKey: base64Bytes,
    publicKeyAlgorithm: z.string().optional(),
    notBefore: goTime,
    notAfter: goTime,
    raw: z.null().optional(),
  })
  .strict()
export type CertificateTemplate = z.infer<typeof certificateTemplate>

const envelope = z.object({ timestamp: goTime })

export const acmeAuthorizeBody = envelope.extend({
  attestationData: z.object({ permanentIdentifier: z.string() }),
  x509Certificate: certificateTemplate,
})

export const scepChallengeBody = envelope.extend({
  scepChallenge: z.string().min(1).max(255),
  scepTransactionID: z.string().min(1).max(255),
  x509CertificateRequest: z.object({ subject: requestSubject, publicKey: base64Bytes }),
})

export const scepAuthorizeBody = envelope.extend({
  x509Certificate: certificateTemplate,
})

/** Success has `x509Certificate.raw`; a `NotifyFailure` has no certificate. */
export const scepNotifyBody = envelope.extend({
  scepTransactionID: z.string().min(1).max(255),
  x509Certificate: z.object({ raw: base64Bytes.nullish() }).nullish(),
})

/** The body's `timestamp`, or null when there is none to trust. */
export function bodyTimestamp(body: unknown): Date | null {
  const parsed = envelope.safeParse(body)
  return parsed.success ? parsed.data.timestamp : null
}

/**
 * SHA-256 of a SubjectPublicKeyInfo DER, or null when the bytes are not one.
 * The bytes hashed are the ones step-ca sent (`x509.MarshalPKIXPublicKey` of
 * the leaf's key, the same DER the certificate carries), parsed only to refuse
 * anything that is not a key.
 */
export function spkiSha256(der: Buffer): Buffer | null {
  try {
    createPublicKey({ key: der, format: "der", type: "spki" })
  } catch {
    return null
  }
  return sha256(der)
}

/** The issued certificate's own key and hash, from its DER, or null. */
export function issuedCertificate(
  der: Buffer,
): { keySha256: Buffer; certSha256: Buffer } | null {
  try {
    const cert = new X509Certificate(der)
    const spki = cert.publicKey.export({ type: "spki", format: "der" })
    return { keySha256: sha256(spki), certSha256: sha256(der) }
  } catch {
    return null
  }
}

export const SKEW_MS = 5 * 60 * 1000

export interface TemplateRules {
  /** The serial the subject CN must equal (and a permanent identifier SAN, when allowed). */
  serial: string
  /** The exact key usage list, as x509util names them (order does not matter). */
  keyUsage: readonly string[]
  /** The exact EKU list, as step-ca names them. */
  extKeyUsage: readonly string[]
  /** ACME only: the `device-attest-01` permanent identifier SAN. */
  permanentIdentifierSan: boolean
  /** The latest `notAfter` this kind of certificate may have, from `now`. */
  maxNotAfter: Date
  intermediateNotAfter: Date
  now: Date
}

const isEmpty = (list: readonly unknown[] | null | undefined) =>
  !list || list.length === 0

/** The same names in any order; null or absent is the empty list. */
function sameNames(
  got: readonly string[] | null | undefined,
  wanted: readonly string[],
) {
  const a = [...(got ?? [])].sort()
  const b = [...wanted].sort()
  return a.length === b.length && a.every((name, i) => name === b[i])
}

const SUBJECT_ALT_NAME = "2.5.29.17"

/** DER with a short-form length: a bounded serial never needs a longer one. */
function der(tag: number, content: Buffer): Buffer {
  if (content.length > 127) throw new Error("content too long for a short length")
  return Buffer.concat([Buffer.from([tag, content.length]), content])
}

/** `1.3.6.1.5.5.7.8.3`, `id-on-permanentIdentifier` (RFC 4043). */
const PERMANENT_IDENTIFIER_OID = Buffer.from("06082b06010505070803", "hex")

/**
 * The subjectAltName extension value x509util v0.77.1 writes for one
 * `permanentIdentifier` SAN (`createSubjectAltNameExtension`, `marshalOtherName`):
 * `SEQUENCE { [0] { OID, [0] { SEQUENCE { UTF8String serial } } } }`.
 */
export function permanentIdentifierSanDer(serial: string): Buffer {
  const identifier = der(0x30, der(0x0c, Buffer.from(serial, "utf8")))
  const otherName = der(
    0xa0,
    Buffer.concat([PERMANENT_IDENTIFIER_OID, der(0xa0, identifier)]),
  )
  return der(0x30, otherName)
}

/**
 * Whether `extensions` is exactly what x509util adds by itself for the checked
 * `sans`, and nothing else.
 *
 * ⚠ A TEMPLATE MAY ADD NO EXTENSION. The one a rendered template carries is
 * the subjectAltName x509util encodes for a `permanentIdentifier` SAN
 * (`newCertificateWithOptions`, because Go's library cannot), and the signed
 * certificate then takes its names from that extension and not from `sans`
 * (`GetCertificate`). So its bytes are compared with our own encoding of the
 * serial, never just its id.
 */
function extensionsAllowed(cert: CertificateTemplate, serial: string): boolean {
  const extensions = cert.extensions ?? []
  if (isEmpty(cert.sans)) return extensions.length === 0
  const [only] = extensions
  return (
    extensions.length === 1 &&
    only !== undefined &&
    only.id === SUBJECT_ALT_NAME &&
    !only.critical &&
    only.value.equals(permanentIdentifierSanDer(serial))
  )
}

/**
 * Why a rendered template may not be signed, or null when it may. A fixed
 * word, never a value from the body.
 */
export function templateRefusal(
  cert: CertificateTemplate,
  rules: TemplateRules,
): string | null {
  if (!SERIAL.test(rules.serial)) return "serial"
  // `rawSubject` replaces `subject` in the signed certificate, so a template
  // that sets it could put any name past the CN check.
  if (cert.rawSubject) return "raw_subject"
  if (cert.subject?.commonName !== rules.serial) return "common_name"
  if (
    !isEmpty(cert.dnsNames) ||
    !isEmpty(cert.emailAddresses) ||
    !isEmpty(cert.ipAddresses) ||
    !isEmpty(cert.uris)
  ) {
    return "names"
  }
  const sans = cert.sans ?? []
  if (sans.length > 1) return "sans"
  for (const san of sans) {
    const allowed =
      rules.permanentIdentifierSan &&
      san.type === "permanentIdentifier" &&
      san.value === rules.serial
    if (!allowed) return "sans"
  }
  if (!extensionsAllowed(cert, rules.serial)) return "extension"
  if (!sameNames(cert.keyUsage, rules.keyUsage)) return "key_usage"
  if (!sameNames(cert.extKeyUsage, rules.extKeyUsage)) return "ext_key_usage"
  if (!isEmpty(cert.unknownExtKeyUsage)) return "ext_key_usage"
  if (cert.basicConstraints?.isCA || cert.nameConstraints) return "ca"

  const now = rules.now.getTime()
  if (Math.abs(cert.notBefore.getTime() - now) > SKEW_MS) return "not_before"
  if (cert.notAfter.getTime() <= Math.max(now, cert.notBefore.getTime()))
    return "not_after"
  if (cert.notAfter.getTime() > rules.maxNotAfter.getTime()) return "lifetime"
  if (cert.notAfter.getTime() > rules.intermediateNotAfter.getTime())
    return "intermediate"
  return null
}

/** The ACME leaf's ceiling: three calendar years and the skew. */
export function acmeMaxNotAfter(now: Date): Date {
  const at = new Date(now.getTime())
  at.setUTCFullYear(at.getUTCFullYear() + 3)
  return new Date(at.getTime() + SKEW_MS)
}

/** The SCEP enrollment identity's ceiling: seven days and the skew. */
export function scepMaxNotAfter(now: Date): Date {
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000 + SKEW_MS)
}

/** The one `OU` an ACME certificate must carry: the permit's nonce. */
export function singleOrganizationalUnit(cert: CertificateTemplate): string | null {
  const units = cert.subject?.organizationalUnit ?? []
  return units.length === 1 && units[0] ? units[0] : null
}
