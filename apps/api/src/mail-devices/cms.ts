import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { sha256 } from "./permits.js"

/**
 * X.509 phase 4 certificate verification and RFC 5652 CMS EnvelopedData
 * encryption in DER (#383 PR 4, docs/research/mail-device-binding.md section 12,
 * Review 1 rules M1 & L1).
 *
 * Keeps sealing strictly inside the API so `enrolld` never sees a plaintext
 * device code or ACME nonce.
 *
 * Uses only `node:crypto` plus a minimal strict DER encoder/decoder:
 *   - Phase 4 cert check verifies the chain against the mounted device CA
 *     bundle (`i10-device-ca-trust` `bundle.pem`: root + intermediate), requires
 *     issuer = intermediate (refusing certs signed straight by the root, such
 *     as the SCEP decrypter), requires EKU `emailProtection`, refuses ANY SAN
 *     extension (`2.5.29.17`) at the ASN.1 level, requires an RSA key, and
 *     computes `sha256(SPKI)` and `sha256(DER)`.
 *   - CMS EnvelopedData encodes AES-256-CBC with a random 16-byte IV, RSA
 *     PKCS#1 v1.5 key transport (`rsaEncryption`) to that certificate, and an
 *     `IssuerAndSerialNumber` recipient identifier taken byte-for-byte from the
 *     verified certificate's TBSCertificate.
 */

const SERIAL_CN = /^[\x21-\x7e]{1,64}$/
const PEM_CERT_BLOCK =
  /-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g

// ── ASN.1 DER encoder ────────────────────────────────────────────────────────

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let n = length
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

const derSeq = (...parts: Buffer[]) => derTlv(0x30, Buffer.concat(parts))
const derSet = (...parts: Buffer[]) => derTlv(0x31, Buffer.concat(parts))
const derOctetString = (bytes: Buffer) => derTlv(0x04, bytes)
const derNull = () => Buffer.from([0x05, 0x00])
const derInt0 = () => Buffer.from([0x02, 0x01, 0x00])

// Fixed DER-encoded OID TLVs (tag 0x06 + length + value)
/** 1.2.840.113549.1.7.3 (id-envelopedData) */
const OID_ENVELOPED_DATA = Buffer.from("06092a864886f70d010703", "hex")
/** 1.2.840.113549.1.7.1 (id-data) */
const OID_DATA = Buffer.from("06092a864886f70d010701", "hex")
/** 1.2.840.113549.1.1.1 (rsaEncryption) */
const OID_RSA_ENCRYPTION = Buffer.from("06092a864886f70d010101", "hex")
/** 2.16.840.1.101.3.4.1.42 (id-aes256-CBC) */
const OID_AES_256_CBC = Buffer.from("060960864801650304012a", "hex")

// X.509 OID value bytes (without tag/length) for DER inspection
/** 2.5.4.3 (id-at-commonName) */
const OID_CN_VAL = Buffer.from("550403", "hex")
/** 2.5.29.17 (id-ce-subjectAltName) */
const OID_SAN_VAL = Buffer.from("551d11", "hex")
/** 2.5.29.37 (id-ce-extKeyUsage) */
const OID_EKU_VAL = Buffer.from("551d25", "hex")
/** 1.3.6.1.5.5.7.3.4 (id-kp-emailProtection) */
const OID_EMAIL_PROTECTION_VAL = Buffer.from("2b06010505070304", "hex")
/** 1.3.6.1.5.5.7.3.2 (id-kp-clientAuth) */
const OID_CLIENT_AUTH_VAL = Buffer.from("2b06010505070302", "hex")

// ── Strict ASN.1 DER reader ──────────────────────────────────────────────────

interface DerElement {
  tag: number
  /** The full TLV slice (tag + length + value) from the input buffer. */
  raw: Buffer
  /** The value bytes only. */
  value: Buffer
  /** Offset immediately past this element in the input buffer. */
  end: number
}

function readDer(buf: Buffer, offset = 0): DerElement {
  if (offset >= buf.length) throw new Error("unexpected end of DER")
  const tag = buf[offset]!
  // Reject high-tag-number form (unused in X.509 / CMS structures we handle).
  if ((tag & 0x1f) === 0x1f) throw new Error("unsupported high-tag DER")
  if (offset + 1 >= buf.length) throw new Error("truncated DER length")
  const firstLen = buf[offset + 1]!
  let len: number
  let headerLen: number
  if (firstLen < 0x80) {
    len = firstLen
    headerLen = 2
  } else {
    const numOctets = firstLen & 0x7f
    // Reject indefinite length (0x80) and lengths over 4 bytes.
    if (numOctets === 0 || numOctets > 4) throw new Error("invalid DER length")
    if (offset + 2 + numOctets > buf.length)
      throw new Error("truncated DER length bytes")
    // Enforce minimal DER length encoding (no leading zero, value must be >= 128).
    if (buf[offset + 2] === 0) throw new Error("non-canonical DER length")
    len = 0
    for (let i = 0; i < numOctets; i++) {
      len = len * 256 + buf[offset + 2 + i]!
    }
    if (len < 0x80) throw new Error("non-canonical DER short length")
    headerLen = 2 + numOctets
  }
  const valueStart = offset + headerLen
  const end = valueStart + len
  if (end > buf.length) throw new Error("DER value exceeds buffer")
  return {
    tag,
    raw: buf.subarray(offset, end),
    value: buf.subarray(valueStart, end),
    end,
  }
}

function readChildren(buf: Buffer): DerElement[] {
  const out: DerElement[] = []
  let offset = 0
  while (offset < buf.length) {
    const el = readDer(buf, offset)
    out.push(el)
    offset = el.end
  }
  return out
}

function readExact(buf: Buffer, expectedTag: number): DerElement {
  const el = readDer(buf, 0)
  if (el.end !== buf.length) throw new Error("trailing bytes after DER element")
  if (el.tag !== expectedTag) {
    throw new Error(
      `expected DER tag 0x${expectedTag.toString(16)}, got 0x${el.tag.toString(16)}`,
    )
  }
  return el
}

// ── X.509 DER inspection ─────────────────────────────────────────────────────

interface ParsedCertFields {
  serialNumberDer: Buffer
  issuerDer: Buffer
  commonNames: string[]
  hasSanExtension: boolean
  ekuOids: Buffer[] | null
}

function decodeDirectoryString(el: DerElement): string | null {
  // UTF8String (0x0c), PrintableString (0x13), IA5String (0x16); nothing else
  if (el.tag === 0x0c || el.tag === 0x13 || el.tag === 0x16) {
    return el.value.toString("utf8")
  }
  if (el.tag === 0x1e) {
    // BMPString (UCS-2 big-endian)
    if (el.value.length % 2 !== 0) return null
    const swapped = Buffer.alloc(el.value.length)
    for (let i = 0; i < el.value.length; i += 2) {
      swapped[i] = el.value[i + 1]!
      swapped[i + 1] = el.value[i]!
    }
    return swapped.toString("utf16le")
  }
  return null
}

function parseCertificateFields(certDer: Buffer): ParsedCertFields {
  const certSeq = readExact(certDer, 0x30)
  const certParts = readChildren(certSeq.value)
  if (certParts.length !== 3 || certParts[0]!.tag !== 0x30) {
    throw new Error("invalid X.509 Certificate structure")
  }
  const tbs = readChildren(certParts[0]!.value)
  let idx = 0
  if (tbs[idx]?.tag === 0xa0) idx++ // optional [0] EXPLICIT version
  const serialEl = tbs[idx++]
  const sigAlgEl = tbs[idx++]
  const issuerEl = tbs[idx++]
  const validityEl = tbs[idx++]
  const subjectEl = tbs[idx++]
  const spkiEl = tbs[idx++]

  if (
    !serialEl ||
    serialEl.tag !== 0x02 ||
    !sigAlgEl ||
    sigAlgEl.tag !== 0x30 ||
    !issuerEl ||
    issuerEl.tag !== 0x30 ||
    !validityEl ||
    validityEl.tag !== 0x30 ||
    !subjectEl ||
    subjectEl.tag !== 0x30 ||
    !spkiEl ||
    spkiEl.tag !== 0x30
  ) {
    throw new Error("invalid TBSCertificate fields")
  }

  // Extract CN attribute(s) from subject Name (SEQUENCE OF SET OF SEQUENCE { OID, value })
  const commonNames: string[] = []
  for (const rdn of readChildren(subjectEl.value)) {
    if (rdn.tag !== 0x31) throw new Error("invalid subject RDN")
    for (const atv of readChildren(rdn.value)) {
      if (atv.tag !== 0x30) throw new Error("invalid subject AttributeTypeAndValue")
      const pair = readChildren(atv.value)
      if (pair.length !== 2 || pair[0]!.tag !== 0x06) {
        throw new Error("invalid subject AVA pair")
      }
      if (pair[0]!.value.equals(OID_CN_VAL)) {
        const text = decodeDirectoryString(pair[1]!)
        if (text === null) throw new Error("unsupported CN string type")
        commonNames.push(text)
      }
    }
  }

  // Optional issuerUniqueID [1] (0x81), subjectUniqueID [2] (0x82), extensions [3] (0xa3)
  let hasSanExtension = false
  let ekuOids: Buffer[] | null = null
  for (; idx < tbs.length; idx++) {
    const field = tbs[idx]!
    if (field.tag !== 0xa3) continue
    const extSeq = readExact(field.value, 0x30)
    for (const ext of readChildren(extSeq.value)) {
      if (ext.tag !== 0x30) throw new Error("invalid Extension")
      const parts = readChildren(ext.value)
      if (parts.length < 2 || parts.length > 3 || parts[0]!.tag !== 0x06) {
        throw new Error("invalid Extension fields")
      }
      const oidVal = parts[0]!.value
      const valueEl = parts[parts.length - 1]!
      if (valueEl.tag !== 0x04)
        throw new Error("Extension extnValue is not OCTET STRING")

      if (oidVal.equals(OID_SAN_VAL)) {
        hasSanExtension = true
      } else if (oidVal.equals(OID_EKU_VAL)) {
        if (ekuOids !== null) throw new Error("duplicate EKU extension")
        const ekuSeq = readExact(valueEl.value, 0x30)
        const oids: Buffer[] = []
        for (const item of readChildren(ekuSeq.value)) {
          if (item.tag !== 0x06) throw new Error("invalid EKU OID")
          oids.push(item.value)
        }
        ekuOids = oids
      }
    }
  }

  return {
    serialNumberDer: serialEl.raw,
    issuerDer: issuerEl.raw,
    commonNames,
    hasSanExtension,
    ekuOids,
  }
}

// ── Device CA bundle loading & phase 4 verification ──────────────────────────

export interface DeviceCaBundle {
  readonly roots: readonly X509Certificate[]
  readonly intermediates: readonly X509Certificate[]
}

/**
 * Parses `i10-device-ca-trust`'s `bundle.pem` (root(s) and intermediate(s)).
 * Refuses any non-PEM bytes or a bundle missing a root or an intermediate.
 */
export function parseDeviceCaBundle(pem: string): DeviceCaBundle {
  const blocks = pem.match(PEM_CERT_BLOCK) ?? []
  const leftover = pem.replace(PEM_CERT_BLOCK, "").trim()
  if (blocks.length === 0 || leftover.length > 0) {
    throw new Error("device CA bundle must contain only PEM certificates")
  }
  const roots: X509Certificate[] = []
  const intermediates: X509Certificate[] = []
  for (const block of blocks) {
    const cert = new X509Certificate(block)
    if (!cert.ca) {
      throw new Error("device CA bundle contains a non-CA certificate")
    }
    if (cert.subject === cert.issuer && cert.verify(cert.publicKey)) {
      roots.push(cert)
    } else {
      intermediates.push(cert)
    }
  }
  if (roots.length === 0 || intermediates.length === 0) {
    throw new Error(
      "device CA bundle must include at least one root and one intermediate",
    )
  }
  return { roots, intermediates }
}

/**
 * Reload-safe loader for the mounted `bundle.pem` ConfigMap file: caches the
 * parsed bundle by `mtimeMs` so Kubernetes ConfigMap rotations take effect
 * without restarting the API. Returns null when the file is not mounted.
 */
export function createDeviceCaBundleLoader(
  filePath: string,
): () => DeviceCaBundle | null {
  let cached: { mtimeMs: number; ino: number; bundle: DeviceCaBundle } | null = null
  return () => {
    if (!existsSync(filePath)) return null
    const stat = statSync(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
      return cached.bundle
    }
    const bundle = parseDeviceCaBundle(readFileSync(filePath, "utf8"))
    cached = { mtimeMs: stat.mtimeMs, ino: stat.ino, bundle }
    return bundle
  }
}

export interface VerifiedPhase4Cert {
  cert: X509Certificate
  commonName: string
  keySha256: Buffer
  certSha256: Buffer
  issuerDer: Buffer
  serialNumberDer: Buffer
}

function isValidAt(cert: X509Certificate, nowMs: number): boolean {
  const from = Date.parse(cert.validFrom)
  const to = Date.parse(cert.validTo)
  return Number.isFinite(from) && Number.isFinite(to) && nowMs >= from && nowMs <= to
}

/**
 * Verifies a phase 4 signer certificate DER forwarded by `enrolld` (Review 1 L1):
 *   1. Exact DER X.509 certificate, not a CA, RSA public key, valid at `now`.
 *   2. Issued by a valid device **intermediate** that chains to a valid device
 *      **root** in `bundle` (refuses certificates issued straight by the root,
 *      such as the SCEP decrypter).
 *   3. EKU extension explicitly includes `emailProtection` (`1.3.6.1.5.5.7.3.4`)
 *      and never `clientAuth` (`1.3.6.1.5.5.7.3.2`).
 *   4. No SAN extension (`2.5.29.17`) at all (not even an `otherName` SAN).
 *   5. Single printable-ASCII subject CN (the attested serial).
 *   6. Returns `sha256(SPKI)`, `sha256(DER)`, and exact `issuerDer` +
 *      `serialNumberDer` for CMS `IssuerAndSerialNumber`.
 */
export function verifyPhase4Certificate(
  certDer: Buffer,
  bundle: DeviceCaBundle,
  now: Date = new Date(),
): { ok: true; verified: VerifiedPhase4Cert } | { ok: false; reason: string } {
  let cert: X509Certificate
  let fields: ParsedCertFields
  try {
    fields = parseCertificateFields(certDer)
    cert = new X509Certificate(certDer)
  } catch {
    return { ok: false, reason: "invalid_cert_der" }
  }

  if (cert.ca) return { ok: false, reason: "cert_is_ca" }
  if (cert.publicKey.asymmetricKeyType !== "rsa") {
    return { ok: false, reason: "cert_not_rsa" }
  }

  const nowMs = now.getTime()
  if (!isValidAt(cert, nowMs)) {
    return { ok: false, reason: "cert_not_valid_now" }
  }

  // Must have no SAN extension at all (checked on raw DER extensions).
  if (fields.hasSanExtension) {
    return { ok: false, reason: "cert_has_san" }
  }

  // Must explicitly include emailProtection EKU and must not include clientAuth.
  if (
    !fields.ekuOids ||
    !fields.ekuOids.some((oid) => oid.equals(OID_EMAIL_PROTECTION_VAL)) ||
    fields.ekuOids.some((oid) => oid.equals(OID_CLIENT_AUTH_VAL))
  ) {
    return { ok: false, reason: "cert_bad_eku" }
  }

  if (fields.commonNames.length !== 1 || !SERIAL_CN.test(fields.commonNames[0]!)) {
    return { ok: false, reason: "cert_bad_cn" }
  }

  // Chain check: leaf -> valid intermediate -> valid root.
  let chained = false
  for (const inter of bundle.intermediates) {
    if (!isValidAt(inter, nowMs)) continue
    if (!cert.checkIssued(inter)) continue
    let leafSigOk = false
    try {
      leafSigOk = cert.verify(inter.publicKey)
    } catch {
      leafSigOk = false
    }
    if (!leafSigOk) continue

    for (const root of bundle.roots) {
      if (!isValidAt(root, nowMs)) continue
      if (!inter.checkIssued(root)) continue
      let interSigOk = false
      try {
        interSigOk = inter.verify(root.publicKey)
      } catch {
        interSigOk = false
      }
      if (interSigOk) {
        chained = true
        break
      }
    }
    if (chained) break
  }

  if (!chained) {
    return { ok: false, reason: "cert_untrusted" }
  }

  const spki = cert.publicKey.export({ type: "spki", format: "der" })
  return {
    ok: true,
    verified: {
      cert,
      commonName: fields.commonNames[0]!,
      keySha256: sha256(spki),
      certSha256: sha256(certDer),
      issuerDer: fields.issuerDer,
      serialNumberDer: fields.serialNumberDer,
    },
  }
}

// ── CMS EnvelopedData (RFC 5652) ─────────────────────────────────────────────

export interface CmsRecipient {
  publicKey: KeyObject
  issuerDer: Buffer
  serialNumberDer: Buffer
}

/**
 * Encrypts `plaintext` as DER-encoded CMS `EnvelopedData` (RFC 5652 section 6):
 *   - AES-256-CBC (`2.16.840.1.101.3.4.1.42`) with a fresh 32-byte CEK and
 *     fresh 16-byte IV, PKCS#7 padding
 *   - RSAES-PKCS1-v1_5 (`1.2.840.1.113549.1.1.1`) key transport
 *   - `IssuerAndSerialNumber` recipient identifier
 */
export function encryptCmsEnvelopedData(
  plaintext: Buffer,
  recipient: CmsRecipient,
): Buffer {
  const cek = randomBytes(32)
  const iv = randomBytes(16)
  try {
    const cipher = createCipheriv("aes-256-cbc", cek, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

    const encryptedKey = publicEncrypt(
      { key: recipient.publicKey, padding: constants.RSA_PKCS1_PADDING },
      cek,
    )

    const issuerAndSerial = derSeq(recipient.issuerDer, recipient.serialNumberDer)
    const keyEncryptionAlgorithm = derSeq(OID_RSA_ENCRYPTION, derNull())
    const ktri = derSeq(
      derInt0(),
      issuerAndSerial,
      keyEncryptionAlgorithm,
      derOctetString(encryptedKey),
    )

    const contentEncryptionAlgorithm = derSeq(OID_AES_256_CBC, derOctetString(iv))
    // encryptedContent [0] IMPLICIT OCTET STRING (tag 0x80)
    const encryptedContent = derTlv(0x80, ciphertext)
    const encryptedContentInfo = derSeq(
      OID_DATA,
      contentEncryptionAlgorithm,
      encryptedContent,
    )

    const envelopedData = derSeq(derInt0(), derSet(ktri), encryptedContentInfo)
    // content [0] EXPLICIT EnvelopedData (tag 0xa0)
    return derSeq(OID_ENVELOPED_DATA, derTlv(0xa0, envelopedData))
  } finally {
    cek.fill(0)
  }
}

/**
 * Unwraps an RSAES-PKCS1-v1_5 block (`0x00 0x02 <>=8 non-zero bytes> 0x00 <M>`)
 * using `RSA_NO_PADDING`, since Node 20+ / Bun disables `RSA_PKCS1_PADDING` in
 * `privateDecrypt` (Marvin attack mitigation). Used strictly by the test-side
 * `decryptCmsEnvelopedData` verifier; production only encrypts.
 */
function unwrapRsaPkcs1v15(encryptedKey: Buffer, privateKey: KeyObject): Buffer {
  const em = privateDecrypt(
    { key: privateKey, padding: constants.RSA_NO_PADDING },
    encryptedKey,
  )
  if (em.length < 11 || em[0] !== 0x00 || em[1] !== 0x02) {
    throw new Error("invalid PKCS#1 v1.5 header")
  }
  const sep = em.indexOf(0x00, 2)
  if (sep < 10) {
    throw new Error("invalid PKCS#1 v1.5 padding length")
  }
  return Buffer.from(em.subarray(sep + 1))
}

/**
 * Parses and decrypts a DER CMS `EnvelopedData` produced by
 * `encryptCmsEnvelopedData` using `node:crypto`. Used to verify the exact
 * DER layout alongside `openssl cms -decrypt`.
 */
export function decryptCmsEnvelopedData(
  der: Buffer,
  privateKey: KeyObject,
): {
  plaintext: Buffer
  issuerDer: Buffer
  serialNumberDer: Buffer
  iv: Buffer
} {
  const contentInfo = readChildren(readExact(der, 0x30).value)
  if (contentInfo.length !== 2) throw new Error("invalid ContentInfo")
  if (!contentInfo[0]!.raw.equals(OID_ENVELOPED_DATA)) {
    throw new Error("not CMS EnvelopedData")
  }
  if (contentInfo[1]!.tag !== 0xa0) throw new Error("missing [0] EXPLICIT content")

  const env = readChildren(readExact(contentInfo[1]!.value, 0x30).value)
  if (env.length !== 3) throw new Error("invalid EnvelopedData")
  if (!env[0]!.raw.equals(derInt0()))
    throw new Error("unexpected EnvelopedData version")

  if (env[1]!.tag !== 0x31) throw new Error("recipientInfos is not SET")
  const recipients = readChildren(env[1]!.value)
  if (recipients.length !== 1 || recipients[0]!.tag !== 0x30) {
    throw new Error("expected one KeyTransRecipientInfo")
  }
  const ktri = readChildren(recipients[0]!.value)
  if (ktri.length !== 4 || !ktri[0]!.raw.equals(derInt0())) {
    throw new Error("invalid KeyTransRecipientInfo")
  }
  if (ktri[1]!.tag !== 0x30) throw new Error("rid is not IssuerAndSerialNumber")
  const ias = readChildren(ktri[1]!.value)
  if (ias.length !== 2 || ias[0]!.tag !== 0x30 || ias[1]!.tag !== 0x02) {
    throw new Error("invalid IssuerAndSerialNumber")
  }
  const keyAlg = readChildren(readExact(ktri[2]!.raw, 0x30).value)
  if (!keyAlg[0]?.raw.equals(OID_RSA_ENCRYPTION)) {
    throw new Error("unexpected keyEncryptionAlgorithm")
  }
  if (ktri[3]!.tag !== 0x04) throw new Error("encryptedKey is not OCTET STRING")

  const eci = readChildren(readExact(env[2]!.raw, 0x30).value)
  if (eci.length !== 3 || !eci[0]!.raw.equals(OID_DATA)) {
    throw new Error("invalid EncryptedContentInfo")
  }
  const encAlg = readChildren(readExact(eci[1]!.raw, 0x30).value)
  if (
    encAlg.length !== 2 ||
    !encAlg[0]!.raw.equals(OID_AES_256_CBC) ||
    encAlg[1]!.tag !== 0x04 ||
    encAlg[1]!.value.length !== 16
  ) {
    throw new Error("unexpected contentEncryptionAlgorithm")
  }
  if (eci[2]!.tag !== 0x80) throw new Error("encryptedContent missing [0] IMPLICIT tag")

  const iv = encAlg[1]!.value
  const cek = unwrapRsaPkcs1v15(ktri[3]!.value, privateKey)
  try {
    const decipher = createDecipheriv("aes-256-cbc", cek, iv)
    const plaintext = Buffer.concat([decipher.update(eci[2]!.value), decipher.final()])
    return {
      plaintext,
      issuerDer: ias[0]!.raw,
      serialNumberDer: ias[1]!.raw,
      iv,
    }
  } finally {
    cek.fill(0)
  }
}
