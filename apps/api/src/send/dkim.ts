import { dkimSign } from "mailauth"

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
export async function signMessage(
  raw: string,
  domain: string,
  key: DkimKey,
): Promise<string> {
  // mailauth wants PEM; the column holds bare base64 DER, which is what
  // `generateDkimKeypair` produces and what the SES upload expects.
  const pem = toPem(key.privateKey)

  // ⚠ `signatureData`, NOT THE TOP-LEVEL FIELDS ITS TYPES DEMAND, AND THE CAST
  // IS THERE BECAUSE mailauth@5's `.d.ts` DISAGREES WITH ITS OWN RUNTIME.
  // `DKIMSignOptions` marks `signingDomain`, `selector` and `privateKey` as
  // required at the top level and `signatureData` as optional. Passing them the
  // way the types ask returns `{ signatures: "\r\n", errors: [] }` — no
  // signature, no error, no clue — and the message goes out unsigned. Measured
  // both ways against 5.0.3 on 2026-09-16.
  const result = (await dkimSign(raw, {
    canonicalization: "relaxed/relaxed",
    algorithm: "rsa-sha256",
    signatureData: [{ signingDomain: domain, selector: key.selector, privateKey: pem }],
  } as never)) as { signatures?: string; errors?: Error[] }

  // ⚠ `errors` IS POPULATED WITHOUT THROWING, so a signer that failed returns a
  // result like any other and an empty `signatures` is the only symptom. Left
  // unchecked this would prepend nothing and send an unsigned message that our
  // own logs would call signed.
  if (result.errors?.length) {
    throw new Error(
      `DKIM signing failed for ${domain}: ${result.errors.map((e) => e.message).join("; ")}`,
    )
  }
  // ⚠ THE EMPTY ANSWER IS `"\r\n"`, NOT `""`, SO A FALSY CHECK MISSES IT. That
  // is precisely how the types-versus-runtime mismatch above reached a passing
  // test once: a truthy string got prepended, the message looked signed in
  // every log, and no verifier anywhere would have accepted it.
  const header = result.signatures
  if (!header?.trim()) {
    throw new Error(`DKIM signing produced no signature for ${domain}`)
  }

  // ⚠ PREPENDED, NOT APPENDED, AND NOT INSERTED AMONG THE OTHERS. RFC 6376 §3.5
  // lets a verifier find the header anywhere, but relaxed canonicalization
  // hashes the headers named in `h=` in the order they appear — and a signature
  // placed after a header it covers is the classic way to produce one that
  // verifies for the signer and fails for everybody else.
  return header + raw
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
