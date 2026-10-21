import { describe, expect, it } from "bun:test"
import {
  X509Certificate,
  createPrivateKey,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import {
  bind,
  redeemHandoff,
  startLogin,
  type BridgeDeps,
} from "../src/identity/bridge.js"
import type { Connection } from "../src/identity/model.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { newSpKey } from "../src/identity/saml-crypto.js"
import { parseIdpMetadata } from "../src/identity/saml-messages.js"
import {
  finishSaml,
  finishSlo,
  nameIdOfSubject,
  samlEngine,
  samlReady,
  startLogout,
  subjectOf,
  type SloDeps,
} from "../src/identity/saml.js"
import { parseXml } from "../src/identity/saml-xml.js"
import type { EgressVerdict } from "../src/webhooks/egress.js"
import {
  CONNECTION,
  ORG,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryReplay,
  memorySaml,
  memoryStore,
} from "./identity-fakes.js"
import {
  ACS,
  ENTITY,
  assertionXml,
  b64,
  encrypt,
  keys,
  responseXml,
  sign,
  type AssertionKnobs,
} from "./saml-idp.js"

/**
 * The SAML engine (#339) through the whole bridge with the in-memory ports: a
 * test IdP signs real assertions with keys drawn here, and every step from
 * the AuthnRequest to a bound session runs as in production. The advisory
 * classes are in identity-saml-advisories.test.ts; this file is the wiring
 * and the refusals around it.
 */

const AUTH = "https://auth.i10.localhost"
const BINDING = "b".repeat(43)
const OTHER_BROWSER = "c".repeat(43)
const FRESH = "f".repeat(43)
const PUBLIC: EgressVerdict = { ok: true, address: "93.184.216.34", family: 4 }
const SLO_IDP = "https://idp.acme.test/slo"

const idp = keys()

function samlConnection(
  over: Partial<Connection> = {},
  saml: Record<string, unknown> = {},
) {
  return connection({
    protocol: "saml",
    provider: "okta",
    config: {
      saml: {
        idpEntityId: ENTITY,
        ssoUrl: "https://idp.acme.test/sso",
        sloUrl: SLO_IDP,
        ...saml,
      },
    },
    ...over,
  })
}

async function world(
  options: {
    connection?: Connection
    spKey?: boolean
    fetch?: typeof fetch
  } = {},
) {
  const sp = options.spKey ? await newSpKey("sp") : null
  const base = options.connection ?? samlConnection()
  const conn = sp
    ? {
        ...base,
        config: {
          ...base.config,
          saml: { ...(base.config.saml as object), spCertificates: [sp.publicCert] },
        },
      }
    : base
  const store = memoryStore({ connections: [conn] })
  if (sp) store.secrets.set(CONNECTION, { saml: { spKeys: [sp.privateKey] } })
  const saml = memorySaml(store)
  await saml.saml.addCertificate(
    TENANT,
    CONNECTION,
    { ...idp.cert, source: "upload" },
    null,
  )
  const replay = memoryReplay()
  const clerk = memoryClerk()
  const engine = samlEngine({
    store: store.store,
    saml: saml.saml,
    fetch: guardedFetch({
      vet: async () => PUBLIC,
      fetch:
        options.fetch ??
        ((async () => new Response("no", { status: 500 })) as unknown as typeof fetch),
    }),
    replay: replay.replay,
    authOrigin: AUTH,
    log,
  })
  const deps: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([["saml", engine]]),
    join: async () => "added",
    isExempt: async () => false,
    log,
  }
  const forgotten: unknown[] = []
  const slo: SloDeps = {
    store: store.store,
    saml: saml.saml,
    clerk: clerk.clerk,
    replay: replay.replay,
    forget: (input) => forgotten.push(input),
    log,
  }

  /** Start a sign-in; what the IdP is sent. */
  async function start(
    purpose: "sign_in" | "test_run" | "step_up" = "sign_in",
    stepUp?: { userId: string; sessionId: string },
  ) {
    const started = await startLogin(deps, {
      connectionId: CONNECTION,
      purpose,
      binding: BINDING,
      returnTo: "https://dash.i10.localhost/",
      ...(stepUp ? { stepUp } : {}),
    })
    if (started.outcome !== "redirect")
      throw new Error(`not started: ${started.reason}`)
    const url = new URL(started.redirectUrl)
    const xml = inflateRawSync(
      Buffer.from(url.searchParams.get("SAMLRequest")!, "base64"),
    ).toString()
    const request = parseXml(xml).documentElement
    return {
      url,
      xml,
      requestId: request.getAttribute("ID")!,
      relayState: url.searchParams.get("RelayState")!,
      protocol: started.protocol,
    }
  }

  /** The IdP's answer, posted to the ACS. */
  async function acs(
    response: string,
    over: { relayState?: string | null; binding?: string | null } = {},
    relayState?: string,
  ) {
    return finishSaml(deps, engine, {
      connectionId: CONNECTION,
      samlResponse: response,
      relayState:
        over.relayState !== undefined ? over.relayState : (relayState ?? null),
      binding: over.binding !== undefined ? over.binding : BINDING,
      freshBinding: FRESH,
    })
  }

  // A fresh assertion ID each time, as a real IdP draws one: the replay cache
  // refuses a repeated ID across attempts.
  const respond = (requestId: string, a: AssertionKnobs = {}) =>
    b64(
      responseXml(
        sign(
          assertionXml({
            id: `_a${crypto.randomUUID().replace(/-/g, "")}`,
            inResponseTo: requestId,
            ...a,
          }),
          idp,
        ),
        { inResponseTo: requestId },
      ),
    )

  async function signIn(a: AssertionKnobs = {}) {
    const s = await start()
    const done = await acs(respond(s.requestId, a), {}, s.relayState)
    if (done.outcome !== "signed_in")
      throw new Error(`refused: ${JSON.stringify(done)}`)
    const redeemed = await redeemHandoff(deps, { code: done.code, binding: BINDING })
    if (redeemed.outcome !== "ticket") throw new Error("no ticket")
    const sessionId = clerk.redeem(redeemed.ticket, new Date(Date.now() + 1000))
    const bound = await bind(deps, {
      userId: "user_ada",
      sessionId,
      handoff: redeemed.handoff,
    })
    return { done, sessionId, bound }
  }

  return {
    store,
    saml,
    replay,
    clerk,
    engine,
    deps,
    slo,
    sp,
    forgotten,
    start,
    acs,
    respond,
    signIn,
  }
}

const reasonOf = (done: { outcome: string; reason?: string }) =>
  done.outcome === "refused" ? done.reason : done.outcome

describe("refusals at the ACS, before and around verification", () => {
  it("refuses a POST from another browser without spending the attempt", async () => {
    const w = await world()
    const s = await w.start()
    const done = await w.acs(
      w.respond(s.requestId),
      { binding: OTHER_BROWSER },
      s.relayState,
    )
    expect(reasonOf(done)).toBe("wrong_browser")
    expect([...w.store.attempts.values()][0]!.consumedAt).toBeNull()
    // The real browser can still finish.
    expect((await w.acs(w.respond(s.requestId), {}, s.relayState)).outcome).toBe(
      "signed_in",
    )
  })

  it("refuses a POST that carried no SAML cookie (a browser that blocks it)", async () => {
    const w = await world()
    const s = await w.start()
    expect(
      reasonOf(await w.acs(w.respond(s.requestId), { binding: null }, s.relayState)),
    ).toBe("wrong_browser")
  })

  it("refuses the second POST of one response", async () => {
    const w = await world()
    const s = await w.start()
    const response = w.respond(s.requestId)
    expect((await w.acs(response, {}, s.relayState)).outcome).toBe("signed_in")
    expect(reasonOf(await w.acs(response, {}, s.relayState))).toBe("attempt_used")
  })

  it("refuses a response answering a different request, and audits only a failure code", async () => {
    const w = await world()
    const s = await w.start()
    const done = await w.acs(w.respond("_someone_else"), {}, s.relayState)
    expect(reasonOf(done)).toBe("invalid_response")
    const event = w.store.events.find((e) => e.type === "sign_in.failed")!
    expect(event.data).toMatchObject({ failure: "subject_confirmation" })
    expect(JSON.stringify(event)).not.toContain("SignatureValue")
  })

  it("refuses an IdP's non-Success status as idp_error", async () => {
    const w = await world()
    const s = await w.start()
    const xml = responseXml(sign(assertionXml({ inResponseTo: s.requestId }), idp), {
      inResponseTo: s.requestId,
      status: "urn:oasis:names:tc:SAML:2.0:status:Responder",
    })
    expect(reasonOf(await w.acs(b64(xml), {}, s.relayState))).toBe("idp_error")
  })

  it("refuses an attempt that names another connection's ACS", async () => {
    const other = "44444444-4444-4444-8444-444444444444"
    const w = await world()
    const s = await w.start()
    const done = await finishSaml(w.deps, w.engine, {
      connectionId: other,
      samlResponse: w.respond(s.requestId),
      relayState: s.relayState,
      binding: BINDING,
      freshBinding: FRESH,
    })
    expect(reasonOf(done)).toBe("engine_mismatch")
  })

  it("refuses when the connection was disabled after the start", async () => {
    const w = await world()
    const s = await w.start()
    w.store.connections.get(CONNECTION)!.status = "disabled"
    expect(reasonOf(await w.acs(w.respond(s.requestId), {}, s.relayState))).toBe(
      "connection_inactive",
    )
  })

  it("refuses an OIDC connection's attempt finished at the SAML ACS", async () => {
    const w = await world()
    const s = await w.start()
    w.store.connections.get(CONNECTION)!.protocol = "oidc"
    expect(reasonOf(await w.acs(w.respond(s.requestId), {}, s.relayState))).toBe(
      "engine_mismatch",
    )
  })

  it("answers 503 when the replay cache is down, and leaves the attempt unspent", async () => {
    const w = await world()
    const s = await w.start()
    w.replay.fail.down = true
    expect((await w.acs(w.respond(s.requestId), {}, s.relayState)).outcome).toBe(
      "unavailable",
    )
    expect([...w.store.attempts.values()][0]!.consumedAt).toBeNull()
    expect(w.store.events.some((e) => e.type === "sign_in.idp_unavailable")).toBe(true)
  })

  it("refuses an assertion the replay cache has seen", async () => {
    const w = await world()
    const conn = w.store.connections.get(CONNECTION)!
    const response = w.respond("_r")
    expect(
      (await w.engine.verify(conn, { samlResponse: response, inResponseTo: "_r" })).ok,
    ).toBe(true)
    expect(
      await w.engine.verify(conn, { samlResponse: response, inResponseTo: "_r" }),
    ).toEqual({
      ok: false,
      reason: "invalid_response",
      extra: { failure: "replayed" },
    })
  })

  it("refuses a test engine's completion of a SAML attempt (engine_mismatch)", async () => {
    const { completeLogin } = await import("../src/identity/bridge.js")
    const w = await world()
    const s = await w.start()
    const done = await completeLogin(w.deps, {
      state: s.relayState,
      binding: BINDING,
      protocol: "test",
      assertion: {
        subject: "x",
        email: "ada@acme.test",
        emailVerified: true,
        authTime: new Date(),
      },
    })
    expect(reasonOf(done)).toBe("engine_mismatch")
  })

  it("refuses a sign-in without a usable subject", async () => {
    const w = await world({
      connection: samlConnection({}, { subjectAttribute: "employeeId" }),
    })
    const s = await w.start()
    const done = await w.acs(w.respond(s.requestId), {}, s.relayState)
    expect(reasonOf(done)).toBe("invalid_response")
  })

  it("refuses MFA-required sign-ins without proof, and accepts Entra's multipleauthn", async () => {
    const entra = samlConnection({ provider: "entra", mfaRequired: true })
    const w = await world({ connection: entra })
    const s = await w.start()
    expect(reasonOf(await w.acs(w.respond(s.requestId), {}, s.relayState))).toBe(
      "mfa_required",
    )
    const again = await w.start()
    const done = await w.acs(
      w.respond(again.requestId, {
        attributes: {
          email: ["ada@acme.test"],
          "http://schemas.microsoft.com/claims/authnmethodsreferences": [
            "http://schemas.microsoft.com/claims/multipleauthn",
          ],
        },
      }),
      {},
      again.relayState,
    )
    expect(done.outcome).toBe("signed_in")
  })
})

describe("IdP-initiated sign-in", () => {
  const unsolicited = (a: AssertionKnobs = {}) =>
    b64(
      responseXml(sign(assertionXml({ inResponseTo: null, ...a }), idp), {
        inResponseTo: null,
      }),
    )

  it("is refused unless the connection opts in", async () => {
    const w = await world()
    expect(reasonOf(await w.acs(unsolicited(), { relayState: null }))).toBe(
      "invalid_response",
    )
    expect(w.store.events.at(-1)).toMatchObject({
      type: "sign_in.failed",
      data: { unsolicited: true, failure: "unsolicited_off" },
    })
  })

  it("signs in, bound to the fresh binding, and asks the browser to confirm", async () => {
    const w = await world({ connection: samlConnection({}, { idpInitiated: true }) })
    const done = await w.acs(unsolicited(), { relayState: "https://evil.test/after" })
    expect(done).toMatchObject({
      outcome: "signed_in",
      unsolicited: true,
      confirmAs: "ada@acme.test",
      returnTo: null,
    })
    if (done.outcome !== "signed_in") return
    // The code is bound to the binding apps/auth drew, not the SAML cookie's.
    expect(
      (await redeemHandoff(w.deps, { code: done.code, binding: BINDING })).outcome,
    ).toBe("refused")
    expect(
      (await redeemHandoff(w.deps, { code: done.code, binding: FRESH })).outcome,
    ).toBe("ticket")
  })

  it("refuses an unsolicited response that answers a request", async () => {
    const w = await world({ connection: samlConnection({}, { idpInitiated: true }) })
    const response = b64(
      responseXml(sign(assertionXml({ inResponseTo: "_x" }), idp), {
        inResponseTo: "_x",
      }),
    )
    expect(reasonOf(await w.acs(response, { relayState: null }))).toBe(
      "invalid_response",
    )
  })

  it("refuses the same unsolicited assertion twice (the replay cache)", async () => {
    const w = await world({ connection: samlConnection({}, { idpInitiated: true }) })
    const response = unsolicited()
    expect((await w.acs(response, { relayState: null })).outcome).toBe("signed_in")
    expect(reasonOf(await w.acs(response, { relayState: null }))).toBe(
      "invalid_response",
    )
  })

  it("refuses an unknown or inactive connection", async () => {
    const w = await world({
      connection: samlConnection({ status: "testing" }, { idpInitiated: true }),
    })
    expect(reasonOf(await w.acs(unsolicited(), { relayState: null }))).toBe(
      "connection_inactive",
    )
  })
})

describe("a SAML sign-in through the bridge", () => {
  it("sends an AuthnRequest on the redirect binding with RelayState = the attempt's state", async () => {
    const w = await world()
    const s = await w.start()
    expect(s.protocol).toBe("saml")
    expect(s.url.origin + s.url.pathname).toBe("https://idp.acme.test/sso")
    expect(s.xml).toContain(`AssertionConsumerServiceURL="${ACS}"`)
    expect(s.xml).toContain("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent")
    expect(s.xml).not.toContain("ForceAuthn")
    expect(s.url.searchParams.get("Signature")).toBeNull()
    expect([...w.store.attempts.values()][0]!.requestId).toBe(s.requestId)
  })

  it("claims and links the person by NameID, all the way to a bound session", async () => {
    const w = await world()
    const { bound } = await w.signIn()
    expect(bound.outcome).toBe("bound")
    expect(w.store.identities[0]).toMatchObject({
      subject: "persistent:00u-ada",
      clerkUserId: "user_ada",
    })
    expect(w.store.managed.get("user_ada")).toMatchObject({
      reason: "claimed",
      tenantId: TENANT,
    })
    expect(w.clerk.minted).toEqual([{ userId: "user_ada", orgId: ORG }])
    expect([...w.store.sessions.values()][0]).toMatchObject({ idpSession: "_sess1" })
  })

  it("signs the AuthnRequest with the SP key when asked, verifiable with our certificate", async () => {
    const w = await world({
      connection: samlConnection({}, { signRequests: true }),
      spKey: true,
    })
    const s = await w.start()
    const raw = s.url.search.slice(1)
    const signed = raw.slice(0, raw.indexOf("&Signature="))
    const sig = Buffer.from(
      decodeURIComponent(raw.slice(raw.indexOf("&Signature=") + 11)),
      "base64",
    )
    const cert = new X509Certificate(
      Buffer.from(w.sp!.publicCert.certificate, "base64"),
    )
    expect(rsaVerify("sha256", Buffer.from(signed), cert.publicKey, sig)).toBe(true)
  })

  it("refuses to start a signed-request connection with no SP key (503, not unsigned)", async () => {
    const w = await world({ connection: samlConnection({}, { signRequests: true }) })
    await expect(w.start()).rejects.toThrow("SP key")
  })

  it("accepts an encrypted assertion end to end when encryption is required", async () => {
    const w = await world({
      connection: samlConnection({}, { requireEncryption: true }),
      spKey: true,
    })
    const s = await w.start()
    const spPublic = new X509Certificate(
      Buffer.from(w.sp!.publicCert.certificate, "base64"),
    ).publicKey
    const response = b64(
      responseXml(
        encrypt(sign(assertionXml({ inResponseTo: s.requestId }), idp), spPublic),
        {
          inResponseTo: s.requestId,
        },
      ),
    )
    expect((await w.acs(response, {}, s.relayState)).outcome).toBe("signed_in")
    // And a plaintext one is refused on the same connection.
    const again = await w.start()
    expect(
      reasonOf(await w.acs(w.respond(again.requestId), {}, again.relayState)),
    ).toBe("invalid_response")
  })

  it("links by the subject attribute when one is set", async () => {
    const w = await world({
      connection: samlConnection({}, { subjectAttribute: "employeeId" }),
    })
    await w.signIn({ attributes: { email: ["ada@acme.test"], employeeId: ["E-1"] } })
    expect(w.store.identities[0]!.subject).toBe("attribute:E-1")
  })
})

describe("step-up with ForceAuthn", () => {
  it("asks the IdP with ForceAuthn and makes the session fresh", async () => {
    const w = await world()
    const { sessionId } = await w.signIn({ authnInstant: Date.now() - 60 * 60 * 1000 })
    expect([...w.store.sessions.values()][0]!.freshAt.getTime()).toBeLessThan(
      Date.now() - 50 * 60 * 1000,
    )
    const s = await w.start("step_up", { userId: "user_ada", sessionId })
    expect(s.xml).toContain(`ForceAuthn="true"`)
    const done = await w.acs(w.respond(s.requestId), {}, s.relayState)
    expect(done.outcome).toBe("stepped_up")
    expect(
      Date.now() - w.store.sessions.get(sessionId)!.freshAt.getTime(),
    ).toBeLessThan(10_000)
  })

  it("refuses a step-up the IdP answered from an old session (AuthnInstant)", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    const s = await w.start("step_up", { userId: "user_ada", sessionId })
    const done = await w.acs(
      w.respond(s.requestId, { authnInstant: Date.now() - 30 * 60 * 1000 }),
      {},
      s.relayState,
    )
    expect(reasonOf(done)).toBe("step_up_stale")
  })

  it("refuses a step-up asserted for somebody else", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    const s = await w.start("step_up", { userId: "user_ada", sessionId })
    expect(
      reasonOf(
        await w.acs(w.respond(s.requestId, { nameId: "00u-other" }), {}, s.relayState),
      ),
    ).toBe("step_up_mismatch")
  })
})

describe("single logout", () => {
  const signRedirect = (
    xml: string,
    relay: string | null = "rs",
    key = idp.privateKey,
  ) => {
    let q = `SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString("base64"))}`
    if (relay) q += `&RelayState=${encodeURIComponent(relay)}`
    q += `&SigAlg=${encodeURIComponent("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256")}`
    q += `&Signature=${encodeURIComponent(rsaSign("sha256", Buffer.from(q), key).toString("base64"))}`
    return q
  }
  const logoutXml = (
    k: {
      id?: string
      nameId?: string
      sessionIndex?: string | null
      issuer?: string
    } = {},
  ) =>
    `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${k.id ?? "_lo1"}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${AUTH}/sso/saml/slo/${CONNECTION}">` +
    `<saml:Issuer>${k.issuer ?? ENTITY}</saml:Issuer>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${k.nameId ?? "00u-ada"}</saml:NameID>` +
    (k.sessionIndex === null
      ? ""
      : `<samlp:SessionIndex>${k.sessionIndex ?? "_sess1"}</samlp:SessionIndex>`) +
    `</samlp:LogoutRequest>`

  it("revokes the bound session an IdP's signed LogoutRequest names, and answers it", async () => {
    const w = await world({ spKey: true })
    const { sessionId } = await w.signIn()
    const done = await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "redirect",
      rawQuery: signRedirect(logoutXml()),
    })
    expect(done).toMatchObject({ outcome: "logged_out", revoked: 1 })
    expect(w.store.sessions.get(sessionId)!.revokedReason).toBe("idp_logout")
    expect(w.clerk.calls).toContain(`revokeSession:${sessionId}`)
    expect(w.forgotten).toContainEqual({ userId: "user_ada", sessionId })
    if (done.outcome !== "logged_out") return
    const back = new URL(done.redirectUrl!)
    expect(back.origin + back.pathname).toBe(SLO_IDP)
    expect(back.searchParams.get("RelayState")).toBe("rs")
    const answer = inflateRawSync(
      Buffer.from(back.searchParams.get("SAMLResponse")!, "base64"),
    ).toString()
    expect(answer).toContain(`InResponseTo="_lo1"`)
  })

  it("ends nothing for a SessionIndex it does not hold", async () => {
    const w = await world()
    await w.signIn()
    const done = await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "redirect",
      rawQuery: signRedirect(logoutXml({ sessionIndex: "_other" })),
    })
    expect(done).toMatchObject({ outcome: "logged_out", revoked: 0 })
  })

  const refusals: [string, () => string, string][] = [
    [
      "an unsigned LogoutRequest",
      () =>
        `SAMLRequest=${encodeURIComponent(deflateRawSync(Buffer.from(logoutXml())).toString("base64"))}`,
      "unsigned",
    ],
    [
      "one signed by another key",
      () => signRedirect(logoutXml(), "rs", keys().privateKey),
      "bad_signature",
    ],
    [
      "one from another issuer",
      () => signRedirect(logoutXml({ issuer: "https://evil.test" })),
      "issuer",
    ],
    [
      "a duplicated parameter",
      () => `${signRedirect(logoutXml())}&RelayState=x`,
      "duplicate_parameter",
    ],
    [
      "a tampered RelayState",
      () => signRedirect(logoutXml()).replace("RelayState=rs", "RelayState=rx"),
      "bad_signature",
    ],
  ]
  for (const [name, query, failure] of refusals)
    it(`refuses ${name}`, async () => {
      const w = await world()
      const { sessionId } = await w.signIn()
      const done = await finishSlo(w.slo, w.engine, {
        connectionId: CONNECTION,
        binding: "redirect",
        rawQuery: query(),
      })
      expect(done).toEqual({ outcome: "refused", failure })
      expect(w.store.sessions.get(sessionId)!.revokedAt).toBeNull()
      expect(w.store.events.at(-1)).toMatchObject({
        type: "logout.failed",
        reason: failure,
      })
    })

  it("refuses a replayed LogoutRequest", async () => {
    const w = await world()
    await w.signIn()
    const q = signRedirect(logoutXml())
    await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "redirect",
      rawQuery: q,
    })
    expect(
      await finishSlo(w.slo, w.engine, {
        connectionId: CONNECTION,
        binding: "redirect",
        rawQuery: q,
      }),
    ).toEqual({ outcome: "refused", failure: "replayed" })
  })

  it("answers 503 for a LogoutRequest when the replay cache is down", async () => {
    const w = await world()
    await w.signIn()
    w.replay.fail.down = true
    expect(
      await finishSlo(w.slo, w.engine, {
        connectionId: CONNECTION,
        binding: "redirect",
        rawQuery: signRedirect(logoutXml()),
      }),
    ).toEqual({ outcome: "unavailable" })
  })

  it("accepts a signed LogoutRequest on the POST binding, refuses an unsigned one", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    const unsigned = await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "post",
      parameter: "SAMLRequest",
      message: b64(logoutXml()),
      relayState: null,
    })
    expect(unsigned).toEqual({ outcome: "refused", failure: "unsigned" })
    const done = await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "post",
      parameter: "SAMLRequest",
      message: b64(sign(logoutXml({ id: "_lo2" }), idp, { target: "LogoutRequest" })),
      relayState: null,
    })
    expect(done).toMatchObject({ outcome: "logged_out", revoked: 1 })
    expect(w.store.sessions.get(sessionId)!.revokedAt).not.toBeNull()
  })

  it("refuses a signed POST LogoutRequest that repeats its own ID elsewhere", async () => {
    const w = await world()
    await w.signIn()
    const twin = logoutXml({ id: "_lo3" }).replace(
      "</saml:Issuer>",
      `</saml:Issuer><x xmlns="urn:example:twin" ID="_lo3"/>`,
    )
    const refused = await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "post",
      parameter: "SAMLRequest",
      message: b64(sign(twin, idp, { target: "LogoutRequest" })),
      relayState: null,
    })
    expect(refused).toEqual({ outcome: "refused", failure: "duplicate_id" })
  })

  it("takes a LogoutResponse as the end of our own logout, changing nothing", async () => {
    const w = await world()
    const xml = `<samlp:LogoutResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_x" Version="2.0" IssueInstant="${new Date().toISOString()}" InResponseTo="_y"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`
    const done = await finishSlo(w.slo, w.engine, {
      connectionId: CONNECTION,
      binding: "redirect",
      rawQuery: `SAMLResponse=${encodeURIComponent(deflateRawSync(Buffer.from(xml)).toString("base64"))}`,
    })
    expect(done).toEqual({ outcome: "done" })
  })

  it("SP-initiated: ends our session first, then sends a signed LogoutRequest", async () => {
    const w = await world({ spKey: true })
    const { sessionId } = await w.signIn()
    const done = await startLogout(w.slo, w.engine, {
      tenantId: TENANT,
      userId: "user_ada",
      sessionId,
    })
    expect(done.outcome).toBe("redirect")
    expect(w.store.sessions.get(sessionId)!.revokedReason).toBe("signed_out")
    if (done.outcome !== "redirect") return
    const url = new URL(done.redirectUrl)
    expect(url.searchParams.get("Signature")).not.toBeNull()
    const xml = inflateRawSync(
      Buffer.from(url.searchParams.get("SAMLRequest")!, "base64"),
    ).toString()
    expect(xml).toContain(">00u-ada</saml:NameID>")
    expect(xml).toContain("<samlp:SessionIndex>_sess1</samlp:SessionIndex>")
  })

  it("SP-initiated: refuses a session that is not this person's", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    expect(
      await startLogout(w.slo, w.engine, {
        tenantId: TENANT,
        userId: "user_eve",
        sessionId,
      }),
    ).toEqual({
      outcome: "not_saml",
    })
    expect(w.store.sessions.get(sessionId)!.revokedAt).toBeNull()
  })
})

describe("metadata and settings", () => {
  it("publishes SP metadata an IdP can read: ACS, SLO, our certificate", async () => {
    const w = await world({ spKey: true })
    const xml = w.engine.metadata(w.store.connections.get(CONNECTION)!)
    expect(xml).toContain(`Location="${ACS}"`)
    expect(xml).toContain(w.sp!.publicCert.certificate)
    expect(xml).toContain(`WantAssertionsSigned="true"`)
    expect(() => parseXml(xml)).not.toThrow()
  })

  it("reads IdP metadata, refusing redirects and http endpoints", async () => {
    const meta = (sso: string) =>
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${ENTITY}"><!-- shibboleth-style comment --><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${idp.cert.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sso}"/></md:IDPSSODescriptor></md:EntityDescriptor>`
    const parsed = parseIdpMetadata(meta("https://idp.acme.test/sso"))
    expect(parsed).toMatchObject({
      entityId: ENTITY,
      ssoUrl: "https://idp.acme.test/sso",
    })
    expect(parseIdpMetadata(meta("http://idp.acme.test/sso"))).toHaveProperty("error")
    expect(
      parseIdpMetadata(`<!DOCTYPE x>${meta("https://idp.acme.test/sso")}`),
    ).toEqual({
      error: "The metadata declares a DTD, which is not allowed.",
    })
    const redirecting = await world({
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://x.test" },
        })) as unknown as typeof fetch,
    })
    await expect(
      redirecting.engine.fetchMetadata("https://idp.acme.test/meta"),
    ).rejects.toThrow("redirects")
    const ok = await world({
      fetch: (async () =>
        new Response(meta("https://idp.acme.test/sso"))) as unknown as typeof fetch,
    })
    expect((await ok.engine.fetchMetadata("https://idp.acme.test/meta")).entityId).toBe(
      ENTITY,
    )
  })

  it("is ready only with settings, a certificate valid today, and a key when needed", async () => {
    const conn = samlConnection()
    const valid = [
      { notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 1e9) },
    ]
    expect(samlReady(conn, valid)).toBe(true)
    expect(samlReady(conn, [])).toBe(false)
    expect(
      samlReady(conn, [{ ...valid[0]!, notAfter: new Date(Date.now() - 1) }]),
    ).toBe(false)
    expect(samlReady(samlConnection({}, { signRequests: true }), valid)).toBe(false)
    expect(samlReady(samlConnection({}, { idpEntityId: undefined }), valid)).toBe(false)
  })

  it("round-trips a subject to the NameID a logout names", () => {
    const subject = subjectOf(
      {
        nameId: "00u-ada",
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        attributes: {},
      },
      null,
    )
    expect(subject).toBe("email:00u-ada")
    expect(nameIdOfSubject(subject!)).toEqual({
      nameId: "00u-ada",
      format: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    })
    expect(nameIdOfSubject("attribute:E-1")).toBeNull()
  })

  it("never gives a private key out of its seal", async () => {
    const made = await newSpKey("x")
    expect(() => createPrivateKey(made.privateKey.pem)).not.toThrow()
    expect(JSON.stringify(made.publicCert)).not.toContain("PRIVATE")
  })
})
