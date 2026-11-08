import {
  X509Certificate,
  constants,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPair,
  privateDecrypt,
  randomBytes,
  sign as rsaSign,
  type KeyObject,
} from "node:crypto"
import { promisify } from "node:util"
import {
  NS,
  XmlRefused,
  attrOf,
  childrenOf,
  elementsOf,
  onlyChild,
  textOf,
} from "./saml-xml.js"

/**
 * Keys and certificates for SAML (#339): the IdP's signing certificates as we
 * accept them, our own SP key per connection (signs AuthnRequests and logout
 * messages, decrypts encrypted assertions), and XML Encryption, done here
 * with node:crypto rather than by another XML library.
 *
 * ⚠ RSA ONLY, 2048 BITS OR MORE. xml-crypto 6 verifies RSA signatures only;
 * a certificate with a smaller or another kind of key is refused when it is
 * added, not when a sign-in fails on it.
 */

// ── IdP certificates ─────────────────────────────────────────────────────

export interface IdpCertificate {
  /** SHA-256 of the DER, lowercase hex. */
  fingerprint: string
  /** The DER, base64, no line breaks. */
  certificate: string
  subject: string
  notBefore: Date
  notAfter: Date
}

export const MIN_RSA_BITS = 2048

/** One certificate as an admin pastes it: PEM, or the bare base64 of the DER. */
export function readCertificate(input: unknown): IdpCertificate | { error: string } {
  if (typeof input !== "string" || input.length > 16 * 1024)
    return { error: "certificate must be one PEM or base64 X.509 certificate." }
  const pem = input.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
  )
  if (pem && pem.length > 1) return { error: "Paste one certificate at a time." }
  const body = (pem ? pem[0]! : input)
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
    .replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body))
    return { error: "certificate must be one PEM or base64 X.509 certificate." }
  return certificateFromDer(Buffer.from(body, "base64"))
}

export function certificateFromDer(der: Buffer): IdpCertificate | { error: string } {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(der)
  } catch {
    return { error: "That is not an X.509 certificate." }
  }
  const key = cert.publicKey
  if (key.asymmetricKeyType !== "rsa")
    return { error: "The certificate's key must be RSA." }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_RSA_BITS)
    return { error: `The certificate's key must be at least ${MIN_RSA_BITS} bits.` }
  const notBefore = new Date(cert.validFrom)
  const notAfter = new Date(cert.validTo)
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime()))
    return { error: "The certificate's validity dates cannot be read." }
  const raw = Buffer.from(cert.raw)
  return {
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    certificate: raw.toString("base64"),
    subject: cert.subject.slice(0, 256),
    notBefore,
    notAfter,
  }
}

export function pemOf(certificate: string): string {
  const lines = certificate.match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`
}

/**
 * Whether a certificate may verify a signature now.
 *
 * ⚠ AN EXPIRED IdP CERTIFICATE VERIFIES NOTHING. Plenty of SAML software
 * ignores certificate dates; we do not, and the expiry alerts at 30, 7 and 1
 * days (identity/saml-refresh.ts) are what keep that from being a surprise.
 */
export function usableAt(
  cert: Pick<IdpCertificate, "notBefore" | "notAfter">,
  now: Date,
) {
  return (
    cert.notBefore.getTime() <= now.getTime() && now.getTime() < cert.notAfter.getTime()
  )
}

// ── Our SP key ───────────────────────────────────────────────────────────

/** The public half, kept in `config.saml.spCertificates`. */
export interface SpCertificate {
  fingerprint: string
  certificate: string
  notAfter: string
  createdAt: string
}

/** The private half, kept sealed in `secrets.saml.spKeys`. */
export interface SpPrivateKey {
  fingerprint: string
  pem: string
}

const generate = promisify(generateKeyPair)

/** Years an SP certificate is made for. IdPs pin it, so it should outlive the setup. */
const SP_CERT_YEARS = 10

/**
 * A new RSA 2048 key and a self-signed certificate for one connection.
 *
 * ⚠ SELF-SIGNED BY DESIGN. IdPs pin the certificate an SP gives them (Okta and
 * Entra ask for the file, everyone reads it from our metadata); a CA would add
 * nothing they check. node:crypto can read certificates but not make them, so
 * the DER is written here (`selfSigned`).
 */
export async function newSpKey(
  commonName: string,
  now: Date = new Date(),
): Promise<{ publicCert: SpCertificate; privateKey: SpPrivateKey }> {
  const pair = await generate("rsa", { modulusLength: 2048 })
  const notAfter = new Date(now)
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + SP_CERT_YEARS)
  const der = selfSigned(pair.privateKey, pair.publicKey, commonName, now, notAfter)
  // ⚠ READ BACK BEFORE IT IS PUBLISHED: a certificate Node cannot parse would
  // go into our metadata and every IdP would refuse it.
  new X509Certificate(der)
  const fingerprint = createHash("sha256").update(der).digest("hex")
  return {
    publicCert: {
      fingerprint,
      certificate: der.toString("base64"),
      notAfter: notAfter.toISOString(),
      createdAt: now.toISOString(),
    },
    privateKey: {
      fingerprint,
      pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  }
}

// DER, as little of it as an X.509 v3 certificate needs.
const der = (tag: number, body: Buffer): Buffer => {
  const n = body.length
  const len =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : n < 0x10000
          ? Buffer.from([0x82, n >> 8, n & 0xff])
          : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), len, body])
}
const seq = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts))
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split(".").map(Number)
  const bytes = [a! * 40 + b!]
  for (const value of rest) {
    const chunk = [value & 0x7f]
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return der(0x06, Buffer.from(bytes))
}
const utcTime = (d: Date): Buffer => {
  const p = (n: number) => String(n).padStart(2, "0")
  const text = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return d.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(text, "ascii"))
    : der(0x18, Buffer.from(`${d.getUTCFullYear()}${text.slice(2)}`, "ascii"))
}
const name = (cn: string) =>
  seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(cn.slice(0, 64), "utf8")))))
const SHA256_WITH_RSA = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]))

/**
 * A certificate serial from random bytes: positive and MINIMALLY encoded.
 *
 * ⚠ DER ALLOWS NO LEADING ZERO BYTE, AND BoringSSL (Node's) REFUSES THE WHOLE
 * CERTIFICATE OVER ONE. Clearing the top bit alone leaves a first byte of 0x00
 * one time in 128, and then a second byte under 0x80 makes the integer
 * non-minimal: a certificate nobody can read, about one in 256. Setting the
 * second bit keeps the first byte non-zero and the number positive.
 */
export function certificateSerial(random: Buffer): Buffer {
  const serial = Buffer.from(random)
  serial[0] = (serial[0]! & 0x7f) | 0x40
  return serial
}

export function selfSigned(
  privateKey: KeyObject,
  publicKey: KeyObject,
  commonName: string,
  notBefore: Date,
  notAfter: Date,
): Buffer {
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, certificateSerial(randomBytes(16))),
    SHA256_WITH_RSA,
    name(commonName),
    seq(utcTime(notBefore), utcTime(notAfter)),
    name(commonName),
    publicKey.export({ type: "spki", format: "der" }),
  )
  const signature = rsaSign("sha256", tbs, privateKey)
  return seq(
    tbs,
    SHA256_WITH_RSA,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  )
}

export function privateKeyOf(key: SpPrivateKey): KeyObject {
  return createPrivateKey(key.pem)
}

// ── XML Encryption ───────────────────────────────────────────────────────

const AES: Record<string, { cipher: string; keyBytes: number; gcm: boolean }> = {
  [`${NS.xenc11}aes128-gcm`]: { cipher: "aes-128-gcm", keyBytes: 16, gcm: true },
  [`${NS.xenc11}aes256-gcm`]: { cipher: "aes-256-gcm", keyBytes: 32, gcm: true },
  [`${NS.xenc}aes128-cbc`]: { cipher: "aes-128-cbc", keyBytes: 16, gcm: false },
  [`${NS.xenc}aes256-cbc`]: { cipher: "aes-256-cbc", keyBytes: 32, gcm: false },
}
const OAEP_MGF1P = `${NS.xenc}rsa-oaep-mgf1p`
const OAEP_11 = `${NS.xenc11}rsa-oaep`
const DIGESTS: Record<string, string> = {
  [`${NS.ds}sha1`]: "sha1",
  "http://www.w3.org/2001/04/xmlenc#sha256": "sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512": "sha512",
}
const MGF: Record<string, string> = {
  [`${NS.xenc11}mgf1sha1`]: "sha1",
  [`${NS.xenc11}mgf1sha256`]: "sha256",
  [`${NS.xenc11}mgf1sha512`]: "sha512",
}

const fail = (): never => {
  // ⚠ ONE ANSWER FOR EVERY DECRYPTION FAILURE: wrong key, bad padding, bad
  // tag, bad UTF-8. A padding oracle (CBC, "How to Break XML Encryption",
  // 2011) needs the failures told apart; here they never are, and the caller
  // turns this into the same refusal as a bad signature.
  throw new XmlRefused("undecryptable")
}

const base64Of = (el: Element | null): Buffer => {
  const text = textOf(el)?.replace(/\s+/g, "")
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail()
  return Buffer.from(text!, "base64")
}

/**
 * The plaintext of an `<EncryptedAssertion>`: the Assertion's XML, still to be
 * parsed (`parseXml`) and verified like any other.
 *
 * ⚠ RSA-OAEP KEY TRANSPORT ONLY. RSA PKCS#1 v1.5 (`rsa-1_5`) is refused: it is
 * Bleichenbacher's oracle, and xmlenc 1.1 deprecates it for that reason.
 * Exactly one EncryptedData and one EncryptedKey (inside its KeyInfo or beside
 * it), no CipherReference: anything we would have to go and fetch is refused.
 */
export function decryptAssertion(
  encrypted: Element,
  keys: readonly KeyObject[],
): string {
  if (keys.length === 0) fail()
  const data = childrenOf(encrypted, NS.xenc, "EncryptedData")
  if (data.length !== 1) fail()
  const encryptedData = data[0]!
  const method = attrOf(
    onlyChild(encryptedData, NS.xenc, "EncryptionMethod") ?? encryptedData,
    "Algorithm",
  )
  const aes = method ? AES[method] : undefined
  if (!aes) fail()

  const keyInfo = onlyChild(encryptedData, NS.ds, "KeyInfo")
  const keyNodes = [
    ...(keyInfo ? childrenOf(keyInfo, NS.xenc, "EncryptedKey") : []),
    ...childrenOf(encrypted, NS.xenc, "EncryptedKey"),
  ]
  if (keyNodes.length !== 1) fail()
  const encryptedKey = keyNodes[0]!
  const keyMethod = onlyChild(encryptedKey, NS.xenc, "EncryptionMethod")
  const transport = keyMethod ? attrOf(keyMethod, "Algorithm") : null
  if (transport !== OAEP_MGF1P && transport !== OAEP_11) fail()
  const digestEl = keyMethod ? onlyChild(keyMethod, NS.ds, "DigestMethod") : null
  const digest = digestEl ? DIGESTS[attrOf(digestEl, "Algorithm") ?? ""] : "sha1"
  const mgfEl = keyMethod ? onlyChild(keyMethod, NS.xenc11, "MGF") : null
  const mgf = mgfEl ? MGF[attrOf(mgfEl, "Algorithm") ?? ""] : "sha1"
  // ⚠ node:crypto uses ONE hash for OAEP and MGF1; a mix we cannot do is refused.
  if (!digest || !mgf || digest !== mgf || (transport === OAEP_MGF1P && mgfEl)) fail()
  if (elementsOf(keyMethod!).some((e) => !(e === digestEl || e === mgfEl))) fail()

  const keyCipher = onlyChild(encryptedKey, NS.xenc, "CipherData")
  const dataCipher = onlyChild(encryptedData, NS.xenc, "CipherData")
  if (!keyCipher || !dataCipher) fail()
  if (
    childrenOf(keyCipher!, NS.xenc, "CipherReference").length ||
    childrenOf(dataCipher!, NS.xenc, "CipherReference").length
  )
    fail()
  const wrapped = base64Of(onlyChild(keyCipher!, NS.xenc, "CipherValue"))
  const sealed = base64Of(onlyChild(dataCipher!, NS.xenc, "CipherValue"))

  // Our current key, then the one before it (a rotation); none opening it is
  // the one failure below.
  const unwrap = (key: KeyObject): Buffer | null => {
    try {
      return privateDecrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: digest },
        wrapped,
      )
    } catch {
      return null
    }
  }
  let symmetric: Buffer | null = null
  for (const key of keys) if ((symmetric = unwrap(key))) break
  if (!symmetric || symmetric.length !== aes!.keyBytes) fail()

  let plain: Buffer
  try {
    if (aes!.gcm) {
      if (sealed.length < 12 + 16) fail()
      const iv = sealed.subarray(0, 12)
      const tag = sealed.subarray(sealed.length - 16)
      const decipher = createDecipheriv(aes!.cipher as "aes-256-gcm", symmetric!, iv)
      decipher.setAuthTag(tag)
      plain = Buffer.concat([
        decipher.update(sealed.subarray(12, sealed.length - 16)),
        decipher.final(),
      ])
    } else {
      if (sealed.length < 32 || sealed.length % 16 !== 0) fail()
      const decipher = createDecipheriv(aes!.cipher, symmetric!, sealed.subarray(0, 16))
      // XML Encryption's padding is "last byte is the length", other bytes free.
      decipher.setAutoPadding(false)
      const padded = Buffer.concat([
        decipher.update(sealed.subarray(16)),
        decipher.final(),
      ])
      const pad = padded[padded.length - 1]!
      if (pad < 1 || pad > 16) fail()
      plain = padded.subarray(0, padded.length - pad)
    }
  } catch (error) {
    if (error instanceof XmlRefused) throw error
    return fail()
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plain!)
    if (!text.trimStart().startsWith("<")) fail()
    return text
  } catch (error) {
    if (error instanceof XmlRefused) throw error
    return fail()
  }
}
