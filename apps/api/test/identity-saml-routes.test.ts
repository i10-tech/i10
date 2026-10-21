import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { inflateRawSync } from "node:zlib"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import type { BridgeDeps } from "../src/identity/bridge.js"
import type { Connection } from "../src/identity/model.js"
import { IdpUnreachable } from "../src/identity/oidc-fetch.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { samlEngine, storedSaml } from "../src/identity/saml.js"
import { crossedThreshold, dailySamlPass } from "../src/identity/saml-refresh.js"
import type { IdpMetadata } from "../src/identity/saml-messages.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryReplay,
  memorySaml,
  memoryStore,
} from "./identity-fakes.js"
import { ENTITY, assertionXml, b64, keys, responseXml, sign } from "./saml-idp.js"

/**
 * The SAML routes on `/sso` (#339): strict bodies, the bigger body limit
 * only where a response is posted, the public SP metadata, 503 for every
 * failure we cannot answer; and the daily pass (metadata refresh, expiry
 * alerts at 30, 7, 1 and 0 days).
 */

const BINDING = "b".repeat(43)
const FRESH = "f".repeat(43)
const idp = keys()

function samlConnection(
  over: Partial<Connection> = {},
  saml: Record<string, unknown> = {},
) {
  return connection({
    protocol: "saml",
    provider: "okta",
    config: {
      saml: { idpEntityId: ENTITY, ssoUrl: "https://idp.acme.test/sso", ...saml },
    },
    ...over,
  })
}

async function routes(over: { connection?: Connection; signedIn?: boolean } = {}) {
  const store = memoryStore({ connections: [over.connection ?? samlConnection()] })
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
      vet: async () => ({ ok: true, address: "93.184.216.34", family: 4 }),
    }),
    replay: replay.replay,
    authOrigin: "https://auth.i10.localhost",
    log,
  })
  const bridge: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([["saml", engine]]),
    join: async () => "added",
    isExempt: async () => false,
    log,
  }
  const deps: SsoRouteDeps = {
    bridge,
    gate: { forget: () => {} } as unknown as SsoRouteDeps["gate"],
    identify: async () =>
      over.signedIn
        ? { status: "signed-in", userId: "user_ada", sessionId: "sess_1" }
        : { status: "signed-out" },
    returnOrigins: ["https://dash.i10.localhost"],
    testEngine: false,
    saml: {
      engine,
      slo: {
        store: store.store,
        saml: saml.saml,
        clerk: clerk.clerk,
        replay: replay.replay,
        forget: () => {},
        log,
      },
    },
    mayManage: async () => true,
    tenantOfConnection: async () => TENANT,
  } as unknown as SsoRouteDeps
  const app = new Hono().route("/sso", createSsoRoutes(deps))
  const post = (path: string, body: unknown) =>
    app.request(`/sso${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  return { app, post, store, saml, replay }
}

describe("the SAML routes", () => {
  it("starts with protocol saml, so apps/auth knows to set the SAML cookie", async () => {
    const r = await routes()
    const res = await r.post("/attempts", { connection: CONNECTION, binding: BINDING })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { protocol: string; redirectUrl: string }
    expect(body.protocol).toBe("saml")
    const xml = inflateRawSync(
      Buffer.from(new URL(body.redirectUrl).searchParams.get("SAMLRequest")!, "base64"),
    ).toString()
    expect(xml).toContain("AuthnRequest")
  })

  it("signs in through POST /sso/saml/acs", async () => {
    const r = await routes()
    const start = (await (
      await r.post("/attempts", { connection: CONNECTION, binding: BINDING })
    ).json()) as { redirectUrl: string }
    const url = new URL(start.redirectUrl)
    const id = /ID="([^"]+)"/.exec(
      inflateRawSync(
        Buffer.from(url.searchParams.get("SAMLRequest")!, "base64"),
      ).toString(),
    )![1]!
    const res = await r.post("/saml/acs", {
      connection: CONNECTION,
      samlResponse: b64(
        responseXml(sign(assertionXml({ inResponseTo: id }), idp), {
          inResponseTo: id,
        }),
      ),
      relayState: url.searchParams.get("RelayState"),
      binding: BINDING,
      freshBinding: FRESH,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: "signed_in" })
  })

  it("refuses malformed ACS bodies with 422", async () => {
    const r = await routes()
    for (const body of [
      {},
      { connection: "nope", samlResponse: "x", freshBinding: FRESH },
      { connection: CONNECTION, samlResponse: "x", freshBinding: "short" },
      {
        connection: CONNECTION,
        samlResponse: "x",
        freshBinding: FRESH,
        relayState: "r".repeat(81),
      },
      { connection: CONNECTION, samlResponse: "", freshBinding: FRESH },
    ])
      expect((await r.post("/saml/acs", body)).status).toBe(422)
  })

  it("answers 409 for a refused response", async () => {
    const r = await routes()
    const res = await r.post("/saml/acs", {
      connection: CONNECTION,
      samlResponse: b64("<x/>"),
      relayState: null,
      freshBinding: FRESH,
    })
    expect(res.status).toBe(409)
  })

  it("takes a big body only at the ACS", async () => {
    const r = await routes()
    const big = {
      connection: CONNECTION,
      samlResponse: "A".repeat(100_000),
      freshBinding: FRESH,
    }
    expect((await r.post("/saml/acs", big)).status).toBe(409)
    expect((await r.post("/attempts", { ...big, binding: BINDING })).status).toBe(413)
    const huge = { ...big, samlResponse: "A".repeat(500_000) }
    expect((await r.post("/saml/acs", huge)).status).toBe(413)
  })

  it("answers 503 when the certificates cannot be read", async () => {
    const r = await routes({ connection: samlConnection({}, { idpInitiated: true }) })
    r.saml.saml.certificates = async () => {
      throw new IdpUnreachable("down", "network")
    }
    const res = await r.post("/saml/acs", {
      connection: CONNECTION,
      samlResponse: b64("<x/>"),
      relayState: null,
      freshBinding: FRESH,
    })
    expect(res.status).toBe(503)
  })

  it("publishes SP metadata for SAML connections only", async () => {
    const r = await routes()
    const res = await r.app.request(`/sso/saml/metadata/${CONNECTION}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("samlmetadata+xml")
    expect(await res.text()).toContain("SPSSODescriptor")
    expect((await r.app.request("/sso/saml/metadata/nope")).status).toBe(404)
    r.store.connections.get(CONNECTION)!.protocol = "oidc"
    expect((await r.app.request(`/sso/saml/metadata/${CONNECTION}`)).status).toBe(404)
  })

  it("refuses an unparsable logout body, and an unsigned logout with 409", async () => {
    const r = await routes()
    expect(
      (await r.post("/saml/slo", { connection: CONNECTION, binding: "soap" })).status,
    ).toBe(422)
    const res = await r.post("/saml/slo", {
      connection: CONNECTION,
      binding: "redirect",
      rawQuery: "SAMLRequest=abc",
    })
    expect(res.status).toBe(409)
  })

  it("refuses SP-initiated logout when signed out, answers nothing to do for the unmanaged", async () => {
    expect((await (await routes()).post("/saml/logout", {})).status).toBe(401)
    const r = await routes({ signedIn: true })
    const res = await r.post("/saml/logout", {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ redirectUrl: null })
  })
})

describe("the daily pass", () => {
  const day = 24 * 60 * 60 * 1000
  const meta = (certificate = idp.cert, entityId = ENTITY): IdpMetadata => ({
    entityId,
    ssoUrl: "https://idp.acme.test/sso2",
    sloUrl: null,
    sloResponseUrl: null,
    certificates: [certificate],
    wantAuthnRequestsSigned: false,
  })

  it("alerts once per threshold: 30, 7, 1, then expired", () => {
    const now = new Date()
    const at = (days: number, alertedDays: number | null) =>
      crossedThreshold(
        { notAfter: new Date(now.getTime() + days * day), alertedDays },
        now,
      )
    expect(at(40, null)).toBeNull()
    expect(at(29, null)).toBe(30)
    expect(at(29, 30)).toBeNull()
    expect(at(6, 30)).toBe(7)
    expect(at(0.5, 7)).toBe(1)
    expect(at(-1, 1)).toBe(0)
    expect(at(-1, 0)).toBeNull()
  })

  async function pass(
    saml: Record<string, unknown>,
    fetchMetadata: (url: string) => Promise<IdpMetadata>,
  ) {
    const store = memoryStore({ connections: [samlConnection({}, saml)] })
    const rows = memorySaml(store)
    const soon = keys(2048, "soon", 5)
    await rows.saml.addCertificate(
      TENANT,
      CONNECTION,
      { ...soon.cert, source: "upload" },
      null,
    )
    const summary = await dailySamlPass({
      store: store.store,
      saml: rows.saml,
      fetchMetadata,
      log,
    })
    return { store, rows, summary }
  }

  it("refreshes from the metadata URL, and alerts an expiring certificate once", async () => {
    const w = await pass({ metadataUrl: "https://idp.acme.test/metadata" }, async () =>
      meta(),
    )
    expect(w.summary).toMatchObject({ connections: 1, refreshed: 1, alerts: 1 })
    expect(storedSaml(w.store.connections.get(CONNECTION)!).ssoUrl).toBe(
      "https://idp.acme.test/sso2",
    )
    expect(w.store.events.map((e) => e.type)).toEqual([
      "connection.metadata_refreshed",
      "sso.certificate.expiring",
    ])
    expect(w.store.events[1]).toMatchObject({ reason: "7_days" })
    const again = await dailySamlPass({
      store: w.store.store,
      saml: w.rows.saml,
      fetchMetadata: async () => meta(),
      log,
    })
    expect(again.alerts).toBe(0)
  })

  it("refuses metadata that names another entity id", async () => {
    const w = await pass({ metadataUrl: "https://idp.acme.test/metadata" }, async () =>
      meta(idp.cert, "https://evil.test"),
    )
    expect(storedSaml(w.store.connections.get(CONNECTION)!)).toMatchObject({
      idpEntityId: ENTITY,
      metadataError: "entity_id_changed",
    })
    expect(w.rows.certs.some((c) => c.fingerprint === idp.cert.fingerprint)).toBe(false)
  })

  it("records an unreachable metadata URL and changes nothing else", async () => {
    const w = await pass(
      { metadataUrl: "https://idp.acme.test/metadata" },
      async () => {
        throw new IdpUnreachable("down", "timeout")
      },
    )
    expect(w.summary.failed).toBe(1)
    expect(storedSaml(w.store.connections.get(CONNECTION)!)).toMatchObject({
      ssoUrl: "https://idp.acme.test/sso",
      metadataError: "timeout",
    })
    expect(w.store.events.some((e) => e.type === "connection.metadata_failed")).toBe(
      true,
    )
  })

  it("rethrows anything that is not an IdP problem", async () => {
    await expect(
      pass({ metadataUrl: "https://idp.acme.test/metadata" }, async () => {
        throw new Error("bug")
      }),
    ).rejects.toThrow("bug")
  })
})
