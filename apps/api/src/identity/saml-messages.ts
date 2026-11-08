import {
  X509Certificate,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify,
  type KeyObject,
} from "node:crypto"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import {
  certificateFromDer,
  usableAt,
  type IdpCertificate,
  type SpCertificate,
} from "./saml-crypto.js"
import {
  NAMEID,
  SAML_SKEW_MS,
  checkSignature,
  uniqueIds,
  decodePostParameter,
} from "./saml-verify.js"
import {
  MESSAGE_LIMITS,
  METADATA_LIMITS,
  NS,
  XmlRefused,
  attrOf,
  childrenOf,
  escapeXml,
  everyNamed,
  is,
  onlyChild,
  parseXml,
  textOf,
} from "./saml-xml.js"

/**
 * The SAML messages we write and the ones besides responses we read (#339):
 * AuthnRequest and LogoutRequest/LogoutResponse over the HTTP-Redirect
 * binding (signed with the connection's SP key when it has one), our SP
 * metadata, IdP metadata, and an IdP's logout messages over either binding.
 *
 * ⚠ WE WRITE XML AS TEXT, EVERY VALUE ESCAPED. The values are ours (entity
 * ids, URLs, ids we drew) or the IdP's own NameID echoed back in a logout;
 * `escapeXml` is applied to every one regardless.
 */

const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
export const SIG_ALGS: Record<string, "sha256" | "sha512"> = {
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": "sha512",
}
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
const SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success"

/** An ID for something we send: `_` and 40 hex digits, an NCName. */
export function newRequestId(): string {
  return `_${randomBytes(20).toString("hex")}`
}

const instant = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z")

// ── AuthnRequest ─────────────────────────────────────────────────────────

export interface AuthnRequestInput {
  id: string
  now: Date
  destination: string
  acsUrl: string
  spEntityId: string
  nameIdFormat: string
  /**
   * ⚠ THE STEP-UP LEVER (sso.md 2.4). `ForceAuthn="true"` makes the IdP ask
   * again instead of answering from its own session; the bridge then holds
   * `AuthnInstant` to STEP_UP_MAX_AGE_MS, so an IdP that ignores it fails
   * `step_up_stale` rather than passing.
   */
  forceAuthn: boolean
  /** The typed email as `Subject/NameID`, which IdPs such as Keycloak read as a login hint. A hint only, never a check. */
  subjectNameId?: string
}

export function authnRequest(input: AuthnRequestInput): string {
  return (
    `<samlp:AuthnRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}"` +
    ` ID="${escapeXml(input.id)}" Version="2.0" IssueInstant="${instant(input.now)}"` +
    ` Destination="${escapeXml(input.destination)}"` +
    ` AssertionConsumerServiceURL="${escapeXml(input.acsUrl)}"` +
    ` ProtocolBinding="${POST}"` +
    (input.forceAuthn ? ` ForceAuthn="true"` : "") +
    `><saml:Issuer>${escapeXml(input.spEntityId)}</saml:Issuer>` +
    (input.subjectNameId
      ? `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(input.subjectNameId)}</saml:NameID></saml:Subject>`
      : "") +
    `<samlp:NameIDPolicy Format="${escapeXml(input.nameIdFormat)}" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`
  )
}

/**
 * A message on the HTTP-Redirect binding (SAML bindings 3.4): deflated,
 * base64, and, with a key, signed over the exact query octets.
 *
 * ⚠ THE SIGNATURE IS OVER THE URL-ENCODED PARAMETERS IN THIS ORDER, and the
 * receiver checks those octets, not a re-encoding; `URLSearchParams` would
 * encode a space as `+`, which is why this builds the string itself.
 */
export function redirectUrl(
  endpoint: string,
  parameter: "SAMLRequest" | "SAMLResponse",
  xml: string,
  relayState: string | null,
  key: KeyObject | null,
): string {
  const enc = encodeURIComponent
  let query = `${parameter}=${enc(deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"))}`
  if (relayState !== null) query += `&RelayState=${enc(relayState)}`
  if (key) {
    query += `&SigAlg=${enc(RSA_SHA256)}`
    query += `&Signature=${enc(rsaSign("sha256", Buffer.from(query, "utf8"), key).toString("base64"))}`
  }
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query}`
}

// ── Logout ───────────────────────────────────────────────────────────────

export function logoutRequest(input: {
  id: string
  now: Date
  destination: string
  spEntityId: string
  nameId: string
  nameIdFormat: string
  sessionIndex: string | null
}): string {
  return (
    `<samlp:LogoutRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}"` +
    ` ID="${escapeXml(input.id)}" Version="2.0" IssueInstant="${instant(input.now)}"` +
    ` Destination="${escapeXml(input.destination)}">` +
    `<saml:Issuer>${escapeXml(input.spEntityId)}</saml:Issuer>` +
    `<saml:NameID Format="${escapeXml(input.nameIdFormat)}">${escapeXml(input.nameId)}</saml:NameID>` +
    (input.sessionIndex
      ? `<samlp:SessionIndex>${escapeXml(input.sessionIndex)}</samlp:SessionIndex>`
      : "") +
    `</samlp:LogoutRequest>`
  )
}

export function logoutResponse(input: {
  id: string
  now: Date
  destination: string
  spEntityId: string
  inResponseTo: string
  success: boolean
}): string {
  const status = input.success
    ? SUCCESS
    : "urn:oasis:names:tc:SAML:2.0:status:Responder"
  return (
    `<samlp:LogoutResponse xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}"` +
    ` ID="${escapeXml(input.id)}" Version="2.0" IssueInstant="${instant(input.now)}"` +
    ` Destination="${escapeXml(input.destination)}" InResponseTo="${escapeXml(input.inResponseTo)}">` +
    `<saml:Issuer>${escapeXml(input.spEntityId)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>` +
    `</samlp:LogoutResponse>`
  )
}

/** What an IdP's LogoutRequest asks us to end. */
export interface IdpLogout {
  id: string
  nameId: string
  nameIdFormat: string
  sessionIndexes: string[]
}

export type SloRead =
  | { ok: true; kind: "request"; logout: IdpLogout }
  | { ok: true; kind: "response" }
  | { ok: false; failure: string }

export interface SloExpectations {
  idpEntityId: string
  sloUrl: string
  certificates: readonly IdpCertificate[]
  now: Date
}

const MAX_SLO_CHARS = 64 * 1024

/**
 * An IdP logout message on the Redirect binding, from the raw query string.
 *
 * ⚠ THE RAW QUERY, NOT A PARSED ONE. The signature covers the parameters as
 * the IdP encoded them; decoding and re-encoding would change the octets.
 * Each parameter at most once, and a LogoutRequest must be signed: unsigned,
 * anybody could sign anybody out (a denial of service at the very least).
 */
export function readRedirectLogout(rawQuery: string, expect: SloExpectations): SloRead {
  try {
    if (rawQuery.length > MAX_SLO_CHARS) return { ok: false, failure: "too_large" }
    const raw = new Map<string, string>()
    for (const part of rawQuery.replace(/^\?/, "").split("&")) {
      if (!part) continue
      const at = part.indexOf("=")
      const key = at === -1 ? part : part.slice(0, at)
      if (
        !["SAMLRequest", "SAMLResponse", "RelayState", "SigAlg", "Signature"].includes(
          key,
        )
      )
        continue
      if (raw.has(key)) return { ok: false, failure: "duplicate_parameter" }
      raw.set(key, at === -1 ? "" : part.slice(at + 1))
    }
    const kind = raw.has("SAMLRequest")
      ? "SAMLRequest"
      : raw.has("SAMLResponse")
        ? "SAMLResponse"
        : null
    if (!kind || (raw.has("SAMLRequest") && raw.has("SAMLResponse")))
      return { ok: false, failure: "no_message" }
    const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, "%20"))
    const message = inflate(decode(raw.get(kind)!))
    const doc = parseXml(message, MESSAGE_LIMITS)
    const root = doc.documentElement

    if (kind === "SAMLResponse") {
      // ⚠ A LOGOUT RESPONSE CHANGES NOTHING: our sessions ended before we sent
      // the request. It is only where the browser lands afterwards.
      return is(root, NS.protocol, "LogoutResponse")
        ? { ok: true, kind: "response" }
        : { ok: false, failure: "not_a_logout" }
    }
    const sigAlg = raw.has("SigAlg") ? decode(raw.get("SigAlg")!) : null
    const signature = raw.get("Signature")
    if (!sigAlg || signature === undefined) return { ok: false, failure: "unsigned" }
    const hash = SIG_ALGS[sigAlg]
    if (!hash) return { ok: false, failure: "signature_algorithm" }
    let signed = `${kind}=${raw.get(kind)}`
    if (raw.has("RelayState")) signed += `&RelayState=${raw.get("RelayState")}`
    signed += `&SigAlg=${raw.get("SigAlg")}`
    const sig = Buffer.from(decode(signature), "base64")
    const usable = expect.certificates.filter((c) => usableAt(c, expect.now))
    const good = usable.some((c) =>
      rsaVerify(hash, Buffer.from(signed, "utf8"), keyOf(c), sig),
    )
    if (!good)
      return {
        ok: false,
        failure: usable.length ? "bad_signature" : "no_usable_certificate",
      }
    return readLogoutRequest(root, expect)
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof XmlRefused ? `xml_${error.failure}` : "unreadable",
    }
  }
}

/** An IdP logout message on the POST binding: an enveloped XML signature. */
export function readPostLogout(
  parameter: "SAMLRequest" | "SAMLResponse",
  value: string,
  expect: SloExpectations,
): SloRead {
  try {
    const xml = decodePostParameter(value, MAX_SLO_CHARS)
    const doc = parseXml(xml, MESSAGE_LIMITS)
    const root = doc.documentElement
    if (parameter === "SAMLResponse")
      return is(root, NS.protocol, "LogoutResponse")
        ? { ok: true, kind: "response" }
        : { ok: false, failure: "not_a_logout" }
    if (!is(root, NS.protocol, "LogoutRequest"))
      return { ok: false, failure: "not_a_logout" }
    // The same rule as a sign-in: no element may stand in for the signed one.
    uniqueIds(root)
    const signatures = everyNamed(root, "Signature")
    const own = childrenOf(root, NS.ds, "Signature")
    if (own.length !== 1 || signatures.length !== 1)
      return { ok: false, failure: "unsigned" }
    checkSignature(xml, root, own[0]!, expect)
    return readLogoutRequest(root, expect)
  } catch (error) {
    if (error instanceof XmlRefused)
      return { ok: false, failure: `xml_${error.failure}` }
    const failure = (error as { failure?: unknown }).failure
    return { ok: false, failure: typeof failure === "string" ? failure : "unreadable" }
  }
}

function readLogoutRequest(root: Element, expect: SloExpectations): SloRead {
  if (!is(root, NS.protocol, "LogoutRequest"))
    return { ok: false, failure: "not_a_logout" }
  if (attrOf(root, "Version") !== "2.0") return { ok: false, failure: "version" }
  const id = attrOf(root, "ID")
  if (!id || !/^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(id))
    return { ok: false, failure: "bad_id" }
  const issuer = textOf(onlyChild(root, NS.assertion, "Issuer"))?.trim()
  if (issuer !== expect.idpEntityId) return { ok: false, failure: "issuer" }
  const destination = attrOf(root, "Destination")
  if (destination !== null && destination !== expect.sloUrl)
    return { ok: false, failure: "destination" }
  const now = expect.now.getTime()
  const issued = new Date(attrOf(root, "IssueInstant") ?? "")
  if (
    Number.isNaN(issued.getTime()) ||
    Math.abs(now - issued.getTime()) > 5 * 60 * 1000
  )
    return { ok: false, failure: "issue_instant" }
  const notOnOrAfter = attrOf(root, "NotOnOrAfter")
  if (notOnOrAfter !== null) {
    const until = new Date(notOnOrAfter)
    if (Number.isNaN(until.getTime()) || until.getTime() <= now - SAML_SKEW_MS)
      return { ok: false, failure: "expired" }
  }
  const nameIdEl = onlyChild(root, NS.assertion, "NameID")
  const nameId = textOf(nameIdEl)?.trim()
  if (!nameIdEl || !nameId || nameId.length > 240)
    return { ok: false, failure: "name_id" }
  const sessionIndexes = childrenOf(root, NS.protocol, "SessionIndex")
    .map((el) => textOf(el)?.trim() ?? "")
    .filter((v) => v.length > 0 && v.length <= 256)
    .slice(0, 20)
  return {
    ok: true,
    kind: "request",
    logout: {
      id,
      nameId,
      nameIdFormat: attrOf(nameIdEl, "Format") ?? NAMEID.unspecified,
      sessionIndexes,
    },
  }
}

function inflate(value: string): string {
  const compact = value.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new XmlRefused("not_base64")
  let out: Buffer
  try {
    // ⚠ BOUNDED: a deflate bomb is the redirect binding's billion laughs.
    out = inflateRawSync(Buffer.from(compact, "base64"), {
      maxOutputLength: MAX_SLO_CHARS,
    })
  } catch {
    throw new XmlRefused("not_deflate")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(out)
  } catch {
    throw new XmlRefused("not_utf8")
  }
}

const keyOf = (cert: IdpCertificate): KeyObject =>
  new X509Certificate(Buffer.from(cert.certificate, "base64")).publicKey

// ── SP metadata ──────────────────────────────────────────────────────────

/**
 * Our metadata for one connection: what an IdP needs to trust us.
 *
 * ⚠ `WantAssertionsSigned="true"` IS A STATEMENT OF FACT, not a request: an
 * unsigned assertion is refused whatever the response says.
 */
export function spMetadata(input: {
  entityId: string
  acsUrl: string
  sloUrl: string
  nameIdFormat: string
  certificates: readonly SpCertificate[]
  signsRequests: boolean
}): string {
  const keys = input.certificates
    .map((c) =>
      ["signing", "encryption"]
        .map(
          (use) =>
            `<md:KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${c.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
            (use === "encryption"
              ? `<md:EncryptionMethod Algorithm="${NS.xenc11}aes256-gcm"/><md:EncryptionMethod Algorithm="${NS.xenc}aes256-cbc"/><md:EncryptionMethod Algorithm="${NS.xenc}rsa-oaep-mgf1p"/>`
              : "") +
            `</md:KeyDescriptor>`,
        )
        .join(""),
    )
    .join("")
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="${NS.metadata}" xmlns:ds="${NS.ds}" entityID="${escapeXml(input.entityId)}">` +
    `<md:SPSSODescriptor protocolSupportEnumeration="${NS.protocol}" AuthnRequestsSigned="${input.signsRequests}" WantAssertionsSigned="true">` +
    keys +
    `<md:SingleLogoutService Binding="${REDIRECT}" Location="${escapeXml(input.sloUrl)}"/>` +
    `<md:SingleLogoutService Binding="${POST}" Location="${escapeXml(input.sloUrl)}"/>` +
    `<md:NameIDFormat>${escapeXml(input.nameIdFormat)}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${POST}" Location="${escapeXml(input.acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor></md:EntityDescriptor>`
  )
}

// ── IdP metadata ─────────────────────────────────────────────────────────

export interface IdpMetadata {
  entityId: string
  ssoUrl: string
  sloUrl: string | null
  sloResponseUrl: string | null
  certificates: IdpCertificate[]
  wantAuthnRequestsSigned: boolean
}

const https = (value: string | null): value is string => {
  if (!value) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

/**
 * An IdP's metadata, read for what we use: entity id, the Redirect-binding
 * SSO and SLO endpoints, the signing certificates.
 *
 * ⚠ ITS OWN SIGNATURE IS NOT CHECKED, AND THAT IS A CHOICE. Metadata arrives
 * from a URL an owner typed (fetched over https through the egress guard) or
 * a file an owner uploaded; who may set it is the trust rule, not a key we
 * would have to be given first. A metadata document is never a message.
 */
export function parseIdpMetadata(xml: string): IdpMetadata | { error: string } {
  let doc: Document
  try {
    doc = parseXml(xml, METADATA_LIMITS)
  } catch (error) {
    return {
      error:
        error instanceof XmlRefused && error.failure === "dtd"
          ? "The metadata declares a DTD, which is not allowed."
          : "The metadata is not well-formed XML.",
    }
  }
  const root = doc.documentElement
  if (!is(root, NS.metadata, "EntityDescriptor"))
    return { error: "The metadata must be one EntityDescriptor." }
  const entityId = attrOf(root, "entityID")
  if (!entityId || entityId.length > 1024)
    return { error: "The metadata has no entityID." }
  const descriptors = childrenOf(root, NS.metadata, "IDPSSODescriptor").filter((d) =>
    (attrOf(d, "protocolSupportEnumeration") ?? "").split(/\s+/).includes(NS.protocol),
  )
  if (descriptors.length !== 1)
    return { error: "The metadata must describe one SAML 2.0 identity provider." }
  const idp = descriptors[0]!
  const endpoint = (local: string, binding: string, attribute = "Location") =>
    childrenOf(idp, NS.metadata, local)
      .filter((e) => attrOf(e, "Binding") === binding)
      .map((e) => attrOf(e, attribute))[0] ?? null
  const ssoUrl = endpoint("SingleSignOnService", REDIRECT)
  if (!https(ssoUrl))
    return {
      error:
        "The metadata has no https SingleSignOnService for the HTTP-Redirect binding.",
    }
  const sloUrl = endpoint("SingleLogoutService", REDIRECT)
  const sloResponse = endpoint("SingleLogoutService", REDIRECT, "ResponseLocation")

  const certificates: IdpCertificate[] = []
  for (const key of childrenOf(idp, NS.metadata, "KeyDescriptor")) {
    const use = attrOf(key, "use")
    if (use !== null && use !== "signing") continue
    const info = onlyChild(key, NS.ds, "KeyInfo")
    for (const data of info ? childrenOf(info, NS.ds, "X509Data") : [])
      for (const certEl of childrenOf(data, NS.ds, "X509Certificate")) {
        const text = textOf(certEl)?.replace(/\s+/g, "")
        if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) continue
        const cert = certificateFromDer(Buffer.from(text, "base64"))
        if ("error" in cert)
          return {
            error: `A signing certificate in the metadata was refused: ${cert.error}`,
          }
        if (!certificates.some((c) => c.fingerprint === cert.fingerprint))
          certificates.push(cert)
      }
  }
  if (certificates.length === 0)
    return { error: "The metadata has no signing certificate." }
  if (certificates.length > 5)
    return { error: "The metadata lists more than five signing certificates." }
  return {
    entityId,
    ssoUrl,
    sloUrl: https(sloUrl) ? sloUrl : null,
    sloResponseUrl: https(sloResponse) ? sloResponse : null,
    certificates,
    wantAuthnRequestsSigned: attrOf(idp, "WantAuthnRequestsSigned") === "true",
  }
}
