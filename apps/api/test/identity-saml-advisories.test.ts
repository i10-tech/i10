import { describe, expect, it } from "bun:test"
import { createPrivateKey, randomBytes } from "node:crypto"
import { SignedXml } from "xml-crypto"
import {
  certificateSerial,
  newSpKey,
  readCertificate,
} from "../src/identity/saml-crypto.js"
import {
  verifySamlResponse,
  type Expectations,
  type Verdict,
} from "../src/identity/saml-verify.js"
import { parseXml, XmlRefused } from "../src/identity/saml-xml.js"
import {
  ACS,
  ALG,
  ENTITY,
  SP_ENTITY,
  assertionXml,
  b64,
  encrypt,
  goodResponse,
  keys,
  responseXml,
  sign,
} from "./saml-idp.js"

/**
 * The SAML advisory regression suite (#339, written before the engine was
 * wired to the bridge). One fixture per published class in xml-crypto,
 * node-saml, samlify and @boxyhq/saml20 (Polis), generated here from a test
 * IdP's own keys, then a fuzz pass. Every one must be REFUSED, and for the
 * classes that turn on one rule, refused by THAT rule (the failure code), so
 * a later refactor cannot quietly move the refusal somewhere weaker.
 */

const idp = keys()
const attacker = keys(2048, "attacker.test")

function expectations(over: Partial<Expectations> = {}): Expectations {
  return {
    idpEntityId: ENTITY,
    spEntityId: SP_ENTITY,
    acsUrl: ACS,
    certificates: [idp.cert],
    decryptionKeys: [],
    requireEncryption: false,
    inResponseTo: "_req1",
    now: new Date(),
    ...over,
  }
}

const run = (base64: string, over: Partial<Expectations> = {}): Verdict =>
  verifySamlResponse(base64, expectations(over))
const failure = (v: Verdict) => (v.ok ? "ACCEPTED" : v.failure)

/** The first `<ds:Signature ...>...</ds:Signature>` at or after `from`. */
function signatureIn(xml: string, from = 0): string {
  const start = xml.indexOf("<ds:Signature", from)
  const end = xml.indexOf("</ds:Signature>", start) + "</ds:Signature>".length
  return xml.slice(start, end)
}
const withoutSignature = (xml: string) => xml.replace(signatureIn(xml), "")
const afterIssuer = (xml: string, insert: string) =>
  xml.replace("</saml:Issuer>", `</saml:Issuer>${insert}`)
const insertBeforeClose = (xml: string, insert: string) =>
  xml.replace(/<\/saml:Assertion>$/, `${insert}</saml:Assertion>`)

const signed = sign(assertionXml(), idp)
const evilSameId = assertionXml({
  nameId: "00u-mallory",
  attributes: { email: ["mallory@acme.test"] },
})
const evilOtherId = assertionXml({
  id: "_evil",
  nameId: "00u-mallory",
  attributes: { email: ["mallory@acme.test"] },
})

describe("the baseline", () => {
  it("accepts a correctly signed assertion and reads only what was signed", () => {
    const v = run(goodResponse(idp))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.assertion).toMatchObject({
      id: "_a1",
      issuer: ENTITY,
      nameId: "00u-ada",
      sessionIndex: "_sess1",
      encrypted: false,
    })
    expect(v.assertion.attributes.email).toEqual(["ada@acme.test"])
    expect(v.assertion.attributes.groups).toEqual(["eng", "admins"])
  })

  it("keeps an attribute named __proto__ as a plain value, never a prototype", () => {
    const attributes = Object.fromEntries([
      ["__proto__", ["evil"]],
      ["email", ["ada@acme.test"]],
    ])
    const v = run(b64(sign(responseXml(assertionXml({ attributes })), idp)))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(Object.getPrototypeOf(v.assertion.attributes)).toBeNull()
    expect(Object.hasOwn(v.assertion.attributes, "__proto__")).toBe(true)
    expect(v.assertion.attributes.email).toEqual(["ada@acme.test"])
  })

  it("accepts a signed Response around a signed assertion", () => {
    const xml = sign(responseXml(signed), idp, { target: "Response" })
    expect(run(b64(xml)).ok).toBe(true)
  })
})

describe("signature wrapping (XSW 1 to 8, Somorovsky et al. 2012)", () => {
  const signedResponse = sign(responseXml(signed), idp, { target: "Response" })
  const responseSignature = signatureIn(signedResponse)
  const assertionSignature = signatureIn(signed)

  const cases: [string, string][] = [
    [
      "XSW1: an evil Response, the signed original inside its copied signature",
      responseXml(
        evilOtherId +
          responseSignature.replace(
            "</ds:Signature>",
            `<ds:Object>${signedResponse}</ds:Object></ds:Signature>`,
          ),
        { id: "_evil_r" },
      ),
    ],
    [
      "XSW2: an evil Response, the signed original beside the copied signature",
      responseXml(signedResponse + evilOtherId + responseSignature, { id: "_evil_r" }),
    ],
    [
      "XSW3: an evil assertion before the signed one",
      responseXml(evilOtherId + signed),
    ],
    [
      "XSW4: the signed assertion wrapped inside an evil one",
      responseXml(insertBeforeClose(evilOtherId, signed)),
    ],
    [
      "XSW5: the evil assertion carries the signature, an unsigned copy of the original follows",
      responseXml(
        afterIssuer(evilSameId, assertionSignature) + withoutSignature(signed),
      ),
    ],
    [
      "XSW6: the original inside the evil assertion's copied signature",
      responseXml(
        afterIssuer(
          evilOtherId,
          assertionSignature.replace(
            "</ds:Signature>",
            `<ds:Object>${signed}</ds:Object></ds:Signature>`,
          ),
        ),
      ),
    ],
    [
      "XSW7: the original in Extensions, the evil assertion after",
      responseXml(`<samlp:Extensions>${signed}</samlp:Extensions>${evilOtherId}`),
    ],
    [
      "XSW8: the original, unsigned, inside an Object of the evil assertion's signature",
      responseXml(
        afterIssuer(
          evilSameId,
          assertionSignature.replace(
            "</ds:Signature>",
            `<ds:Object>${withoutSignature(signed)}</ds:Object></ds:Signature>`,
          ),
        ),
      ),
    ],
    [
      "samlify CVE-2025-47949 shape: a decoy Assertion in another namespace first",
      responseXml(
        `<x:Assertion xmlns:x="urn:evil" ID="_x"><x:Subject>mallory</x:Subject></x:Assertion>` +
          signed,
      ),
    ],
  ]
  for (const [name, xml] of cases)
    it(`refuses ${name}`, () => {
      const v = run(b64(xml))
      expect(v.ok).toBe(false)
      expect(failure(v)).not.toBe("ACCEPTED")
    })

  it("refuses XSW3 by counting assertions, before any cryptography", () => {
    expect(failure(run(b64(responseXml(evilOtherId + signed))))).toBe("assertion_count")
  })
  it("refuses XSW5 for the duplicated ID", () => {
    const xml = responseXml(
      afterIssuer(evilSameId, assertionSignature) + withoutSignature(signed),
    )
    expect(failure(run(b64(xml)))).toBe("duplicate_id")
  })
})

describe("one assertion, one signature, no decoys", () => {
  it("refuses two signed assertions", () => {
    const two = responseXml(signed + sign(assertionXml({ id: "_a2" }), idp))
    expect(failure(run(b64(two)))).toBe("assertion_count")
  })

  it("refuses an assertion with two signatures", () => {
    const sig = signatureIn(signed)
    const doubled = signed.replace(sig, sig + sig.replace(/Id="[^"]*"/, ""))
    expect(failure(run(b64(responseXml(doubled))))).toBe("multiple_signatures")
  })

  it("refuses a decoy Signature of another namespace outside what was signed", () => {
    const xml = responseXml(
      signed + `<x:Signature xmlns:x="urn:evil"><x:SignedInfo/></x:Signature>`,
    )
    expect(failure(run(b64(xml)))).toBe("decoy_signature")
  })

  it("refuses a decoy xmldsig Signature in Extensions", () => {
    const xml = responseXml(
      `<samlp:Extensions>${signatureIn(signed)}</samlp:Extensions>${signed}`,
    )
    expect(failure(run(b64(xml)))).toBe("decoy_signature")
  })

  it("refuses an unsigned assertion inside a signed Response (node-saml CVE-2025-54419 shape)", () => {
    const xml = sign(responseXml(assertionXml()), idp, { target: "Response" })
    expect(failure(run(b64(xml)))).toBe("assertion_unsigned")
  })

  it("refuses an assertion that is not a direct child of the Response", () => {
    const xml = responseXml(`<samlp:Extensions>${signed}</samlp:Extensions>`)
    expect(failure(run(b64(xml)))).toBe("assertion_position")
  })
})

describe("comments inside signed values", () => {
  it("refuses a NameID truncated by a comment (CVE-2017-11428 class)", () => {
    // Signed over the full value; a comment splits it so a naive reader stops early.
    const s = sign(assertionXml({ nameId: "ada@acme.test.evil.example" }), idp)
    const cut = s.replace(
      "ada@acme.test.evil.example",
      "ada@acme.test<!---->.evil.example",
    )
    expect(failure(run(b64(responseXml(cut))))).toBe("xml_comment")
  })

  it("refuses a comment inside DigestValue (xml-crypto CVE-2025-29775 class)", () => {
    const cut = signed.replace(
      /<ds:DigestValue>([^<]{4})/,
      "<ds:DigestValue>$1<!-- x -->",
    )
    expect(failure(run(b64(responseXml(cut))))).toBe("xml_comment")
  })

  it("refuses a comment inside SignatureValue", () => {
    const cut = signed.replace(
      /<ds:SignatureValue>([^<]{4})/,
      "<ds:SignatureValue>$1<!---->",
    )
    expect(failure(run(b64(responseXml(cut))))).toBe("xml_comment")
  })
})

describe("DTDs and entities", () => {
  const body = responseXml(signed)
  const cases: [string, string][] = [
    [
      "XXE through an external entity",
      `<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>${body.replace("00u-ada", "&x;")}`,
    ],
    [
      "billion laughs",
      `<!DOCTYPE r [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;">]>${body.replace("00u-ada", "&c;")}`,
    ],
    [
      "a parameter entity",
      `<!DOCTYPE r [<!ENTITY % p SYSTEM "https://evil.test/x.dtd"> %p;]>${body}`,
    ],
    ["a bare DOCTYPE", `<!DOCTYPE samlp:Response>${body}`],
    ["a lowercase doctype", `<!doctype r>${body}`],
    ["an undeclared entity", body.replace("00u-ada", "&evil;")],
    [
      "a DOCTYPE after the declaration",
      `<?xml version="1.0"?><!DOCTYPE r SYSTEM "https://evil.test/r.dtd">${body}`,
    ],
  ]
  for (const [name, xml] of cases)
    it(`refuses ${name}`, () => {
      expect(failure(run(b64(xml)))).toMatch(/^xml_(dtd|entity)$/)
    })
})

describe("the signature's own shape", () => {
  it("refuses a signature over the wrong reference (the Response, placed in the assertion)", () => {
    const xml = responseXml(assertionXml())
    const sig = new SignedXml({
      privateKey: idp.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicCert: idp.pem,
      signatureAlgorithm: ALG.rsaSha256,
      canonicalizationAlgorithm: ALG.exc,
    })
    sig.addReference({
      xpath: "/*[local-name(.)='Response']",
      digestAlgorithm: ALG.sha256,
      transforms: [ALG.enveloped, ALG.exc],
    })
    sig.computeSignature(xml, {
      prefix: "ds",
      location: {
        reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
        action: "after",
      },
    })
    expect(failure(run(b64(sig.getSignedXml())))).toBe("wrong_reference")
  })

  it("refuses an empty Reference URI (the whole document)", () => {
    const xml = responseXml(signed.replace(/URI="#_a1"/, 'URI=""'))
    expect(failure(run(b64(xml)))).toBe("wrong_reference")
  })

  it("refuses RSA-SHA1", () => {
    const s = sign(assertionXml(), idp, {
      signatureAlgorithm: ALG.rsaSha1,
      digestAlgorithm: ALG.sha1,
    })
    expect(failure(run(b64(responseXml(s))))).toBe("signature_algorithm")
  })

  it("refuses a SHA-1 digest under an RSA-SHA256 signature", () => {
    const s = sign(assertionXml(), idp, { digestAlgorithm: ALG.sha1 })
    expect(failure(run(b64(responseXml(s))))).toBe("digest_algorithm")
  })

  it("refuses HMAC (key confusion)", () => {
    const xml = responseXml(
      signed.replace(ALG.rsaSha256, "http://www.w3.org/2000/09/xmldsig#hmac-sha1"),
    )
    expect(failure(run(b64(xml)))).toBe("signature_algorithm")
  })

  it("refuses a WithComments canonicalization transform", () => {
    const s = sign(assertionXml(), idp, {
      transforms: [ALG.enveloped, ALG.excComments],
    })
    expect(failure(run(b64(responseXml(s))))).toBe("transforms")
  })

  it("refuses a signature with no enveloped-signature transform", () => {
    const s = sign(assertionXml(), idp, { transforms: [ALG.exc] })
    expect(failure(run(b64(responseXml(s))))).toBe("transforms")
  })

  it("refuses an XSLT transform", () => {
    const xml = responseXml(
      signed.replace(
        `<ds:Transform Algorithm="${ALG.exc}"/>`,
        `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xslt-19991116"><xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/></ds:Transform>`,
      ),
    )
    expect(failure(run(b64(xml)))).toBe("transforms")
  })

  it("refuses an XPath filter transform", () => {
    const xml = responseXml(
      signed.replace(
        `<ds:Transform Algorithm="${ALG.exc}"/>`,
        `<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>1</ds:XPath></ds:Transform>`,
      ),
    )
    expect(failure(run(b64(xml)))).toBe("transforms")
  })

  it("refuses three transforms", () => {
    const xml = responseXml(
      signed.replace(
        `<ds:Transform Algorithm="${ALG.exc}"/>`,
        `<ds:Transform Algorithm="${ALG.exc}"/><ds:Transform Algorithm="${ALG.exc}"/>`,
      ),
    )
    expect(failure(run(b64(xml)))).toBe("transforms")
  })

  it("refuses a signature by a key the message brings in KeyInfo (xml-crypto CVE-2024-32962)", () => {
    expect(failure(run(goodResponse(attacker)))).toBe("bad_signature")
  })

  it("refuses a tampered signed value", () => {
    const xml = responseXml(signed.replace("00u-ada", "00u-mallory"))
    expect(failure(run(b64(xml)))).toBe("bad_signature")
  })

  it("refuses when no configured certificate is valid today", () => {
    const expired = { ...idp.cert, notAfter: new Date(Date.now() - 1000) }
    expect(failure(run(goodResponse(idp), { certificates: [expired] }))).toBe(
      "no_usable_certificate",
    )
  })

  it("verifies with the second of two certificates (rotation)", () => {
    const v = run(goodResponse(idp), { certificates: [attacker.cert, idp.cert] })
    expect(v.ok).toBe(true)
  })

  it("refuses a certificate under 2048 bits when it is added", () => {
    const weak = keys(1024, "weak.test")
    expect(readCertificate(weak.pem)).toEqual({
      error: "The certificate's key must be at least 2048 bits.",
    })
  })

  it("writes serials DER can read: positive, never a leading zero byte", () => {
    // 0x00 then a byte under 0x80 is the one-in-256 serial BoringSSL refuses.
    for (const first of [0x00, 0x01, 0x3f, 0x7f, 0x80, 0xff]) {
      const serial = certificateSerial(Buffer.from([first, 0x05, ...Array(14).fill(0)]))
      expect(serial[0]!).toBeGreaterThanOrEqual(0x40)
      expect(serial[0]!).toBeLessThan(0x80)
      expect(serial).toHaveLength(16)
    }
  })

  it("makes SP certificates Node and xml-crypto can read, every time", async () => {
    for (let i = 0; i < 40; i++) {
      const { publicCert } = await newSpKey("sp.i10.test")
      const pem = `-----BEGIN CERTIFICATE-----\n${publicCert.certificate.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`
      expect("error" in readCertificate(pem)).toBe(false)
      expect(() =>
        SignedXml.getKeyInfoContent({ publicCert: pem, prefix: "ds" }),
      ).not.toThrow()
    }
  })
})

describe("the conditions", () => {
  const minute = 60_000
  const cases: [string, string, Partial<Expectations>, string][] = [
    [
      "another audience",
      goodResponse(idp, { audience: "https://other.test" }),
      {},
      "audience",
    ],
    [
      "another recipient",
      goodResponse(idp, { recipient: "https://evil.test/acs" }),
      {},
      "subject_confirmation",
    ],
    [
      "another issuer",
      goodResponse(idp, { issuer: "https://evil.test" }),
      {},
      "issuer",
    ],
    [
      "a different InResponseTo",
      goodResponse(idp, { inResponseTo: "_other" }),
      {},
      "subject_confirmation",
    ],
    [
      "no InResponseTo for a request we sent",
      goodResponse(idp, { inResponseTo: null }),
      {},
      "subject_confirmation",
    ],
    [
      "an InResponseTo when we sent nothing",
      goodResponse(idp),
      { inResponseTo: null },
      "subject_confirmation",
    ],
    [
      "an expired assertion",
      goodResponse(idp, { notOnOrAfter: Date.now() - 3 * minute }),
      {},
      "expired",
    ],
    [
      "one not yet valid",
      goodResponse(idp, { notBefore: Date.now() + 3 * minute }),
      {},
      "not_yet_valid",
    ],
    [
      "an expired confirmation",
      goodResponse(idp, { confirmationUntil: Date.now() - 3 * minute }),
      {},
      "subject_confirmation",
    ],
    [
      "a holder-of-key confirmation only",
      goodResponse(idp, { method: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key" }),
      {},
      "subject_confirmation",
    ],
    [
      "a transient NameID",
      goodResponse(idp, {
        nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      }),
      {},
      "name_id_format",
    ],
    [
      "an unknown condition",
      goodResponse(idp, { conditionsExtra: "<saml:Condition/>" }),
      {},
      "unknown_condition",
    ],
    [
      "an AuthnInstant in the future",
      goodResponse(idp, { authnInstant: Date.now() + 5 * minute }),
      {},
      "authn_instant",
    ],
    [
      "a stale unsolicited response",
      goodResponse(idp, { inResponseTo: null, issueInstant: Date.now() - 4 * minute }),
      { inResponseTo: null },
      "unsolicited_stale",
    ],
  ]
  for (const [name, response, over, code] of cases)
    it(`refuses ${name}`, () => {
      expect(failure(run(response, over))).toBe(code)
    })

  it("accepts the edge of the two minute skew", () => {
    const v = run(goodResponse(idp, { notBefore: Date.now() + minute }))
    expect(v.ok).toBe(true)
  })

  it("refuses a non-Success status as the IdP's answer", () => {
    const xml = responseXml(signed, {
      status: "urn:oasis:names:tc:SAML:2.0:status:Requester",
    })
    const v = run(b64(xml))
    expect(v).toEqual({
      ok: false,
      failure: "status",
      status: "urn:oasis:names:tc:SAML:2.0:status:Requester",
    })
  })

  it("refuses a Destination that is not our ACS", () => {
    const xml = responseXml(signed, { destination: "https://evil.test/acs" })
    expect(failure(run(b64(xml)))).toBe("destination")
  })

  it("refuses a signed Response whose own InResponseTo disagrees", () => {
    const xml = sign(responseXml(signed, { inResponseTo: "_other" }), idp, {
      target: "Response",
    })
    expect(failure(run(b64(xml)))).toBe("in_response_to")
  })
})

describe("encrypted assertions", () => {
  const sp = keys(2048, "sp.test")
  const spKey = createPrivateKey(sp.privateKey.export({ type: "pkcs8", format: "pem" }))
  const sealed = (opts?: Parameters<typeof encrypt>[2]) =>
    b64(responseXml(encrypt(signed, sp.publicKey, opts)))

  it("decrypts AES-256-GCM with RSA-OAEP and verifies the signed assertion inside", () => {
    const v = run(sealed(), { decryptionKeys: [spKey], requireEncryption: true })
    expect(v.ok && v.assertion.encrypted).toBe(true)
  })

  it("decrypts AES-256-CBC (Entra)", () => {
    expect(run(sealed({ data: "aes256-cbc" }), { decryptionKeys: [spKey] }).ok).toBe(
      true,
    )
  })

  it("refuses RSA PKCS#1 v1.5 key transport (Bleichenbacher)", () => {
    expect(
      failure(run(sealed({ transport: "rsa-1_5" }), { decryptionKeys: [spKey] })),
    ).toBe("xml_undecryptable")
  })

  it("refuses a plaintext assertion when the connection requires encryption", () => {
    expect(failure(run(goodResponse(idp), { requireEncryption: true }))).toBe(
      "not_encrypted",
    )
  })

  it("refuses an encrypted UNSIGNED assertion", () => {
    const xml = b64(responseXml(encrypt(assertionXml(), sp.publicKey)))
    expect(failure(run(xml, { decryptionKeys: [spKey] }))).toBe("assertion_unsigned")
  })

  it("refuses an encrypted assertion beside a plaintext one", () => {
    const xml = b64(responseXml(encrypt(signed, sp.publicKey) + evilOtherId))
    expect(failure(run(xml, { decryptionKeys: [spKey] }))).toBe("assertion_count")
  })

  it("answers one refusal for a wrong key, whatever went wrong", () => {
    const other = keys(2048, "other.test")
    const otherKey = createPrivateKey(
      other.privateKey.export({ type: "pkcs8", format: "pem" }),
    )
    expect(failure(run(sealed(), { decryptionKeys: [otherKey] }))).toBe(
      "xml_undecryptable",
    )
  })
})

describe("the parser's limits", () => {
  it("refuses a processing instruction", () => {
    const xml = `<?xml version="1.0"?><?xml-stylesheet href="x"?>${responseXml(signed)}`
    expect(failure(run(b64(xml)))).toBe("xml_processing_instruction")
  })
  it("refuses a second root (multi-rooted XML, Polis)", () => {
    expect(failure(run(b64(responseXml(signed) + "<evil/>")))).toMatch(
      /^xml_(malformed|multiple_roots)$/,
    )
  })
  it("refuses a non-UTF-8 declared encoding", () => {
    const xml = `<?xml version="1.0" encoding="UTF-16"?>${responseXml(signed)}`
    expect(failure(run(b64(xml)))).toBe("xml_encoding")
  })
  it("refuses something too large", () => {
    const big = responseXml(signed).replace(
      "</samlp:Response>",
      `<x>${"a".repeat(300_000)}</x></samlp:Response>`,
    )
    expect(failure(run(b64(big)))).toBe("too_large")
  })
  it("refuses something too deep", () => {
    const deep = "<a>".repeat(40) + "</a>".repeat(40)
    expect(() => parseXml(deep)).toThrow(XmlRefused)
  })
  it("refuses something that is not base64", () => {
    expect(failure(run("not base64!!"))).toBe("not_base64")
  })
  it("refuses broken markup xmldom would have recovered from", () => {
    for (const broken of [
      "<a><b></a>",
      "<a><b>x</c></a>",
      "<a x='1' x='2'/>",
      "<a b=1/>",
      "<a>&lt</a>",
    ])
      expect(() => parseXml(broken)).toThrow(XmlRefused)
    expect(run(b64(responseXml(signed).replace("</saml:Issuer>", ""))).ok).toBe(false)
  })
})

describe("a fuzz pass", () => {
  /*
   * ⚠ THE PROPERTY, NOT "EVERYTHING FAILS". A mutation can land somewhere no
   * rule covers (the unsigned Response's IssueInstant) and still verify; what
   * must hold is that the verifier never throws, and that whatever it accepts
   * says exactly what the IdP signed.
   */
  const base = responseXml(signed)
  const pick = (n: number) => Math.floor(Math.random() * n)
  const mutations: ((s: string) => string)[] = [
    (s) => {
      const i = pick(s.length)
      return s.slice(0, i) + String.fromCharCode(32 + pick(95)) + s.slice(i + 1)
    },
    (s) => {
      const i = pick(s.length)
      return s.slice(0, i) + s.slice(i + 1 + pick(20))
    },
    (s) => {
      const i = pick(s.length)
      const j = pick(s.length)
      return s.slice(0, i) + s.slice(j, j + pick(200)) + s.slice(i)
    },
    (s) => s.slice(0, pick(s.length)),
    (s) => {
      const tags = [
        "<saml:Assertion>",
        "<ds:Signature>",
        "<!---->",
        "&amp;",
        "<![CDATA[x]]>",
        "</saml:Subject>",
      ]
      const i = pick(s.length)
      return s.slice(0, i) + tags[pick(tags.length)] + s.slice(i)
    },
  ]
  it("never throws, and never accepts anything but what was signed (2,000 mutations)", () => {
    let accepted = 0
    for (let n = 0; n < 2000; n++) {
      let s = base
      for (let k = 0; k <= pick(3); k++) s = mutations[pick(mutations.length)]!(s)
      const v = run(b64(s))
      if (v.ok) {
        accepted++
        expect(v.assertion.nameId).toBe("00u-ada")
        expect(v.assertion.attributes.email).toEqual(["ada@acme.test"])
        expect(v.assertion.id).toBe("_a1")
      }
    }
    expect(accepted).toBeLessThan(2000)
  })

  it("never throws on random bytes", () => {
    for (let n = 0; n < 200; n++)
      expect(run(randomBytes(pick(2000) + 1).toString("base64")).ok).toBe(false)
  })
})
