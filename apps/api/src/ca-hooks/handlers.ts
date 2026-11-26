import type { Database } from "../db/client.js"
import {
  authorizeAcme,
  authorizeScep,
  challengeScep,
  notifyScep,
  sha256,
  type HookDecision,
} from "../mail-devices/permits.js"
import {
  acmeAuthorizeBody,
  acmeMaxNotAfter,
  issuedCertificate,
  scepAuthorizeBody,
  scepChallengeBody,
  scepMaxNotAfter,
  scepNotifyBody,
  singleOrganizationalUnit,
  spkiSha256,
  templateRefusal,
} from "./body.js"
import type { CaHookKind } from "./config.js"

/**
 * The four webhook handlers (#383 PR 3, docs/research/mail-device-binding.md
 * section 11, "The handlers"). Each parses its body, refuses anything its
 * template rules do not allow BEFORE touching the database, and hands the rest
 * to the permit store (mail-devices/permits.ts), which holds the lock order.
 */
export type HookHandler = (
  body: unknown,
  now: Date,
  /** When the transaction must have committed or rolled back (permits.ts `decide`). */
  deadline: Date,
) => Promise<HookDecision>

const refuse = (outcome: HookDecision["outcome"]): HookDecision => ({
  allow: false,
  outcome,
})

export function createHookHandlers(deps: {
  db: Pick<Database, "transaction">
  intermediateNotAfter: Date
}): Record<CaHookKind, HookHandler> {
  const { db, intermediateNotAfter } = deps
  return {
    "acme-authorize": async (raw, now, deadline) => {
      const body = acmeAuthorizeBody.safeParse(raw)
      if (!body.success) return refuse("bad_body")
      const cert = body.data.x509Certificate
      const serial = body.data.attestationData.permanentIdentifier
      const nonce = singleOrganizationalUnit(cert)
      const keySha256 = spkiSha256(cert.publicKey)
      if (!nonce || !keySha256) return refuse("bad_template")
      const refusal = templateRefusal(cert, {
        serial,
        keyUsage: ["digitalSignature"],
        extKeyUsage: ["clientAuth"],
        permanentIdentifierSan: true,
        maxNotAfter: acmeMaxNotAfter(now),
        intermediateNotAfter,
        now,
      })
      if (refusal) return refuse("bad_template")
      return authorizeAcme(
        db,
        { serial, nonceSha256: sha256(nonce), keySha256 },
        deadline,
      )
    },

    "scep-challenge": async (raw, _now, deadline) => {
      const body = scepChallengeBody.safeParse(raw)
      if (!body.success) return refuse("bad_body")
      const csr = body.data.x509CertificateRequest
      const keySha256 = spkiSha256(csr.publicKey)
      const commonName = csr.subject?.commonName
      if (!keySha256 || !commonName) return refuse("bad_template")
      return challengeScep(
        db,
        {
          challengeSha256: sha256(body.data.scepChallenge),
          transactionId: body.data.scepTransactionID,
          commonName,
          keySha256,
        },
        deadline,
      )
    },

    "scep-authorize": async (raw, now, deadline) => {
      const body = scepAuthorizeBody.safeParse(raw)
      if (!body.success) return refuse("bad_body")
      const cert = body.data.x509Certificate
      const commonName = cert.subject?.commonName
      const keySha256 = spkiSha256(cert.publicKey)
      if (!commonName || !keySha256) return refuse("bad_template")
      // ⚠ AN EXPLICIT EKU WITHOUT `clientAuth`: a certificate with no EKU at all
      // would pass Go's `clientAuth` check (`crypto/x509/verify.go`).
      const refusal = templateRefusal(cert, {
        serial: commonName,
        keyUsage: ["digitalSignature", "keyEncipherment"],
        extKeyUsage: ["emailProtection"],
        permanentIdentifierSan: false,
        maxNotAfter: scepMaxNotAfter(now),
        intermediateNotAfter,
        now,
      })
      if (refusal) return refuse("bad_template")
      return authorizeScep(db, { commonName, keySha256 }, deadline)
    },

    "scep-notify": async (raw, _now, deadline) => {
      const body = scepNotifyBody.safeParse(raw)
      if (!body.success) return refuse("bad_body")
      const der = body.data.x509Certificate?.raw
      // A `NotifyFailure` (no certificate) changes nothing.
      if (!der) return refuse("notify_failure")
      const issued = issuedCertificate(der)
      if (!issued) return refuse("bad_template")
      return notifyScep(
        db,
        { transactionId: body.data.scepTransactionID, ...issued },
        deadline,
      )
    },
  }
}
