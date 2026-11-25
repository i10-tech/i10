import { generateKeyPairSync, X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "../../src/mail-devices/permits.js"

/**
 * Webhook bodies shaped exactly as step-ca v0.30.2 sends them
 * (src/ca-hooks/body.ts names the source for each field), built from real keys
 * so the listener's SubjectPublicKeyInfo parsing is exercised too.
 */

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
    subject: { commonName: input.serial, organizationalUnit: [input.nonce] },
    rawSubject: null,
    issuer: {},
    serialNumber: null,
    dnsNames: null,
    emailAddresses: null,
    ipAddresses: null,
    uris: null,
    sans: [{ type: "permanentIdentifier", value: input.serial }],
    extensions: null,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    unknownExtKeyUsage: null,
    subjectKeyId: null,
    authorityKeyId: null,
    basicConstraints: null,
    nameConstraints: null,
    signatureAlgorithm: "",
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
    subject: { commonName: input.commonName },
    dnsNames: null,
    emailAddresses: null,
    ipAddresses: null,
    uris: null,
    sans: null,
    extensions: null,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["emailProtection"],
    unknownExtKeyUsage: null,
    basicConstraints: null,
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
export function throwawayCertificate(subject = "/CN=localhost"): {
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
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
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
