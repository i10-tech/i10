import { DOMParser } from "@xmldom/xmldom"

/**
 * The one XML parser every SAML message goes through (#339): responses,
 * logout messages, IdP metadata, decrypted assertions, the signed reference
 * xml-crypto hands back. Nothing in identity/ parses XML any other way.
 *
 * ⚠ HARDENED BY REFUSAL, NOT BY CONFIGURATION. @xmldom/xmldom 0.8 has no
 * switch for "no DTD" or "no external entities"; it skips an internal subset
 * and resolves nothing external, but "the parser happens not to" is not a
 * rule. So before a byte reaches it the raw text is screened, and after it
 * parsed the tree is walked again:
 *
 *   - no DTD of any kind (`<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`,
 *     `<!NOTATION`): XXE, billion laughs and parameter entities have nothing
 *     to stand on (the Polis/saml20 rule, ory/polis#4071, kept literal: the
 *     keyword anywhere is a refusal, even inside CDATA, because every attempt
 *     to "ignore it inside comments" has been bypassed);
 *   - no entity reference but the five XML predefines and numeric ones;
 *   - no comment anywhere: a comment inside a signed value is how NameID
 *     truncation works (CVE-2017-11428 and kin), and a comment inside
 *     DigestValue is how xml-crypto's 2025 bypass worked (CVE-2025-29775);
 *   - no processing instruction but the XML declaration, and only UTF-8;
 *   - every parser warning or error is a refusal, not a log line: xmldom
 *     recovers from broken markup, and a recovered tree is a guess;
 *   - one root element, and bounded size, element count, depth and
 *     attributes, so what follows (xpath inside xml-crypto, our own walks)
 *     works on something small.
 */

export const NS = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  xenc: "http://www.w3.org/2001/04/xmlenc#",
  xenc11: "http://www.w3.org/2009/xmlenc11#",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
} as const

export interface XmlLimits {
  /** Characters of XML text. */
  maxChars: number
  maxElements: number
  maxDepth: number
  maxAttributes: number
  /**
   * Metadata only: Shibboleth and others annotate theirs with comments. Never
   * for a message, whose values are signed.
   */
  allowComments?: boolean
}

/** A SAML response or logout message, decoded. Okta's largest are about 20 KiB. */
export const MESSAGE_LIMITS: XmlLimits = {
  maxChars: 256 * 1024,
  maxElements: 3_000,
  maxDepth: 32,
  maxAttributes: 32,
}

/** IdP metadata: a few certificates and endpoints, but some IdPs pad it. */
export const METADATA_LIMITS: XmlLimits = {
  maxChars: 256 * 1024,
  maxElements: 5_000,
  maxDepth: 32,
  maxAttributes: 32,
  allowComments: true,
}

/**
 * Why XML was refused. A short, fixed code: it is audited, so it never
 * carries the document or the parser's own message (which quotes it).
 */
export class XmlRefused extends Error {
  constructor(readonly failure: string) {
    super(`xml refused: ${failure}`)
    this.name = "XmlRefused"
  }
}

const DTD = /<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i
const COMMENT = /<!--/
const ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/
const DECLARATION =
  /^<\?xml\s+version\s*=\s*["']1\.0["'](\s+encoding\s*=\s*["']([A-Za-z0-9._-]+)["'])?(\s+standalone\s*=\s*["'](yes|no)["'])?\s*\?>/

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_NODE = 4
const ENTITY_REFERENCE_NODE = 5
const PI_NODE = 7
const COMMENT_NODE = 8
const DOCUMENT_TYPE_NODE = 10

/**
 * The raw text checks, before any parser sees it. Exported for the fuzz pass,
 * which feeds this and `parseXml` the same inputs.
 */
export function screenXml(raw: string, limits: XmlLimits): string {
  if (raw.length > limits.maxChars) throw new XmlRefused("too_large")
  // A byte order mark is the only thing allowed before the declaration.
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw
  if (DTD.test(text)) throw new XmlRefused("dtd")
  if (!limits.allowComments && COMMENT.test(text)) throw new XmlRefused("comment")
  if (ENTITY.test(text)) throw new XmlRefused("entity")
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text))
    throw new XmlRefused("control_character")
  let rest = text
  const declaration = DECLARATION.exec(text)
  if (text.startsWith("<?")) {
    if (!declaration) throw new XmlRefused("processing_instruction")
    const encoding = declaration[2]?.toLowerCase()
    if (encoding && encoding !== "utf-8" && encoding !== "utf8")
      throw new XmlRefused("encoding")
    rest = text.slice(declaration[0].length)
  }
  if (rest.includes("<?")) throw new XmlRefused("processing_instruction")
  return text
}

/**
 * A document we are willing to look at, or `XmlRefused`.
 *
 * ⚠ THE CALLER STILL DECIDES WHAT THE DOCUMENT MAY CONTAIN. This only says it
 * is plain, small, well-formed XML; one Assertion, one Signature and so on are
 * identity/saml-verify.ts's rules.
 */
export function parseXml(raw: string, limits: XmlLimits = MESSAGE_LIMITS): Document {
  const text = screenXml(raw, limits)
  const problems: string[] = []
  const record = () => problems.push("x")
  let doc: Document
  try {
    doc = new DOMParser({
      errorHandler: { warning: record, error: record, fatalError: record },
    }).parseFromString(text, "text/xml")
  } catch {
    throw new XmlRefused("malformed")
  }
  if (problems.length > 0 || !doc) throw new XmlRefused("malformed")

  let roots = 0
  for (let n = doc.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE) roots++
    else if (n.nodeType === DOCUMENT_TYPE_NODE) throw new XmlRefused("dtd")
    else if (n.nodeType === COMMENT_NODE) {
      if (!limits.allowComments) throw new XmlRefused("comment")
    } else if (n.nodeType === PI_NODE) {
      // xmldom keeps the declaration as a processing instruction named `xml`.
      if ((n as ProcessingInstruction).target !== "xml" || n !== doc.firstChild)
        throw new XmlRefused("processing_instruction")
    } else if (n.nodeType === TEXT_NODE) {
      if ((n.nodeValue ?? "").trim()) throw new XmlRefused("malformed")
    } else throw new XmlRefused("malformed")
  }
  if (roots !== 1 || !doc.documentElement) throw new XmlRefused("multiple_roots")
  if (doc.doctype) throw new XmlRefused("dtd")

  let count = 0
  const walk = (el: Element, depth: number) => {
    if (++count > limits.maxElements) throw new XmlRefused("too_many_elements")
    if (depth > limits.maxDepth) throw new XmlRefused("too_deep")
    if (el.attributes.length > limits.maxAttributes)
      throw new XmlRefused("too_many_attributes")
    for (let n = el.firstChild; n; n = n.nextSibling) {
      switch (n.nodeType) {
        case ELEMENT_NODE:
          walk(n as Element, depth + 1)
          break
        case TEXT_NODE:
        case CDATA_NODE:
          break
        case COMMENT_NODE:
          if (!limits.allowComments) throw new XmlRefused("comment")
          break
        case PI_NODE:
          throw new XmlRefused("processing_instruction")
        case ENTITY_REFERENCE_NODE:
          throw new XmlRefused("entity")
        default:
          throw new XmlRefused("malformed")
      }
    }
  }
  walk(doc.documentElement, 1)
  return doc
}

// ── Reading ──────────────────────────────────────────────────────────────

export function isElement(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === ELEMENT_NODE
}

/** Whether `el` is `{ns}local`, exactly: the namespace URI, not the prefix. */
export function is(el: Element | null | undefined, ns: string, local: string): boolean {
  return !!el && el.namespaceURI === ns && el.localName === local
}

/** The element children of `parent`, in order. */
export function elementsOf(parent: Node): Element[] {
  const out: Element[] = []
  for (let n = parent.firstChild; n; n = n.nextSibling) if (isElement(n)) out.push(n)
  return out
}

/** The children of `parent` that are `{ns}local`. */
export function childrenOf(parent: Node, ns: string, local: string): Element[] {
  return elementsOf(parent).filter((el) => is(el, ns, local))
}

/** The one child `{ns}local`, or null when there is none OR more than one. */
export function onlyChild(parent: Node, ns: string, local: string): Element | null {
  const found = childrenOf(parent, ns, local)
  return found.length === 1 ? found[0]! : null
}

/**
 * Every element under `root` (itself included) whose LOCAL name is `local`,
 * in any namespace or none.
 *
 * ⚠ FOR COUNTING, ON PURPOSE BY LOCAL NAME. A decoy `<x:Assertion>` or
 * `<foo:Signature>` in a namespace of the attacker's choosing is exactly what
 * a namespace-exact count would miss and a local-name selector somewhere else
 * (samlify's, CVE-2025-47949) would find.
 */
export function everyNamed(root: Element, local: string): Element[] {
  const out: Element[] = []
  const walk = (el: Element) => {
    if (el.localName === local) out.push(el)
    for (const child of elementsOf(el)) walk(child)
  }
  walk(root)
  return out
}

/**
 * The text of an element that holds ONLY text (and CDATA), or null.
 *
 * ⚠ AN ELEMENT CHILD MAKES IT NULL, NOT "THE FIRST TEXT NODE". Reading the
 * first text node of `<NameID>a<x/>b</NameID>` is the shape of every
 * truncation bug in this space.
 */
export function textOf(el: Element | null | undefined): string | null {
  if (!el) return null
  let out = ""
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) out += n.nodeValue ?? ""
    else return null
  }
  return out
}

/** A non-namespaced attribute's value, or null when absent. */
export function attrOf(el: Element, name: string): string | null {
  return el.hasAttribute(name) ? el.getAttribute(name) : null
}

/** XML text escaping for what we write ourselves (requests, metadata). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
