import DKIM from "nodemailer/lib/dkim"

/**
 * Signing a message as the customer's domain, on the route we carry ourselves.
 *
 * ⚠ THIS IS THE ONLY THING MAKING DMARC PASS ON DKIM FOR A DIRECT SEND, AND ON
 * THE SES ROUTE IT IS AMAZON DOING THE SAME JOB WITH THE SAME KEY. BYODKIM
 * uploads the private half to SES at domain creation, so an SES-routed message
 * is signed by them; nothing in this process touches it. A direct-routed message
 * has no such arrangement — if we do not sign it here, nobody does.
 *
 * ⚠ AND UNSIGNED IS NOT A DEGRADED SEND, IT IS A FAILED ONE. The direct route's
 * envelope sender is `bounce.<domain>`, which aligns under DMARC's relaxed
 * default — so SPF carries it too and one missing signature is survivable on
 * paper. It is still not something to ship quietly: a customer who tightens to
 * `aspf=s`, or a forwarder that breaks SPF, turns "DKIM was optional" into mail
 * in the spam folder with nothing in our logs about it. `signMessage` throws
 * rather than returning the message unsigned, and the transport turns that into
 * a `rejected` — visible, attributable, and not delivered.
 *
 * ⚠ THE CANONICALIZATION IS THE LIBRARY'S, DELIBERATELY. Relaxed header folding,
 * the body hash's trailing-CRLF rules and the header-ordering requirements are
 * where hand-rolled signers fail — and they fail SILENTLY and LATE, producing a
 * signature that verifies nowhere while looking correct in every log we keep.
 *
 * ⚠ THE LIBRARY IS NODEMAILER'S, NOT mailauth'S, AS OF 2026-09-16. Both produced
 * a BYTE-IDENTICAL BODY HASH for the same message and key, which is the part
 * that has to match; the signatures differ only because they cover different
 * header sets. mailauth cost 1.4 MB and ten transitive dependencies for one
 * function out of a full SPF/DKIM/DMARC/ARC/BIMI suite — including a `joi` with
 * its own advisories, and a `nodemailer` pinned to a vulnerable 9.0.4 that
 * needed a scoped override to patch. nodemailer was already a dependency here
 * for SMTP submission, so this is one library for the whole mail subsystem.
 *
 * ⚠ AND `nodemailer/lib/dkim` IS A DECLARED PUBLIC SUBPATH, not a reach into
 * `dist/`. Its `exports` map publishes it deliberately; the deep path is blocked
 * and should stay that way.
 */

export interface DkimKey {
  /** The DNS label the public half is published under. */
  selector: string
  /** PKCS8 DER, base64. The unsealed private half. */
  privateKey: string
}

/**
 * Prepends a `DKIM-Signature` header to a complete RFC 5322 message.
 *
 * ⚠ IT SIGNS THE BYTES WE ALREADY BUILT RATHER THAN BUILDING ITS OWN. The same
 * `buildRawMessage` produces the message on both routes, so what a recipient
 * receives does not depend on which MTA carried it — which is the whole promise
 * of a per-domain route lever. Letting a second library compose the MIME for
 * the direct route would make the route observable in the message, and the
 * first bug it caused would look like a mail-client rendering quirk.
 */
/**
 * The headers the signature covers.
 *
 * ⚠ SET EXPLICITLY RATHER THAN INHERITED, BECAUSE THE DEFAULT IS NARROWER THAN
 * IT LOOKS. nodemailer defaults to `from:subject:date:to` — four headers. `From`
 * alone is what DMARC alignment needs, so the default is not wrong, but every
 * header left out is one an intermediary can rewrite without breaking the
 * signature. These are the headers `buildRawMessage` actually emits.
 *
 * ⚠ A HEADER NAMED HERE THAT THE MESSAGE DOES NOT CARRY IS SIMPLY DROPPED, so
 * this list does not have to be conditional on whether a given message has a
 * `Cc`. Measured rather than assumed: a message without `Cc` or `Reply-To`
 * signs `from:to:subject:date:message-id:mime-version:content-type:
 * content-transfer-encoding`, and the same message with both signs those two as
 * well. (RFC 6376 §5.4 would also permit signing an absent header as empty —
 * nodemailer does not do that, and the outcome here is the same either way.)
 */
const SIGNED_HEADERS = [
  "from",
  "to",
  "cc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
].join(":")

export async function signMessage(
  raw: string,
  domain: string,
  key: DkimKey,
): Promise<string> {
  // The signer wants PEM; the column holds bare base64 DER, which is what
  // `generateDkimKeypair` produces and what the SES upload expects.
  const pem = toPem(key.privateKey)

  const signer = new DKIM({
    domainName: domain,
    keySelector: key.selector,
    privateKey: pem,
    hashAlgo: "sha256",
    headerFieldNames: SIGNED_HEADERS,
  })

  const chunks: Buffer[] = []
  for await (const chunk of signer.sign(raw)) {
    chunks.push(Buffer.from(chunk as Buffer))
  }
  const signed = Buffer.concat(chunks).toString("utf8")

  // ⚠ AN UNUSABLE KEY PRODUCES UNSIGNED OUTPUT AND NO ERROR, so this check is
  // the whole guard and not a formality. Measured against both signers: hand
  // either one a key it cannot load and it returns the message essentially
  // untouched, with nothing thrown and nothing logged. Without this the send
  // path would hand Stalwart an unsigned message and record it as signed.
  if (!/^DKIM-Signature:/i.test(signed)) {
    throw new Error(`DKIM signing produced no signature for ${domain}`)
  }

  // ⚠ THE SIGNER PREPENDS, AND THAT MATTERS RATHER THAN BEING INCIDENTAL. RFC
  // 6376 §3.5 lets a verifier find the header anywhere, but relaxed
  // canonicalization hashes the headers named in `h=` in the order they appear —
  // and a signature placed after a header it covers is the classic way to
  // produce one that verifies for the signer and fails for everybody else.
  return signed
}

/**
 * ⚠ BASE64 DER IN THE COLUMN, PEM AT THE LIBRARY BOUNDARY, AND THE CONVERSION
 * BELONGS HERE. `generateDkimKeypair` stores the DER because that is the form
 * SES's `SigningAttributes` wants, and changing the stored shape to suit this
 * signer would mean rewriting every existing row and re-uploading every
 * identity. One function that adds the armour is the cheaper half.
 */
function toPem(base64Der: string): string {
  const body =
    base64Der
      .replace(/\s+/g, "")
      .match(/.{1,64}/g)
      ?.join("\n") ?? ""
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}
