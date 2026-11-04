import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { SignJWT } from "jose"
import type { Connection } from "../src/identity/model.js"
import { oidcEngine } from "../src/identity/oidc.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { universalLogout } from "../src/identity/universal-logout.js"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import type { EgressVerdict } from "../src/webhooks/egress.js"
import {
  CONNECTION,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryReplay,
  memorySaml,
  memoryStore,
  user,
} from "./identity-fakes.js"
import { testIssuer } from "./oidc-issuer.js"
import { keys as samlKeys } from "./saml-idp.js"

/**
 * Okta Universal Logout (#23): server-to-server POST from Okta to end a person's
 * sessions when an identity threat is detected or an admin terminates access.
 *
 * Tested with locally signed tokens (both OIDC discovery JWKS and SAML certificates).
 * Note: Not tested against real Okta.
 */

const PUBLIC: EgressVerdict = { ok: true, address: "93.184.216.34", family: 4 }
const OTHER_CONNECTION = "44444444-4444-4444-8444-444444444444"
const SAML_CONNECTION = "55555555-5555-4555-8555-555555555555"
const ENDPOINT_URL = `https://api.i10.localhost/sso/universal-logout/${CONNECTION}`
const SAML_ENDPOINT_URL = `https://api.i10.localhost/sso/universal-logout/${SAML_CONNECTION}`

function oidcConnection(over: Partial<Connection> = {}) {
  return connection({
    id: CONNECTION,
    protocol: "oidc",
    provider: "okta",
    status: "active",
    config: {
      oidc: {
        issuer: "https://idp.acme.test",
        clientId: "client-acme",
        clientAuth: "client_secret_basic",
        clientSecretSet: true,
      },
    },
    ...over,
  })
}

function samlConnection(over: Partial<Connection> = {}) {
  return connection({
    id: SAML_CONNECTION,
    protocol: "saml",
    provider: "okta",
    status: "active",
    config: {
      saml: {
        ssoUrl: "https://idp.acme.test/app/exk123/sso/saml",
        idpEntityId: "http://www.okta.com/exk123",
      },
    },
    ...over,
  })
}

async function world(
  options: {
    connection?: Connection
    more?: Connection[]
    liveDomains?: string[]
  } = {},
) {
  const idp = await testIssuer({ issuer: "https://idp.acme.test" })
  const samlIdpKeys = samlKeys(2048, "idp.acme.test")
  const conn = options.connection ?? oidcConnection()
  const samlConn = samlConnection()
  const store = memoryStore({
    connections: [conn, samlConn, ...(options.more ?? [])],
    live: {
      [conn.id]: options.liveDomains ?? ["acme.test"],
      [samlConn.id]: options.liveDomains ?? ["acme.test"],
    },
  })

  const clerk = memoryClerk()
  const replay = memoryReplay()
  const saml = memorySaml(store)
  const forgotten: { userId?: string; sessionId?: string }[] = []

  // Store SAML certificate on samlConn
  await saml.saml.addCertificate(
    samlConn.tenantId,
    samlConn.id,
    {
      fingerprint: samlIdpKeys.cert.fingerprint,
      certificate: samlIdpKeys.cert.certificate,
      subject: samlIdpKeys.cert.subject,
      notBefore: samlIdpKeys.cert.notBefore,
      notAfter: samlIdpKeys.cert.notAfter,
      source: "metadata",
    },
    null,
  )

  const engine = oidcEngine({
    store: store.store,
    fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
    redirectUri: "https://auth.i10.localhost/sso/callback",
    google: null,
    log,
  })

  const logout = universalLogout(
    {
      store: store.store,
      sessions: saml.saml,
      samlStore: saml.saml,
      clerk: clerk.clerk,
      replay: replay.replay,
      forget: (input) => forgotten.push(input),
      fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
      log,
      endpointUrl: (id: string) =>
        `https://api.i10.localhost/sso/universal-logout/${id}`,
    },
    engine,
  )

  let n = 0
  const bound = (
    sessionId: string,
    over: {
      sub?: string
      sid?: string | null
      connectionId?: string
      tenantId?: string
      email?: string | null
    } = {},
  ) => {
    const subject = over.sub ?? "00u_ada"
    const connectionId = over.connectionId ?? conn.id
    const tenantId = over.tenantId ?? TENANT
    const email = over.email !== undefined ? over.email : "ada@acme.test"
    let identity = store.identities.find(
      (i) => i.subject === subject && i.connectionId === connectionId,
    )
    if (!identity) {
      identity = {
        id: `00000000-0000-4000-a000-${String(++n).padStart(12, "0")}`,
        tenantId,
        connectionId,
        subject,
        clerkUserId: `user_${subject.replace(/\W/g, "")}`,
        email,
        lastLoginAt: null,
      }
      store.identities.push(identity)
    }

    // Add user to clerk
    if (email) {
      clerk.users.set(
        identity.clerkUserId,
        user({
          id: identity.clerkUserId,
          firstName: "Ada",
          lastName: "Lovelace",
          banned: false,
          emails: [{ id: "em_1", address: email, verified: true }],
        }),
      )
    }

    store.sessions.set(sessionId, {
      sessionId,
      tenantId,
      clerkUserId: identity.clerkUserId,
      connectionId,
      identityId: identity.id,
      idpSession: over.sid === undefined ? "idp-session-1" : over.sid,
      authTime: null,
      boundAt: new Date(),
      freshAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
      revokedReason: null,
    })

    return { identity, sessionId }
  }

  // Token minter helper for OIDC
  async function mintOidcToken(
    over: {
      jti?: string
      iss?: string
      sub?: string
      aud?: string | string[]
      typ?: string
      alg?: string
      iat?: number
      exp?: number | string
      kid?: string
      rogueKey?: boolean
    } = {},
  ) {
    const nowSec = Math.floor(Date.now() / 1000)
    const token = new SignJWT({
      jti: over.jti ?? `jti-${Math.random()}`,
      iss: over.iss ?? "https://idp.acme.test",
      sub: over.sub ?? "client-acme",
      aud: over.aud ?? ENDPOINT_URL,
      iat: over.iat ?? nowSec,
    })
      .setProtectedHeader({
        alg: over.alg ?? "RS256",
        typ: over.typ ?? "global-token-revocation+jwt",
        kid: over.kid ?? idp.kid,
      })
      .setExpirationTime(over.exp ?? "5m")

    return token.sign(over.rogueKey ? idp.rogue.privateKey : idp.signing.privateKey)
  }

  // Token minter helper for SAML
  async function mintSamlToken(
    over: {
      jti?: string
      iss?: string
      sub?: string
      aud?: string | string[]
      typ?: string
      alg?: string
      iat?: number
      exp?: number | string
      key?: typeof samlIdpKeys
    } = {},
  ) {
    const signer = over.key ?? samlIdpKeys
    const nowSec = Math.floor(Date.now() / 1000)
    const token = new SignJWT({
      jti: over.jti ?? `jti-${Math.random()}`,
      iss: over.iss ?? "https://idp.acme.test",
      sub: over.sub ?? "app-instance-okta-123",
      aud: over.aud ?? SAML_ENDPOINT_URL,
      iat: over.iat ?? nowSec,
    })
      .setProtectedHeader({
        alg: over.alg ?? "RS256",
        typ: over.typ ?? "global-token-revocation+jwt",
      })
      .setExpirationTime(over.exp ?? "5m")

    return token.sign(signer.privateKey)
  }

  const call = (input: {
    connectionId?: string
    token?: string
    authHeader?: string | null
    body?: unknown
  }) => {
    const connectionId = input.connectionId ?? CONNECTION
    const authHeader =
      input.authHeader !== undefined
        ? input.authHeader
        : input.token
          ? `Bearer ${input.token}`
          : null
    return logout({
      connectionId,
      authHeader,
      body: input.body ?? {
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_ada" },
      },
    })
  }

  const live = (sessionId: string) => store.sessions.get(sessionId)!.revokedAt === null
  const failures = () => store.events.filter((e) => e.type === "logout.failed")

  return {
    idp,
    samlIdpKeys,
    saml,
    store,
    clerk,
    replay,
    forgotten,
    bound,
    call,
    live,
    failures,
    logout,
    mintOidcToken,
    mintSamlToken,
    conn,
    samlConn,
  }
}

describe("Okta Universal Logout for OIDC connections", () => {
  it("revokes active sessions for an existing subject with iss_sub format", async () => {
    const w = await world()
    w.bound("sess_1", { sub: "00u_ada" })
    w.bound("sess_2", { sub: "00u_ada" })
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_ada" },
      },
    })

    expect(outcome).toEqual({ outcome: "logged_out", revoked: 2 })
    expect(w.live("sess_1")).toBe(false)
    expect(w.live("sess_2")).toBe(false)
    expect(w.store.events.some((e) => e.type === "logout.idp")).toBe(true)
    expect(w.store.events.filter((e) => e.type === "session.revoked").length).toBe(2)
  })

  it("answers 204 for a known person with no open sessions", async () => {
    const w = await world()
    // Identity exists, but no sessions are created
    w.store.identities.push({
      id: "id_1",
      tenantId: TENANT,
      connectionId: CONNECTION,
      subject: "00u_ada",
      clerkUserId: "user_ada",
      email: "ada@acme.test",
      lastLoginAt: null,
    })
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_ada" },
      },
    })

    expect(outcome).toEqual({ outcome: "logged_out", revoked: 0 })
    expect(w.store.events.some((e) => e.type === "logout.idp")).toBe(true)
  })

  it("revokes sessions looked up by email on a live domain", async () => {
    const w = await world()
    w.bound("sess_1", { sub: "00u_ada", email: "ada@acme.test" })
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "email", email: "ada@acme.test" },
      },
    })

    expect(outcome).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_1")).toBe(false)
  })

  it("refuses with 404 when email is not on this connection's live domains", async () => {
    const w = await world()
    w.bound("sess_1", { sub: "00u_ada", email: "ada@other.test" })
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "email", email: "ada@other.test" },
      },
    })

    expect(outcome).toEqual({ outcome: "not_found" })
    expect(w.live("sess_1")).toBe(true)
  })

  it("refuses with 404 when email is on live domain but user has no identity on this connection", async () => {
    const w = await world()
    // User exists in Clerk on acme.test, but never linked on this connection
    w.clerk.users.set(
      "user_bob",
      user({
        id: "user_bob",
        firstName: "Bob",
        lastName: "Smith",
        banned: false,
        emails: [{ id: "em_b", address: "bob@acme.test", verified: true }],
      }),
    )
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "email", email: "bob@acme.test" },
      },
    })

    expect(outcome).toEqual({ outcome: "not_found" })
  })

  it("refuses with 404 when iss_sub names an unknown subject", async () => {
    const w = await world()
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_unknown" },
      },
    })

    expect(outcome).toEqual({ outcome: "not_found" })
  })

  it("refuses with 404 when iss_sub has a mismatched issuer in the body", async () => {
    const w = await world()
    w.bound("sess_1", { sub: "00u_ada" })
    const token = await w.mintOidcToken()

    const outcome = await w.call({
      token,
      body: {
        sub_id: { format: "iss_sub", iss: "https://other-issuer.test", sub: "00u_ada" },
      },
    })

    expect(outcome).toEqual({ outcome: "not_found" })
    expect(w.live("sess_1")).toBe(true)
  })
})

describe("Okta Universal Logout for SAML connections", () => {
  it("verifies against connection's stored IdP certificate and revokes sessions", async () => {
    const w = await world()
    w.bound("sess_saml_1", {
      connectionId: SAML_CONNECTION,
      sub: "saml_ada",
      email: "ada@acme.test",
    })
    const token = await w.mintSamlToken()

    const outcome = await w.call({
      connectionId: SAML_CONNECTION,
      token,
      body: {
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "saml_ada" },
      },
    })

    expect(outcome).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_saml_1")).toBe(false)
  })

  it("works with email lookup on SAML connection", async () => {
    const w = await world()
    w.bound("sess_saml_1", {
      connectionId: SAML_CONNECTION,
      sub: "saml_ada",
      email: "ada@acme.test",
    })
    const token = await w.mintSamlToken()

    const outcome = await w.call({
      connectionId: SAML_CONNECTION,
      token,
      body: {
        sub_id: { format: "email", email: "ada@acme.test" },
      },
    })

    expect(outcome).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_saml_1")).toBe(false)
  })

  it("verifies with rotated second certificate when first certificate does not match", async () => {
    const w = await world()
    w.bound("sess_saml_1", { connectionId: SAML_CONNECTION, sub: "saml_ada" })

    // Generate a fresh new key pair as the active signing key
    const newKeys = samlKeys(2048, "idp.acme.test")
    await w.saml.saml.addCertificate(
      w.samlConn.tenantId,
      w.samlConn.id,
      {
        fingerprint: newKeys.cert.fingerprint,
        certificate: newKeys.cert.certificate,
        subject: newKeys.cert.subject,
        notBefore: newKeys.cert.notBefore,
        notAfter: newKeys.cert.notAfter,
        source: "metadata",
      },
      null,
    )

    const token = await w.mintSamlToken({ key: newKeys })

    const outcome = await w.call({
      connectionId: SAML_CONNECTION,
      token,
      body: {
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "saml_ada" },
      },
    })

    expect(outcome).toEqual({ outcome: "logged_out", revoked: 1 })
    expect(w.live("sess_saml_1")).toBe(false)
  })

  it("refuses with 401 when IdP certificate has expired", async () => {
    const w = await world()
    // Make cert expired
    w.saml.certs[0]!.notAfter = new Date(Date.now() - 3600 * 1000)
    const token = await w.mintSamlToken()

    const outcome = await w.call({
      connectionId: SAML_CONNECTION,
      token,
    })

    expect(outcome.outcome).toBe("bad_auth")
  })
})

describe("token and authentication refusals (401)", () => {
  it("refuses when Authorization header is missing", async () => {
    const w = await world()
    const outcome = await w.call({ authHeader: null })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "malformed" })
  })

  it("refuses when Authorization header is not Bearer", async () => {
    const w = await world()
    const outcome = await w.call({ authHeader: "Basic dXNlcjpwYXNz" })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "malformed" })
  })

  it("refuses when token is not a valid JWS format", async () => {
    const w = await world()
    const outcome = await w.call({ token: "not-a-token" })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "malformed" })
  })

  it("refuses when typ header is not global-token-revocation+jwt", async () => {
    const w = await world()
    const token = await w.mintOidcToken({ typ: "JWT" })
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "typ" })
    expect(w.failures().some((f) => f.reason === "typ")).toBe(true)
  })

  it("refuses when alg is symmetric (e.g. HS256)", async () => {
    const w = await world()
    const token = await new SignJWT({
      jti: "1",
      sub: "client-acme",
      iss: "https://idp.acme.test",
      aud: ENDPOINT_URL,
    })
      .setProtectedHeader({ alg: "HS256", typ: "global-token-revocation+jwt" })
      .sign(new TextEncoder().encode("symmetric-secret-key-that-is-at-least-32-bytes"))

    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "bad_signature" })
  })

  it("refuses when token signature is invalid", async () => {
    const w = await world()
    const otherIdp = await testIssuer({ issuer: "https://idp.other.test" })
    const token = await new SignJWT({
      jti: "1",
      sub: "client-acme",
      iss: "https://idp.acme.test",
      aud: ENDPOINT_URL,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: "RS256", typ: "global-token-revocation+jwt" })
      .setExpirationTime("5m")
      .sign(otherIdp.signing.privateKey)

    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "bad_signature" })
  })

  it("refuses when issuer does not match connection issuer", async () => {
    const w = await world()
    const token = await w.mintOidcToken({ iss: "https://wrong-issuer.test" })
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "issuer" })
    expect(w.failures().some((f) => f.reason === "issuer")).toBe(true)
  })

  it("refuses when audience does not match endpoint URL", async () => {
    const w = await world()
    const token = await w.mintOidcToken({ aud: "https://other-app.test/endpoint" })
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "audience" })
    expect(w.failures().some((f) => f.reason === "audience")).toBe(true)
  })

  it("refuses when token is expired", async () => {
    const w = await world()
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await w.mintOidcToken({
      iat: nowSec - 300,
      exp: nowSec - 200,
    })
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "expired" })
  })

  it("refuses when iat is older than 10 minutes", async () => {
    const w = await world()
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await w.mintOidcToken({
      iat: nowSec - 11 * 60,
      exp: nowSec + 300,
    })
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "iat" })
  })

  it("refuses when jti is replayed", async () => {
    const w = await world()
    w.bound("sess_1", { sub: "00u_ada" })
    const token = await w.mintOidcToken({ jti: "fixed-jti-12345" })

    const first = await w.call({ token })
    expect(first.outcome).toBe("logged_out")

    const second = await w.call({ token })
    expect(second).toEqual({ outcome: "bad_auth", failure: "replayed" })
  })

  it("refuses when OIDC sub does not match clientId", async () => {
    const w = await world()
    const token = await w.mintOidcToken({ sub: "wrong-client-id" })
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "subject" })
  })

  it("refuses when connection is unknown", async () => {
    const w = await world()
    const token = await w.mintOidcToken()
    const outcome = await w.call({ connectionId: OTHER_CONNECTION, token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "unknown_connection" })
  })

  it("refuses when connection is not Okta", async () => {
    const w = await world({
      connection: oidcConnection({ provider: "entra" }),
    })
    const token = await w.mintOidcToken()
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "unknown_connection" })
  })

  it("refuses when connection is in draft status", async () => {
    const w = await world({
      connection: oidcConnection({ status: "draft" }),
    })
    const token = await w.mintOidcToken()
    const outcome = await w.call({ token })
    expect(outcome).toEqual({ outcome: "bad_auth", failure: "unknown_connection" })
  })
})

describe("body validation refusals (400)", () => {
  it("refuses when body is missing sub_id", async () => {
    const w = await world()
    const token = await w.mintOidcToken()
    const outcome = await w.call({ token, body: {} })
    expect(outcome).toEqual({ outcome: "malformed" })
  })

  it("refuses when sub_id has an unknown format", async () => {
    const w = await world()
    const token = await w.mintOidcToken()
    const outcome = await w.call({
      token,
      body: { sub_id: { format: "opaque", id: "00u123" } },
    })
    expect(outcome).toEqual({ outcome: "malformed" })
  })

  it("refuses when email format has an empty email", async () => {
    const w = await world()
    const token = await w.mintOidcToken()
    const outcome = await w.call({
      token,
      body: { sub_id: { format: "email", email: "" } },
    })
    expect(outcome).toEqual({ outcome: "malformed" })
  })

  it("refuses when iss_sub format is missing iss or sub", async () => {
    const w = await world()
    const token = await w.mintOidcToken()
    const outcome = await w.call({
      token,
      body: { sub_id: { format: "iss_sub", iss: "https://idp.acme.test" } },
    })
    expect(outcome).toEqual({ outcome: "malformed" })
  })
})

describe("HTTP route POST /sso/universal-logout/:connection", () => {
  async function testApp() {
    const w = await world()
    const app = new Hono()
    app.route(
      "/sso",
      createSsoRoutes({
        bridge: {} as SsoRouteDeps["bridge"],
        gate: {} as SsoRouteDeps["gate"],
        identify: {} as SsoRouteDeps["identify"],
        returnOrigins: [],
        testEngine: false,
        universalLogout: w.logout,
        mayManage: async () => true,
        tenantOfConnection: async () => TENANT,
      }),
    )
    return { w, app }
  }

  it("answers 204 with Cache-Control no-store on valid logout", async () => {
    const { w, app } = await testApp()
    w.bound("sess_1", { sub: "00u_ada" })
    const token = await w.mintOidcToken()

    const res = await app.request(`/sso/universal-logout/${CONNECTION}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_ada" },
      }),
    })

    expect(res.status).toBe(204)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(w.live("sess_1")).toBe(false)
  })

  it("answers 401 on bad authorization", async () => {
    const { app } = await testApp()
    const res = await app.request(`/sso/universal-logout/${CONNECTION}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_ada" },
      }),
    })

    expect(res.status).toBe(401)
  })

  it("answers 400 on malformed body", async () => {
    const { w, app } = await testApp()
    const token = await w.mintOidcToken()

    const res = await app.request(`/sso/universal-logout/${CONNECTION}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sub_id: { format: "unknown_format" },
      }),
    })

    expect(res.status).toBe(400)
  })

  it("answers 404 on unknown user", async () => {
    const { w, app } = await testApp()
    const token = await w.mintOidcToken()

    const res = await app.request(`/sso/universal-logout/${CONNECTION}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_no_one" },
      }),
    })

    expect(res.status).toBe(404)
  })
})
