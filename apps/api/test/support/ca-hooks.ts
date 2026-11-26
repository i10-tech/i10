import { generateKeyPairSync, X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { permanentIdentifierSanDer } from "../../src/ca-hooks/body.js"
import { sha256 } from "../../src/mail-devices/permits.js"

/**
 * Webhook bodies shaped exactly as step-ca v0.30.2 sends them
 * (src/ca-hooks/body.ts names the source for each field), built from real keys
 * so the listener's SubjectPublicKeyInfo parsing is exercised too.
 *
 * The two certificates are what go.step.sm/crypto v0.77.1 renders for our
 * templates, field for field: `x509util.NewCertificate` with the template,
 * marshalled inside step-ca's `webhook.X509Certificate`. Every field
 * `x509util.Certificate` has is here, so the strict parse in
 * body.ts is tested against a real body.
 */

/** Every field of `x509util.Certificate` our templates leave unset, as Go marshals it. */
const UNSET = {
  rawSubject: null,
  issuer: {},
  serialNumber: null,
  dnsNames: null,
  emailAddresses: null,
  ipAddresses: null,
  uris: null,
  unknownExtKeyUsage: null,
  subjectKeyId: null,
  authorityKeyId: null,
  ocspServer: null,
  issuingCertificateURL: null,
  crlDistributionPoints: null,
  policyIdentifiers: null,
  basicConstraints: null,
  nameConstraints: null,
  signatureAlgorithm: "",
}

/** A fresh P-256 key's SPKI DER and its SHA-256, the binding's unit. */
export function freshKey(): { spki: Buffer; sha: Buffer } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const spki = publicKey.export({ type: "spki", format: "der" })
  return { spki, sha: sha256(spki) }
}

/** Go's `time.Time` JSON, with nanoseconds as step-ca writes them. */
export const goTime = (at: Date) => at.toISOString().replace("Z", "123456Z")

const minutes = (n: number) => n * 60 * 1000

/** The rendered `apple` ACME template for `serial`, with `nonce` as its one OU. */
export function acmeCertificate(input: {
  serial: string
  nonce: string
  spki: Buffer
  now: Date
}): Record<string, unknown> {
  return {
    version: 0,
    ...UNSET,
    subject: { organizationalUnit: [input.nonce], commonName: input.serial },
    sans: [{ type: "permanentIdentifier", value: input.serial }],
    // x509util adds this itself: Go's library cannot encode the SAN above.
    extensions: [
      {
        id: "2.5.29.17",
        critical: false,
        value: permanentIdentifierSanDer(input.serial).toString("base64"),
      },
    ],
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    publicKey: input.spki.toString("base64"),
    publicKeyAlgorithm: "ECDSA",
    notBefore: goTime(new Date(input.now.getTime() - minutes(1))),
    notAfter: goTime(new Date(input.now.getTime() + 3 * 365 * 24 * 60 * minutes(1))),
    raw: null,
  }
}

export function acmeBody(input: {
  serial: string
  nonce: string
  spki: Buffer
  now: Date
  certificate?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    timestamp: goTime(input.now),
    attestationData: { permanentIdentifier: input.serial },
    x509Certificate: { ...acmeCertificate(input), ...input.certificate },
  }
}

/** The rendered `apple-scep` template: CN only, no SANs, `emailProtection`, 7 days. */
export function scepCertificate(input: {
  commonName: string
  spki: Buffer
  now: Date
}): Record<string, unknown> {
  return {
    version: 0,
    ...UNSET,
    subject: { commonName: input.commonName },
    sans: null,
    extensions: null,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["emailProtection"],
    publicKey: input.spki.toString("base64"),
    publicKeyAlgorithm: "RSA",
    notBefore: goTime(new Date(input.now.getTime() - minutes(1))),
    notAfter: goTime(new Date(input.now.getTime() + 7 * 24 * 60 * minutes(1))),
    raw: null,
  }
}

export function scepChallengeBody(input: {
  challenge: string
  transactionId: string
  commonName: string
  spki: Buffer
  now: Date
}): Record<string, unknown> {
  return {
    timestamp: goTime(input.now),
    provisionerName: "apple-scep",
    scepChallenge: input.challenge,
    scepTransactionID: input.transactionId,
    x509CertificateRequest: {
      subject: { commonName: input.commonName },
      publicKey: input.spki.toString("base64"),
      publicKeyAlgorithm: "RSA",
      raw: null,
    },
  }
}

export function scepAuthorizeBody(input: {
  commonName: string
  spki: Buffer
  now: Date
  certificate?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    timestamp: goTime(input.now),
    x509Certificate: { ...scepCertificate(input), ...input.certificate },
  }
}

/** `NotifySuccess`: the issued certificate's DER, no template (`webhook.WithX509Certificate(nil, cert)`). */
export function scepNotifyBody(input: {
  transactionId: string
  der: Buffer | null
  now: Date
}): Record<string, unknown> {
  return {
    timestamp: goTime(input.now),
    scepTransactionID: input.transactionId,
    x509CertificateRequest: { subject: { commonName: "x" }, publicKey: null },
    ...(input.der
      ? {
          x509Certificate: {
            publicKey: null,
            notBefore: goTime(input.now),
            notAfter: goTime(input.now),
            raw: input.der.toString("base64"),
          },
        }
      : { scepErrorCode: 2, scepErrorDescription: "bad request" }),
  }
}

/**
 * A throwaway self-signed certificate and key, made by `openssl` in a temporary
 * directory and deleted at once, so no key material is ever committed.
 */
export function throwawayCertificate(
  subject = "/CN=localhost",
  extensions = ["subjectAltName=DNS:localhost,IP:127.0.0.1"],
): {
  certPem: string
  keyPem: string
  der: Buffer
  spkiSha: Buffer
} {
  const dir = mkdtempSync(join(tmpdir(), "i10-ca-hooks-"))
  try {
    const run = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-subj",
      subject,
      "-days",
      "1",
      ...extensions.flatMap((extension) => ["-addext", extension]),
    ])
    if (run.exitCode !== 0) throw new Error(`openssl failed: ${run.stderr.toString()}`)
    const certPem = readFileSync(join(dir, "cert.pem"), "utf8")
    const keyPem = readFileSync(join(dir, "key.pem"), "utf8")
    const cert = new X509Certificate(certPem)
    return {
      certPem,
      keyPem,
      der: cert.raw,
      spkiSha: sha256(cert.publicKey.export({ type: "spki", format: "der" })),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
