import { signMessage as signRaw } from "@upyo/mime/internal"

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
 * ⚠ THE LIBRARY IS upyo'S AS OF 2026-09-17, AND THE MOVE OFF nodemailer BOUGHT
 * THREE THINGS RATHER THAN A PREFERENCE. It takes the bare base64 DER this
 * column already holds, so the PEM re-armouring step is gone. It THROWS on a key
 * it cannot import, where nodemailer returned the message essentially untouched
 * and left a hand-written guard as the only thing between an unusable key and
 * mail recorded as signed. And it signs with Web Crypto rather than `node:crypto`,
 * which is what lets this same function run in a Worker — the constraint that
 * decided the library, since `nodemailer` can never follow us there.
 *
 * ⚠ VERIFIED AGAINST AN INDEPENDENT VERIFIER, NOT AGAINST ITSELF. Signatures
 * over eight message shapes — plain text, `multipart/alternative`,
 * `multipart/mixed` with an attachment, unicode subject and body, custom
 * headers, a 300-character subject, and messages with and without `Cc`/
 * `Reply-To` — were checked with mailauth's verifier and all returned `pass`.
 * A signer tested only by its own library is a signer tested by nobody.
 *
 * ⚠ AND `@upyo/mime/internal` IS A DECLARED SUBPATH, BUT A WEAKER PROMISE THAN
 * THE ROOT. Its `exports` map publishes it deliberately, so this is not a reach
 * into `dist/`; the package documents it as "additively compatible within a
 * minor release line". That is why `@upyo/mime` is pinned exactly in
 * package.json rather than carried on a caret — a minor bump is the one thing
 * allowed to move this surface, so it should be a deliberate edit.
 *
 * ⚠ THE ROOT API IS NOT AN OPTION HERE, AND THAT IS THE WHOLE REASON THIS
 * SUBPATH IS WORTH THE WEAKER PROMISE. `composeMessage` signs a message it
 * builds itself; we need the signature over bytes `buildRawMessage` already
 * produced, because the SES route sends those same bytes. Composing twice is
 * how a route lever stops being invisible.
 */

export interface DkimKey {
  /** The DNS label the public half is published under. */
  selector: string
  /** PKCS8 DER, base64. The unsealed private half. */
  privateKey: string
}

/**
 * The headers the signature covers.
 *
 * ⚠ SET EXPLICITLY RATHER THAN INHERITED, BECAUSE THE DEFAULT IS NARROWER THAN
 * IT LOOKS. upyo defaults to `from:to:subject:date` — four headers. `From` alone
 * is what DMARC alignment needs, so the default is not wrong, but every header
 * left out is one an intermediary can rewrite without breaking the signature.
 * These are the headers `buildRawMessage` actually emits.
 *
 * ⚠ A HEADER NAMED HERE THAT THE MESSAGE DOES NOT CARRY STAYS IN `h=` AND IS
 * HASHED AS NOTHING, WHICH IS A CHANGE FROM nodemailer AND IS THE BETTER
 * BEHAVIOUR. nodemailer dropped the absent name from the tag; upyo leaves it,
 * which RFC 6376 §3.7 covers — a verifier treats a name in `h=` with no matching
 * header as the null string. That is "oversigning", and it is what stops an
 * intermediary ADDING a `Cc` the signature never covered.
 *
 * ⚠ MEASURED, NOT ASSUMED, BECAUSE THE FAILURE WOULD BE SILENT. A message with
 * no `Cc` and no `Reply-To` still lists both in `h=`, and mailauth verifies it
 * `pass` — checked alongside the same message carrying both. Getting this wrong
 * produces a signature that verifies for us and nowhere else.
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
]

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
  signal?: AbortSignal,
): Promise<string> {
  // ⚠ THE COLUMN'S BARE BASE64 DER GOES STRAIGHT IN, AND THE PEM WRAPPER THAT
  // USED TO LIVE HERE IS GONE. upyo strips any armour and base64-decodes what
  // is left before handing it to `crypto.subtle.importKey`, so an unarmoured
  // PKCS8 DER — which is what `generateDkimKeypair` stores and what SES's
  // `SigningAttributes` wants — imports as-is. Confirmed by signing with a
  // stored key and verifying externally.
  const { headerName, signature } = await signRaw(
    raw,
    {
      signingDomain: domain,
      selector: key.selector,
      privateKey: key.privateKey,
      algorithm: "rsa-sha256",
      canonicalization: "relaxed/relaxed",
      headerFields: SIGNED_HEADERS,
    },
    signal,
  )

  // ⚠ NO "DID IT ACTUALLY SIGN?" GUARD, BECAUSE THE FAILURE MODE IT WATCHED FOR
  // IS GONE. nodemailer handed back the message essentially untouched when it
  // could not load a key — nothing thrown, nothing logged — so a regex for
  // `DKIM-Signature:` was the only thing standing between an unusable key and a
  // message recorded as signed. upyo throws `Failed to import private key`
  // instead, and a check that can no longer fire is a check that rots.
  //
  // ⚠ AND THAT THROW IS LOAD-BEARING, NOT INCIDENTAL. `stalwartTransport`
  // catches it as `rejected`; there is a test asserting an unusable key stops
  // the send rather than producing a header that verifies nowhere.

  // ⚠ PREPENDED, AND THAT MATTERS RATHER THAN BEING INCIDENTAL. RFC 6376 §3.5
  // lets a verifier find the header anywhere, but relaxed canonicalization
  // hashes the headers named in `h=` in the order they appear — and a signature
  // placed after a header it covers is the classic way to produce one that
  // verifies for the signer and fails for everybody else.
  //
  // ⚠ upyo RETURNS THE VALUE, NOT THE MESSAGE, WHICH IS WHY THIS CONCATENATION
  // IS OURS. nodemailer's signer was a stream that emitted the whole signed
  // message; this is a function returning `{ headerName, signature }`. The
  // assembly is one line and it is explicit about where the header lands.
  //
  // The value is not folded. At 566 characters for our header set and an
  // RSA-2048 key it is comfortably inside RFC 5322's 998-octet line limit, and
  // measured at 582 including the header name — folding it would mean
  // re-implementing FWS rules for no gain.
  return `${headerName}: ${signature}\r\n${raw}`
}
