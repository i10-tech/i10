import type { KeyObject } from "node:crypto"
import { SignedXml } from "xml-crypto"
import {
  decryptAssertion,
  pemOf,
  usableAt,
  type IdpCertificate,
} from "./saml-crypto.js"
import {
  MESSAGE_LIMITS,
  NS,
  XmlRefused,
  attrOf,
  childrenOf,
  elementsOf,
  everyNamed,
  is,
  onlyChild,
  parseXml,
  textOf,
} from "./saml-xml.js"

/**
 * Verifying a SAML response (#339, sso.md Option A): xml-crypto 6 checks the
 * cryptography; everything around it is ours, and it is the part that the
 * published advisories were about.
 *
 * The structural rules follow Better Auth's `saml/assertions.ts` (MIT,
 * better-auth/better-auth, read at f9ac706 on 2026-10-19): exactly one
 * Assertion, a direct child of the Response; exactly one Signature in it;
 * decoy signatures of any namespace are not let through; the data is read
 * from what was signed, never from the document around it. No code was
 * copied; the rules are restated here so this file can be read on its own.
 *
 *   1. Parse with the hardened parser (identity/saml-xml.ts): no DTD, no
 *      entities, no comments, no processing instructions, bounded size.
 *   2. Shape: one Response (protocol namespace, Version 2.0); one Assertion or
 *      EncryptedAssertion anywhere in the document, as its direct child; every
 *      Signature (by local name, any namespace) is either the Response's own
 *      or the Assertion's own, in the xmldsig namespace, one each at most;
 *      every ID-like attribute value is unique in the document.
 *   3. Signature on the ASSERTION, required: one Reference, `#<its ID>`,
 *      transforms limited to enveloped-signature plus one canonicalization
 *      without comments, RSA-SHA256 or better, SHA-256 or better, verified
 *      against the connection's own certificates only - never KeyInfo.
 *   4. The signed reference (what xml-crypto canonicalised and digested) is
 *      parsed again and must be an Assertion with the same ID. Every value
 *      below is read from THAT, not from the original tree.
 *   5. Issuer, audience, recipient, InResponseTo, time windows with 2 minutes
 *      of skew, a bearer confirmation, one AuthnStatement.
 *
 * A Response signature, when the IdP adds one, must verify too; it is never
 * a substitute for the Assertion's (node-saml CVE-2025-54419 is what reading
 * an unsigned assertion inside a signed response looks like).
 */

export const SAML_SKEW_MS = 2 * 60 * 1000
/** An IdP-initiated assertion must have been issued this recently. */
export const UNSOLICITED_MAX_AGE_MS = 3 * 60 * 1000
/** The longest a replay-cache entry is kept, whatever NotOnOrAfter says. */
export const REPLAY_MAX_MS = 24 * 60 * 60 * 1000

const C14N_EXC = "http://www.w3.org/2001/10/xml-exc-c14n#"
const C14N_INC = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
const ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature"

/** RSA-SHA256 or better. Never SHA-1, never HMAC. */
export const SIGNATURE_ALGORITHMS = [
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
  "http://www.w3.org/2007/05/xmldsig-more#sha256-rsa-MGF1",
] as const
export const DIGEST_ALGORITHMS = [
  "http://www.w3.org/2001/04/xmlenc#sha256",
  "http://www.w3.org/2001/04/xmlenc#sha512",
] as const
const CANONICALIZATIONS = [C14N_EXC, C14N_INC] as const

const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer"
const SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success"
export const NAMEID = {
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  email: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  entity: "urn:oasis:names:tc:SAML:2.0:nameid-format:entity",
} as const
/**
 * NameID formats a person can be linked by. Transient changes every sign-in,
 * and the others (X.509 subject, Windows, Kerberos) are not identifiers IdPs
 * send to an SP like us.
 */
export const LINKABLE_NAMEID: readonly string[] = [
  NAMEID.persistent,
  NAMEID.email,
  NAMEID.unspecified,
]

/** What a verification needs to know. Nothing here is from the message. */
export interface Expectations {
  /** The IdP's entity id, exactly as configured. */
  idpEntityId: string
  /** Our SP entity id for this connection: the only acceptable Audience. */
  spEntityId: string
  /** Our ACS URL for this connection: Recipient, and Destination when present. */
  acsUrl: string
  certificates: readonly IdpCertificate[]
  /** Our SP private keys, newest first, for encrypted assertions. */
  decryptionKeys: readonly KeyObject[]
  requireEncryption: boolean
  /**
   * The AuthnRequest ID this response must answer, or null for an
   * IdP-initiated response, which must then answer nothing.
   */
  inResponseTo: string | null
  now: Date
}

export interface VerifiedAssertion {
  id: string
  issuer: string
  nameId: string
  nameIdFormat: string
  sessionIndex: string | null
  issueInstant: Date
  authnInstant: Date
  authnContextClassRef: string | null
  /** Until when the assertion could be presented: the replay cache's horizon. */
  validUntil: Date
  attributes: Record<string, string[]>
  encrypted: boolean
}

export type Verdict =
  | { ok: true; assertion: VerifiedAssertion }
  /** `failure` is a fixed code: audited, never the document. */
  | { ok: false; failure: string; status?: string }

class Refused extends Error {
  constructor(
    readonly failure: string,
    readonly status?: string,
  ) {
    super(failure)
  }
}
const refuse = (failure: string, status?: string): never => {
  throw new Refused(failure, status)
}

const ID = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/
const ID_ATTRIBUTES = new Set(["ID", "Id", "id", "AssertionID"])

/** A base64 POST parameter (`SAMLResponse`), decoded strictly. */
export function decodePostParameter(value: string, maxChars: number): string {
  const compact = value.replace(/[\r\n\t ]/g, "")
  if (compact.length > Math.ceil((maxChars * 4) / 3) + 4) refuse("too_large")
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) refuse("not_base64")
  const bytes = Buffer.from(compact, "base64")
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return refuse("not_utf8")
  }
}

/**
 * The whole check. Never throws for anything a sender controls: every
 * refusal is `{ ok: false }` with a code, and the fuzz pass holds it to that.
 */
export function verifySamlResponse(
  samlResponse: string,
  expect: Expectations,
): Verdict {
  try {
    return { ok: true, assertion: verify(samlResponse, expect) }
  } catch (error) {
    if (error instanceof Refused)
      return {
        ok: false,
        failure: error.failure,
        ...(error.status ? { status: error.status } : {}),
      }
    if (error instanceof XmlRefused)
      return { ok: false, failure: `xml_${error.failure}` }
    return { ok: false, failure: "unverifiable" }
  }
}

function verify(samlResponse: string, expect: Expectations): VerifiedAssertion {
  const xml = decodePostParameter(samlResponse, MESSAGE_LIMITS.maxChars)
  const doc = parseXml(xml)
  const response = doc.documentElement
  if (!is(response, NS.protocol, "Response")) refuse("not_a_response")
  if (attrOf(response, "Version") !== "2.0") refuse("version")
  uniqueIds(response)

  // ── Shape: one of everything, where it belongs ──
  if (everyNamed(response, "Response").length !== 1) refuse("multiple_responses")
  const plain = everyNamed(response, "Assertion")
  const sealed = everyNamed(response, "EncryptedAssertion")
  if (plain.length + sealed.length !== 1) refuse("assertion_count")
  const top = elementsOf(response)
  const assertionChild = top.find(
    (el) =>
      is(el, NS.assertion, "Assertion") || is(el, NS.assertion, "EncryptedAssertion"),
  )
  if (!assertionChild || (plain[0] ?? sealed[0]) !== assertionChild)
    refuse("assertion_position")

  // The Response's own signature, if any: allowed only as its direct child.
  const responseSignatures = childrenOf(response, NS.ds, "Signature")
  if (responseSignatures.length > 1) refuse("multiple_signatures")

  // ── Status: anything but Success is the IdP saying no ──
  const status = onlyChild(response, NS.protocol, "Status")
  const code = status ? onlyChild(status, NS.protocol, "StatusCode") : null
  const statusValue = code ? attrOf(code, "Value") : null
  if (statusValue !== SUCCESS)
    refuse(
      "status",
      statusValue && /^[\w:.-]{1,200}$/.test(statusValue) ? statusValue : "unknown",
    )

  // ── Destination on the envelope: checked when present ──
  const destination = attrOf(response, "Destination")
  if (destination !== null && destination !== expect.acsUrl) refuse("destination")

  // ── The Response signature, which never replaces the Assertion's ──
  let responseSigned = false
  if (responseSignatures.length === 1) {
    checkSignature(xml, response, responseSignatures[0]!, expect)
    responseSigned = true
  }

  // ── The assertion: decrypted, then held to the same rules ──
  let assertionXml: string
  let assertionDocRoot: Element
  let encrypted = false
  if (sealed.length === 1) {
    encrypted = true
    // Before decryption the only Signature allowed is the Response's.
    if (everyNamed(response, "Signature").length !== responseSignatures.length)
      refuse("decoy_signature")
    assertionXml = decryptAssertion(sealed[0]!, expect.decryptionKeys)
    const inner = parseXml(assertionXml)
    assertionDocRoot = inner.documentElement
    if (!is(assertionDocRoot, NS.assertion, "Assertion")) refuse("not_an_assertion")
    uniqueIds(assertionDocRoot)
    if (everyNamed(assertionDocRoot, "Assertion").length !== 1)
      refuse("assertion_count")
  } else {
    if (expect.requireEncryption) refuse("not_encrypted")
    assertionXml = xml
    assertionDocRoot = plain[0]!
  }

  const assertionSignatures = childrenOf(assertionDocRoot, NS.ds, "Signature")
  if (assertionSignatures.length === 0) refuse("assertion_unsigned")
  if (assertionSignatures.length > 1) refuse("multiple_signatures")
  // ⚠ DECOYS: a Signature anywhere else, in any namespace, is refused outright
  // rather than stripped. Nothing honest puts one there.
  const allowed = new Set<Element>([
    assertionSignatures[0]!,
    ...(encrypted ? [] : responseSignatures),
  ])
  const scope = encrypted ? assertionDocRoot : response
  for (const s of everyNamed(scope, "Signature"))
    if (!allowed.has(s)) refuse("decoy_signature")

  const signed = checkSignature(
    assertionXml,
    assertionDocRoot,
    assertionSignatures[0]!,
    expect,
  )

  // ── From here on, only what was signed ──
  const signedDoc = parseXml(signed)
  const assertion = signedDoc.documentElement
  if (!is(assertion, NS.assertion, "Assertion")) refuse("signed_reference")
  if (attrOf(assertion, "ID") !== attrOf(assertionDocRoot, "ID"))
    refuse("signed_reference")
  if (everyNamed(assertion, "Assertion").length !== 1) refuse("assertion_count")
  if (everyNamed(assertion, "Signature").length !== 0) refuse("decoy_signature")
  return readAssertion(assertion, expect, encrypted, responseSigned ? response : null)
}

/**
 * Every ID-like attribute in the tree, any namespace, is unique.
 *
 * ⚠ xml-crypto FINDS A REFERENCE BY ANY ATTRIBUTE WHOSE LOCAL NAME IS `ID`,
 * `Id` OR `id`. It refuses two elements with one value, but only among those;
 * checking every one (and `AssertionID`) up front means no element can stand
 * in for the one we think was signed.
 */
export function uniqueIds(root: Element) {
  const seen = new Set<string>()
  const walk = (el: Element) => {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes.item(i)!
      const local = a.localName ?? a.name
      if (!ID_ATTRIBUTES.has(local)) continue
      if (seen.has(a.value)) refuse("duplicate_id")
      seen.add(a.value)
    }
    for (const child of elementsOf(el)) walk(child)
  }
  walk(root)
}

/**
 * One enveloped signature over `target`, checked: its shape by us, its
 * cryptography by xml-crypto against each usable certificate. Returns the
 * canonical XML xml-crypto verified the digest of.
 *
 * ⚠ THE SHAPE IS OURS AND STRICTER THAN THE SPEC. One SignedInfo, one
 * Reference and it names `target`'s own ID (never `""`, never another
 * element: "signature over the wrong reference"); transforms are exactly
 * enveloped-signature plus at most one canonicalization, never a WithComments
 * one, never XPath or XSLT; no `<Object>` (where XSW8 hides the original), no
 * HMAC output length, nothing we did not expect.
 */
export function checkSignature(
  xml: string,
  target: Element,
  signature: Element,
  expect: Pick<Expectations, "certificates" | "now">,
): string {
  const id = attrOf(target, "ID")
  if (!id || !ID.test(id)) refuse("bad_id")

  const parts = elementsOf(signature)
  const signedInfo = onlyChild(signature, NS.ds, "SignedInfo")
  const value = onlyChild(signature, NS.ds, "SignatureValue")
  if (!signedInfo || !value) refuse("signature_shape")
  for (const el of parts)
    if (!(
      is(el, NS.ds, "SignedInfo") ||
      is(el, NS.ds, "SignatureValue") ||
      is(el, NS.ds, "KeyInfo")
    ))
      refuse("signature_shape")
  if (childrenOf(signature, NS.ds, "KeyInfo").length > 1) refuse("signature_shape")
  const sigValue = textOf(value)
  if (sigValue === null || !/^[A-Za-z0-9+/=\s]+$/.test(sigValue))
    refuse("signature_shape")

  const info = elementsOf(signedInfo!)
  const c14n = onlyChild(signedInfo!, NS.ds, "CanonicalizationMethod")
  const method = onlyChild(signedInfo!, NS.ds, "SignatureMethod")
  const references = childrenOf(signedInfo!, NS.ds, "Reference")
  if (!c14n || !method || info.length !== 2 + references.length)
    refuse("signature_shape")
  if (references.length !== 1) refuse("reference_count")
  if (
    !(CANONICALIZATIONS as readonly string[]).includes(attrOf(c14n!, "Algorithm") ?? "")
  )
    refuse("canonicalization")
  canonicalizationChildrenOk(c14n!)
  if (
    !(SIGNATURE_ALGORITHMS as readonly string[]).includes(
      attrOf(method!, "Algorithm") ?? "",
    )
  )
    refuse("signature_algorithm")
  if (elementsOf(method!).length) refuse("signature_algorithm")

  const reference = references[0]!
  if (attrOf(reference, "URI") !== `#${id}`) refuse("wrong_reference")
  const refParts = elementsOf(reference)
  const transforms = onlyChild(reference, NS.ds, "Transforms")
  const digest = onlyChild(reference, NS.ds, "DigestMethod")
  const digestValue = onlyChild(reference, NS.ds, "DigestValue")
  if (!digest || !digestValue || refParts.length !== (transforms ? 3 : 2))
    refuse("signature_shape")
  if (
    !(DIGEST_ALGORITHMS as readonly string[]).includes(
      attrOf(digest!, "Algorithm") ?? "",
    )
  )
    refuse("digest_algorithm")
  if (elementsOf(digest!).length) refuse("digest_algorithm")
  const digestText = textOf(digestValue)
  if (digestText === null || !/^[A-Za-z0-9+/=\s]+$/.test(digestText))
    refuse("signature_shape")

  const steps = transforms ? elementsOf(transforms) : []
  if (!transforms || steps.length === 0 || steps.length > 2) refuse("transforms")
  steps.forEach((step, i) => {
    if (!is(step, NS.ds, "Transform")) refuse("transforms")
    const algorithm = attrOf(step, "Algorithm")
    if (
      i === 0
        ? algorithm !== ENVELOPED
        : !(CANONICALIZATIONS as readonly string[]).includes(algorithm ?? "")
    )
      refuse("transforms")
    if (i === 0 && elementsOf(step).length) refuse("transforms")
    if (i === 1) canonicalizationChildrenOk(step)
  })

  // ⚠ THE SIGNATURE MUST SIT INSIDE WHAT IT SIGNS (enveloped), AS ITS CHILD.
  if (signature.parentNode !== target) refuse("signature_position")

  const usable = expect.certificates.filter((c) => usableAt(c, expect.now))
  if (usable.length === 0) refuse("no_usable_certificate")
  for (const cert of usable) {
    const signer = new SignedXml({ publicCert: pemOf(cert.certificate) })
    // ⚠ NEVER THE KEY THE MESSAGE BRINGS (xml-crypto CVE-2024-32962): only ours.
    signer.getCertFromKeyInfo = () => null
    signer.SignatureAlgorithms = restrict(
      signer.SignatureAlgorithms,
      SIGNATURE_ALGORITHMS,
    )
    signer.HashAlgorithms = restrict(signer.HashAlgorithms, DIGEST_ALGORITHMS)
    signer.CanonicalizationAlgorithms = restrict(signer.CanonicalizationAlgorithms, [
      ...CANONICALIZATIONS,
      ENVELOPED,
    ])
    // A certificate that does not verify (xml-crypto throws on a wrong value)
    // means "try the next one"; none verifying is `bad_signature` below.
    let good = false
    try {
      signer.loadSignature(signature)
      good = signer.checkSignature(xml)
    } catch {
      good = false
    }
    if (!good) continue
    const signed = signer.getSignedReferences()
    if (signed.length !== 1 || typeof signed[0] !== "string") refuse("signed_reference")
    return signed[0]!
  }
  return refuse("bad_signature")
}

function canonicalizationChildrenOk(el: Element) {
  for (const child of elementsOf(el))
    if (!is(child, "http://www.w3.org/2001/10/xml-exc-c14n#", "InclusiveNamespaces"))
      refuse("canonicalization")
}

function restrict<T>(
  registry: Record<string, T>,
  allowed: readonly string[],
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const uri of allowed) if (Object.hasOwn(registry, uri)) out[uri] = registry[uri]!
  return out
}

// ── Reading what was signed ──────────────────────────────────────────────

const instant = (value: string | null, failure: string): Date => {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return refuse(failure)
  const t = new Date(value)
  return Number.isNaN(t.getTime()) ? refuse(failure) : t
}
const optionalInstant = (value: string | null, failure: string) =>
  value === null ? null : instant(value, failure)

function readAssertion(
  assertion: Element,
  expect: Expectations,
  encrypted: boolean,
  signedResponse: Element | null,
): VerifiedAssertion {
  const now = expect.now.getTime()
  if (attrOf(assertion, "Version") !== "2.0") refuse("version")
  const id = attrOf(assertion, "ID")!
  const issueInstant = instant(attrOf(assertion, "IssueInstant"), "issue_instant")
  if (issueInstant.getTime() > now + SAML_SKEW_MS) refuse("issue_instant")

  // ── Issuer: the connection's IdP, exactly ──
  const issuer = onlyChild(assertion, NS.assertion, "Issuer")
  const issuerValue = textOf(issuer)?.trim() ?? null
  if (!issuerValue || issuerValue !== expect.idpEntityId) refuse("issuer")
  const issuerFormat = attrOf(issuer!, "Format")
  if (issuerFormat !== null && issuerFormat !== NAMEID.entity) refuse("issuer")

  // ── Subject ──
  const subject = onlyChild(assertion, NS.assertion, "Subject")
  if (!subject) refuse("subject")
  if (
    childrenOf(subject!, NS.assertion, "EncryptedID").length ||
    childrenOf(subject!, NS.assertion, "BaseID").length
  )
    refuse("subject")
  const nameIdEl = onlyChild(subject!, NS.assertion, "NameID")
  const nameId = textOf(nameIdEl)?.trim() ?? ""
  if (!nameId || nameId.length > 240) refuse("name_id")
  const nameIdFormat = attrOf(nameIdEl!, "Format") ?? NAMEID.unspecified
  if (!LINKABLE_NAMEID.includes(nameIdFormat)) refuse("name_id_format")
  const spQualifier = attrOf(nameIdEl!, "SPNameQualifier")
  if (spQualifier !== null && spQualifier !== expect.spEntityId) refuse("name_id")
  const qualifier = attrOf(nameIdEl!, "NameQualifier")
  if (qualifier !== null && qualifier !== expect.idpEntityId) refuse("name_id")

  // ── Bearer confirmation: Recipient, NotOnOrAfter, InResponseTo ──
  let confirmedUntil: number | null = null
  for (const confirmation of childrenOf(
    subject!,
    NS.assertion,
    "SubjectConfirmation",
  )) {
    if (attrOf(confirmation, "Method") !== BEARER) continue
    const data = onlyChild(confirmation, NS.assertion, "SubjectConfirmationData")
    if (!data) continue
    if (attrOf(data, "Recipient") !== expect.acsUrl) continue
    const until = optionalInstant(attrOf(data, "NotOnOrAfter"), "confirmation_time")
    if (!until || until.getTime() <= now - SAML_SKEW_MS) continue
    const notBefore = optionalInstant(attrOf(data, "NotBefore"), "confirmation_time")
    if (notBefore && notBefore.getTime() > now + SAML_SKEW_MS) continue
    const answers = attrOf(data, "InResponseTo")
    if (
      expect.inResponseTo === null ? answers !== null : answers !== expect.inResponseTo
    )
      continue
    confirmedUntil = Math.max(confirmedUntil ?? 0, until.getTime())
  }
  if (confirmedUntil === null) refuse("subject_confirmation")

  // A signed Response's InResponseTo is signed too, so it must agree.
  if (signedResponse) {
    const outer = attrOf(signedResponse, "InResponseTo")
    if (expect.inResponseTo === null ? outer !== null : outer !== expect.inResponseTo)
      refuse("in_response_to")
  }
  if (
    expect.inResponseTo === null &&
    now - issueInstant.getTime() > UNSOLICITED_MAX_AGE_MS
  )
    refuse("unsolicited_stale")

  // ── Conditions: required, and every one understood ──
  const conditions = onlyChild(assertion, NS.assertion, "Conditions")
  if (!conditions) refuse("conditions")
  const notBefore = optionalInstant(attrOf(conditions!, "NotBefore"), "conditions_time")
  const notOnOrAfter = optionalInstant(
    attrOf(conditions!, "NotOnOrAfter"),
    "conditions_time",
  )
  if (notBefore && notBefore.getTime() > now + SAML_SKEW_MS) refuse("not_yet_valid")
  if (notOnOrAfter && notOnOrAfter.getTime() <= now - SAML_SKEW_MS) refuse("expired")
  let audiences = 0
  for (const condition of elementsOf(conditions!)) {
    if (is(condition, NS.assertion, "AudienceRestriction")) {
      // ⚠ EVERY AudienceRestriction MUST NAME US (SAML core 2.5.1.4: they AND).
      const names = childrenOf(condition, NS.assertion, "Audience").map((a) =>
        textOf(a)?.trim(),
      )
      if (!names.includes(expect.spEntityId)) refuse("audience")
      audiences++
    } else if (
      is(condition, NS.assertion, "OneTimeUse") ||
      is(condition, NS.assertion, "ProxyRestriction")
    ) {
      // OneTimeUse is what the replay cache does anyway.
    } else refuse("unknown_condition")
  }
  if (audiences === 0) refuse("audience")

  // ── Authentication ──
  const statements = childrenOf(assertion, NS.assertion, "AuthnStatement")
  if (statements.length !== 1) refuse("authn_statement")
  const statement = statements[0]!
  const authnInstant = instant(attrOf(statement, "AuthnInstant"), "authn_instant")
  if (authnInstant.getTime() > now + SAML_SKEW_MS) refuse("authn_instant")
  const sessionEnd = optionalInstant(
    attrOf(statement, "SessionNotOnOrAfter"),
    "session_time",
  )
  if (sessionEnd && sessionEnd.getTime() <= now - SAML_SKEW_MS)
    refuse("session_expired")
  const sessionIndex = attrOf(statement, "SessionIndex")
  const context = onlyChild(statement, NS.assertion, "AuthnContext")
  const classRef = context
    ? (textOf(onlyChild(context, NS.assertion, "AuthnContextClassRef"))?.trim() ?? null)
    : null

  // ── Attributes: names to string values, bounded ──
  // ⚠ NO PROTOTYPE: the names are the IdP's, and `__proto__` is a name.
  const attributes: Record<string, string[]> = Object.create(null)
  let count = 0
  for (const block of childrenOf(assertion, NS.assertion, "AttributeStatement"))
    for (const attribute of childrenOf(block, NS.assertion, "Attribute")) {
      const name = attrOf(attribute, "Name")
      if (!name || name.length > 256 || ++count > 100) continue
      /*
       * ⚠ A REPEATED NAME ADDS VALUES, IT DOES NOT REPLACE OR GET DROPPED.
       * Keycloak's group mapper (single off) sends one <Attribute> per group;
       * keeping only the first lost every group after it, and the group rules
       * with them (2026-11-01). The assertion is signed, so a repeat is the
       * IdP's own statement; the 100-value cap still holds per name.
       */
      const values = childrenOf(attribute, NS.assertion, "AttributeValue")
        .map((v) => textOf(v))
        .filter((v): v is string => v !== null && v.length <= 1024)
      attributes[name] = [...(attributes[name] ?? []), ...values].slice(0, 100)
    }

  const horizon = Math.min(
    confirmedUntil!,
    notOnOrAfter ? notOnOrAfter.getTime() : Number.POSITIVE_INFINITY,
  )
  return {
    id,
    issuer: issuerValue!,
    nameId,
    nameIdFormat,
    sessionIndex: sessionIndex && sessionIndex.length <= 256 ? sessionIndex : null,
    issueInstant,
    authnInstant,
    authnContextClassRef: classRef && classRef.length <= 256 ? classRef : null,
    validUntil: new Date(horizon + SAML_SKEW_MS),
    attributes,
    encrypted,
  }
}
