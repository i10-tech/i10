import {
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  constants,
  randomBytes,
  type KeyObject,
} from "node:crypto"
import { SignedXml } from "xml-crypto"
import {
  certificateFromDer,
  selfSigned,
  type IdpCertificate,
} from "../src/identity/saml-crypto.js"

/**
 * A SAML IdP in this process (#339): its own RSA keys and self-signed
 * certificate, and a builder for Responses that the advisory suite then
 * mutates. Nothing here is a fixture file; every key is drawn per test run.
 */

export const ENTITY = "https://idp.acme.test/saml"
export const SP_ENTITY =
  "https://auth.i10.localhost/sso/saml/metadata/33333333-3333-4333-8333-333333333333"
export const ACS =
  "https://auth.i10.localhost/sso/saml/acs/33333333-3333-4333-8333-333333333333"

export const ALG = {
  rsaSha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  rsaSha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  sha256: "http://www.w3.org/2001/04/xmlenc#sha256",
  sha1: "http://www.w3.org/2000/09/xmldsig#sha1",
  exc: "http://www.w3.org/2001/10/xml-exc-c14n#",
  excComments: "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
  enveloped: "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
} as const

export interface Keys {
  privateKey: KeyObject
  publicKey: KeyObject
  cert: IdpCertificate
  pem: string
}

export function keys(bits = 2048, name = "idp.acme.test", days = 365): Keys {
  const pair = generateKeyPairSync("rsa", { modulusLength: bits })
  const from = new Date(Date.now() - 24 * 3600 * 1000)
  const to = new Date(Date.now() + days * 24 * 3600 * 1000)
  const der = selfSigned(pair.privateKey, pair.publicKey, name, from, to)
  const cert = certificateFromDer(der)
  if ("error" in cert) {
    // A 1024-bit key is refused by design; the suite still needs its DER.
    return {
      ...pair,
      cert: {
        fingerprint: "weak",
        certificate: der.toString("base64"),
        subject: `CN=${name}`,
        notBefore: from,
        notAfter: to,
      },
      pem: pemOf(der),
    }
  }
  return { ...pair, cert, pem: pemOf(der) }
}

const pemOf = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END CERTIFICATE-----\n`

const iso = (ms: number) => new Date(ms).toISOString()

export interface AssertionKnobs {
  id?: string
  issuer?: string
  nameId?: string
  nameIdFormat?: string
  audience?: string
  recipient?: string
  inResponseTo?: string | null
  notBefore?: number
  notOnOrAfter?: number
  confirmationUntil?: number
  issueInstant?: number
  authnInstant?: number
  sessionIndex?: string
  classRef?: string
  method?: string
  attributes?: Record<string, string[]>
  /** Raw XML put inside the Subject, after the NameID. */
  subjectExtra?: string
  /** Raw XML put inside Conditions. */
  conditionsExtra?: string
}

export function assertionXml(k: AssertionKnobs = {}): string {
  const now = Date.now()
  const irt =
    k.inResponseTo === null ? "" : ` InResponseTo="${k.inResponseTo ?? "_req1"}"`
  const attrs = Object.entries(
    k.attributes ?? {
      email: ["ada@acme.test"],
      firstName: ["Ada"],
      lastName: ["Lovelace"],
      groups: ["eng", "admins"],
    },
  )
    .map(
      ([name, values]) =>
        `<saml:Attribute Name="${name}">${values.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("")}</saml:Attribute>`,
    )
    .join("")
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${k.id ?? "_a1"}" Version="2.0" IssueInstant="${iso(k.issueInstant ?? now)}">` +
    `<saml:Issuer>${k.issuer ?? ENTITY}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${k.nameIdFormat ?? "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"}">${k.nameId ?? "00u-ada"}</saml:NameID>` +
    (k.subjectExtra ?? "") +
    `<saml:SubjectConfirmation Method="${k.method ?? "urn:oasis:names:tc:SAML:2.0:cm:bearer"}"><saml:SubjectConfirmationData${irt} NotOnOrAfter="${iso(k.confirmationUntil ?? now + 5 * 60_000)}" Recipient="${k.recipient ?? ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(k.notBefore ?? now - 60_000)}" NotOnOrAfter="${iso(k.notOnOrAfter ?? now + 5 * 60_000)}"><saml:AudienceRestriction><saml:Audience>${k.audience ?? SP_ENTITY}</saml:Audience></saml:AudienceRestriction>${k.conditionsExtra ?? ""}</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(k.authnInstant ?? now)}" SessionIndex="${k.sessionIndex ?? "_sess1"}"><saml:AuthnContext><saml:AuthnContextClassRef>${k.classRef ?? "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  )
}

export interface SignKnobs {
  signatureAlgorithm?: string
  digestAlgorithm?: string
  transforms?: string[]
  canonicalization?: string
  /** Which element: by local name, the first one in the document. */
  target?: "Assertion" | "Response" | "LogoutRequest"
}

/** An enveloped signature over the first `target` element, placed after its Issuer. */
export function sign(xml: string, key: Keys, k: SignKnobs = {}): string {
  const target = k.target ?? "Assertion"
  const sig = new SignedXml({
    privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicCert: key.pem,
    signatureAlgorithm: k.signatureAlgorithm ?? ALG.rsaSha256,
    canonicalizationAlgorithm: k.canonicalization ?? ALG.exc,
  })
  sig.addReference({
    xpath: `(//*[local-name(.)='${target}'])[1]`,
    digestAlgorithm: k.digestAlgorithm ?? ALG.sha256,
    transforms: k.transforms ?? [ALG.enveloped, ALG.exc],
  })
  sig.computeSignature(xml, {
    prefix: "ds",
    location: {
      reference: `(//*[local-name(.)='${target}'])[1]/*[local-name(.)='Issuer']`,
      action: "after",
    },
  })
  return sig.getSignedXml()
}

export function responseXml(
  inner: string,
  k: {
    id?: string
    inResponseTo?: string | null
    destination?: string | null
    status?: string
  } = {},
): string {
  const irt =
    k.inResponseTo === null ? "" : ` InResponseTo="${k.inResponseTo ?? "_req1"}"`
  const dest = k.destination === null ? "" : ` Destination="${k.destination ?? ACS}"`
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${k.id ?? "_r1"}" Version="2.0" IssueInstant="${new Date().toISOString()}"${dest}${irt}>` +
    `<saml:Issuer>${ENTITY}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${k.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>` +
    inner +
    `</samlp:Response>`
  )
}

export const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64")

/** A good response: signed assertion inside an unsigned Response, base64. */
export function goodResponse(
  key: Keys,
  a: AssertionKnobs = {},
  s: SignKnobs = {},
): string {
  return b64(
    responseXml(sign(assertionXml(a), key, s), { inResponseTo: a.inResponseTo }),
  )
}

/** XML Encryption of an element, as an IdP does it for our SP key. */
export function encrypt(
  plain: string,
  spPublic: KeyObject,
  k: { data?: "aes256-gcm" | "aes256-cbc"; transport?: "oaep" | "rsa-1_5" } = {},
): string {
  const aes = randomBytes(32)
  let cipher: Buffer
  let method: string
  if ((k.data ?? "aes256-gcm") === "aes256-gcm") {
    const iv = randomBytes(12)
    const c = createCipheriv("aes-256-gcm", aes, iv)
    cipher = Buffer.concat([iv, c.update(plain, "utf8"), c.final(), c.getAuthTag()])
    method = "http://www.w3.org/2009/xmlenc11#aes256-gcm"
  } else {
    const iv = randomBytes(16)
    const c = createCipheriv("aes-256-cbc", aes, iv)
    cipher = Buffer.concat([iv, c.update(plain, "utf8"), c.final()])
    method = "http://www.w3.org/2001/04/xmlenc#aes256-cbc"
  }
  const rsa15 = k.transport === "rsa-1_5"
  // BoringSSL (Bun) will not encrypt PKCS#1 v1.5; the refusal comes before
  // any decryption is tried, so random bytes stand in for the wrapped key.
  const wrapped = rsa15
    ? randomBytes(256)
    : publicEncrypt(
        { key: spPublic, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
        aes,
      )
  const transport = rsa15
    ? "http://www.w3.org/2001/04/xmlenc#rsa-1_5"
    : "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p"
  return (
    `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element">` +
    `<xenc:EncryptionMethod Algorithm="${method}"/>` +
    `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xenc:EncryptedKey><xenc:EncryptionMethod Algorithm="${transport}"/>` +
    `<xenc:CipherData><xenc:CipherValue>${wrapped.toString("base64")}</xenc:CipherValue></xenc:CipherData></xenc:EncryptedKey></ds:KeyInfo>` +
    `<xenc:CipherData><xenc:CipherValue>${cipher.toString("base64")}</xenc:CipherValue></xenc:CipherData>` +
    `</xenc:EncryptedData></saml:EncryptedAssertion>`
  )
}
