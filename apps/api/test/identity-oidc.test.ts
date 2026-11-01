import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  bind,
  redeemHandoff,
  startLogin,
  type BridgeDeps,
} from "../src/identity/bridge.js"
import type { Connection } from "../src/identity/model.js"
import {
  finishOidc,
  newSigningKey,
  oidcEngine,
  oidcReady,
  publicJwks,
  readCallbackQuery,
  settingsFor,
  toAssertion,
  type CallbackQuery,
} from "../src/identity/oidc.js"
import { guardedFetch, IdpUnreachable } from "../src/identity/oidc-fetch.js"
import { OIDC_PRESETS } from "../src/identity/oidc-presets.js"
import { vetHost, type EgressVerdict } from "../src/webhooks/egress.js"
import { loadEnv } from "../src/env.js"
import { createSsoRoutes, type SsoRouteDeps } from "../src/routes/sso.js"
import {
  CONNECTION,
  ORG,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"
import { testIssuer, type IssuerOptions, type TokenKnobs } from "./oidc-issuer.js"

/**
 * The OIDC engine (#338) against an OpenID Provider running in this process
 * (test/oidc-issuer.ts), through the whole bridge with the in-memory ports:
 * every check openid-client makes, the ones we add (Google `hd`, MFA by `acr`,
 * step-up), and the egress guard in front of every fetch.
 */

const BINDING = "b".repeat(43)
const OTHER_BROWSER = "c".repeat(43)
const REDIRECT = "https://auth.i10.localhost/sso/callback"
/** What the guard sees DNS answer for the IdP: a public address. */
const PUBLIC: EgressVerdict = { ok: true, address: "93.184.216.34", family: 4 }

function oidcConnection(
  over: Partial<Connection> = {},
  oidc: Record<string, unknown> = {},
) {
  return connection({
    protocol: "oidc",
    provider: "okta",
    config: {
      oidc: {
        issuer: "https://idp.acme.test",
        clientId: "client-acme",
        clientAuth: "client_secret_basic",
        clientSecretSet: true,
        ...oidc,
      },
    },
    ...over,
  })
}

async function world(
  options: {
    connection?: Connection
    issuer?: IssuerOptions
    google?: boolean
    live?: string[]
    vet?: (host: string, signal: AbortSignal) => Promise<EgressVerdict>
    secrets?: Record<string, unknown>
  } = {},
) {
  const idp = await testIssuer(options.issuer)
  const store = memoryStore({
    connections: [options.connection ?? oidcConnection()],
    live: { [CONNECTION]: options.live ?? ["acme.test"] },
  })
  store.secrets.set(
    CONNECTION,
    options.secrets ?? { oidc: { clientSecret: idp.clientSecret } },
  )
  const clerk = memoryClerk()
  const engine = oidcEngine({
    store: store.store,
    fetch: guardedFetch({ vet: options.vet ?? (async () => PUBLIC), fetch: idp.fetch }),
    redirectUri: REDIRECT,
    google: options.google
      ? {
          clientId: "google-client.apps.googleusercontent.com",
          clientSecret: idp.clientSecret,
        }
      : null,
    log,
  })
  const VIA = options.connection?.provider === "google" ? "google" : "oidc"
  const deps: BridgeDeps = {
    store: store.store,
    clerk: clerk.clerk,
    engines: new Map([["oidc", engine]]),
    join: async () => "added",
    isExempt: async () => false,
    log,
  }

  async function start(
    purpose: "sign_in" | "test_run" | "step_up" = "sign_in",
    stepUp?: { userId: string; sessionId: string },
    loginHint?: string,
    forceLogin?: boolean,
  ) {
    const started = await startLogin(deps, {
      connectionId: CONNECTION,
      purpose,
      binding: BINDING,
      returnTo: "https://dash.i10.localhost/",
      ...(loginHint ? { loginHint } : {}),
      ...(forceLogin ? { forceLogin } : {}),
      ...(stepUp ? { stepUp } : {}),
    })
    if (started.outcome !== "redirect")
      throw new Error(`not started: ${started.reason}`)
    return started.redirectUrl
  }

  /** Start, the IdP, the callback: what `/sso/oidc/callback` answers. */
  async function callback(
    knobs: TokenKnobs = {},
    over: {
      binding?: string
      state?: string
      query?: Partial<CallbackQuery>
      via?: "oidc" | "google"
    } = {},
    purpose: "sign_in" | "step_up" = "sign_in",
    stepUp?: { userId: string; sessionId: string },
  ) {
    const redirectUrl = await start(purpose, stepUp)
    const at = idp.authorize(redirectUrl, knobs)
    const done = await finishOidc(deps, engine, {
      via: over.via ?? VIA,
      state: over.state ?? at.state,
      binding: over.binding ?? BINDING,
      query: { ...at.query, ...over.query },
    })
    return { done, at, redirectUrl }
  }

  /** The whole sign-in, through to a bound session. */
  async function signIn(knobs: TokenKnobs = {}) {
    const { done } = await callback(knobs)
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

  return { idp, store, clerk, engine, deps, start, callback, signIn, via: VIA }
}

const refusal = (done: { outcome: string; reason?: string }) =>
  done.outcome === "refused" ? done.reason : done.outcome

describe("an OIDC sign-in through the bridge", () => {
  it("claims and links the person by `sub`, all the way to a bound session", async () => {
    const w = await world()
    const { bound } = await w.signIn()
    expect(bound.outcome).toBe("bound")
    expect(w.store.identities).toHaveLength(1)
    expect(w.store.identities[0]).toMatchObject({
      subject: "idp|ada",
      clerkUserId: "user_ada",
    })
    expect(w.store.managed.get("user_ada")).toMatchObject({
      reason: "claimed",
      tenantId: TENANT,
    })
    expect(w.clerk.minted).toEqual([{ userId: "user_ada", orgId: ORG }])
    // The bound session keeps the IdP's session id for logout (#345).
    const [session] = [...w.store.sessions.values()]
    expect(session).toMatchObject({ idpSession: "idp-session-1" })
  })

  it("asks for the code flow with PKCE S256, state, nonce and the default scopes", async () => {
    const w = await world()
    const url = new URL(await w.start())
    const p = url.searchParams
    expect(url.origin + url.pathname).toBe("https://idp.acme.test/authorize")
    expect(p.get("response_type")).toBe("code")
    expect(p.get("client_id")).toBe("client-acme")
    expect(p.get("redirect_uri")).toBe(REDIRECT)
    expect(p.get("scope")).toBe("openid email profile")
    expect(p.get("code_challenge_method")).toBe("S256")
    expect(p.get("state")).toHaveLength(43)
    expect(p.get("nonce")).toHaveLength(43)
    expect(p.get("prompt")).toBeNull()
    expect(p.get("max_age")).toBeNull()
    // The challenge is S256 of the verifier the attempt keeps, sealed.
    const [attempt] = [...w.store.attempts.values()]
    expect(p.get("code_challenge")).toBe(
      createHash("sha256").update(attempt!.pkceVerifier!).digest("base64url"),
    )
    expect(attempt!.nonce).toBe(p.get("nonce"))
  })

  it("links again by `sub` on the next sign-in, even after an email change", async () => {
    const w = await world()
    await w.signIn()
    const again = await w.callback({ claims: { email: "ada@acme.test" } })
    expect(again.done.outcome).toBe("signed_in")
    expect(w.store.identities).toHaveLength(1)
  })
})

describe("what openid-client refuses", () => {
  it("an unknown state", async () => {
    const w = await world()
    const { done } = await w.callback({}, { state: "z".repeat(43) })
    expect(refusal(done)).toBe("attempt_unknown")
  })

  it("another browser, without ever spending the code", async () => {
    const w = await world()
    const redirectUrl = await w.start()
    const at = w.idp.authorize(redirectUrl)
    const stranger = await finishOidc(w.deps, w.engine, {
      via: "oidc",
      state: at.state,
      binding: OTHER_BROWSER,
      query: at.query,
    })
    expect(refusal(stranger)).toBe("wrong_browser")
    expect(w.idp.calls.token).toBe(0)
    // The real browser still finishes.
    const real = await finishOidc(w.deps, w.engine, {
      via: "oidc",
      state: at.state,
      binding: BINDING,
      query: at.query,
    })
    expect(real.outcome).toBe("signed_in")
  })

  it("a replayed callback", async () => {
    const w = await world()
    const { at } = await w.callback()
    const again = await finishOidc(w.deps, w.engine, {
      via: "oidc",
      state: at.state,
      binding: BINDING,
      query: at.query,
    })
    expect(refusal(again)).toBe("attempt_used")
  })

  const invalid: [string, TokenKnobs][] = [
    ["a nonce that is not the attempt's", { claims: { nonce: "n".repeat(43) } }],
    ["an ID token with no nonce", { omit: ["nonce"] }],
    ["a signature the IdP's JWKS does not vouch for", { rogueKey: true }],
    ["an ID token from another issuer", { claims: { iss: "https://evil.test" } }],
    ["an ID token for another client", { claims: { aud: "someone-else" } }],
    [
      "an expired ID token",
      {
        claims: {
          exp: Math.floor(Date.now() / 1000) - 3600,
          iat: Math.floor(Date.now() / 1000) - 7200,
        },
      },
    ],
    ["a foreign `iss` on the callback (RFC 9207)", { issParam: "https://evil.test" }],
  ]
  for (const [name, knobs] of invalid)
    it(name, async () => {
      const w = await world()
      const { done } = await w.callback(knobs)
      expect(refusal(done)).toBe("invalid_response")
      // Spent and audited, without the code or the state in the record.
      const event = w.store.events.at(-1)!
      expect(event).toMatchObject({
        type: "sign_in.failed",
        reason: "invalid_response",
      })
      expect(w.store.identities).toHaveLength(0)
    })

  it("a missing `iss` when the IdP says it sends one, and accepts it when it does not", async () => {
    const strict = await world({ issuer: { issSupported: true } })
    expect(refusal((await strict.callback({ issParam: null })).done)).toBe(
      "invalid_response",
    )
    const lax = await world()
    expect((await lax.callback({ issParam: null })).done.outcome).toBe("signed_in")
  })

  it("a code exchanged with the wrong PKCE verifier", async () => {
    const w = await world()
    const redirectUrl = await w.start()
    const at = w.idp.authorize(redirectUrl)
    const [attempt] = [...w.store.attempts.values()]
    attempt!.pkceVerifier = "v".repeat(43)
    const done = await finishOidc(w.deps, w.engine, {
      via: "oidc",
      state: at.state,
      binding: BINDING,
      query: at.query,
    })
    expect(refusal(done)).toBe("invalid_response")
    expect(w.store.events.at(-1)!.data).toMatchObject({ oauthError: "invalid_grant" })
  })

  it("a client secret the IdP does not accept", async () => {
    const w = await world({ secrets: { oidc: { clientSecret: "wrong-secret-value" } } })
    expect(refusal((await w.callback()).done)).toBe("invalid_response")
  })

  it("an IdP `error=` redirect, cleanly and audited", async () => {
    const w = await world()
    const { done } = await w.callback(
      {},
      { query: { code: null, error: "access_denied" } },
    )
    expect(refusal(done)).toBe("idp_error")
    expect(w.idp.calls.token).toBe(0)
    expect(w.store.events.at(-1)).toMatchObject({
      type: "sign_in.failed",
      reason: "idp_error",
      data: { error: "access_denied" },
    })
  })

  it("never writes the code, the state or the ID token into the audit log", async () => {
    const w = await world()
    const ok = await w.callback()
    const bad = await w.callback({ rogueKey: true })
    const log = JSON.stringify(w.store.events)
    for (const secret of [
      ok.at.query.code,
      ok.at.state,
      bad.at.query.code,
      bad.at.state,
    ])
      expect(log).not.toContain(secret)
    expect(log).not.toContain("eyJ")
  })
})

describe("step-up", () => {
  it("sends prompt=login and max_age=0, and makes the session fresh", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    const { done, at } = await w.callback(
      { claims: { auth_time: Math.floor(Date.now() / 1000) - 2 } },
      {},
      "step_up",
      { userId: "user_ada", sessionId },
    )
    expect(at.params.get("prompt")).toBe("login")
    expect(at.params.get("max_age")).toBe("0")
    expect(done.outcome).toBe("stepped_up")
  })

  it("refuses an IdP that answered from an old session", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    const { done } = await w.callback(
      { claims: { auth_time: Math.floor(Date.now() / 1000) - 600 } },
      {},
      "step_up",
      { userId: "user_ada", sessionId },
    )
    expect(refusal(done)).toBe("step_up_stale")
  })

  it("refuses an ID token with no auth_time at all", async () => {
    const w = await world()
    const { sessionId } = await w.signIn()
    const { done } = await w.callback({ omit: ["auth_time"] }, {}, "step_up", {
      userId: "user_ada",
      sessionId,
    })
    expect(refusal(done)).toBe("step_up_stale")
  })
})

describe("a forced login", () => {
  it("sends prompt=login and no max_age: any login will do, not a recent one", async () => {
    const w = await world()
    const p = new URL(await w.start("sign_in", undefined, "bob@acme.test", true))
      .searchParams
    expect(p.get("prompt")).toBe("login")
    expect(p.get("max_age")).toBeNull()
    expect(p.get("login_hint")).toBe("bob@acme.test")
  })
})

describe("MFA at the IdP", () => {
  const mfa = (mfaAcrValues: string[] = []) =>
    world({ connection: oidcConnection({ mfaRequired: true }, { mfaAcrValues }) })

  it("is refused on a password alone", async () => {
    const w = await mfa()
    expect(refusal((await w.callback({ claims: { amr: ["pwd"] } })).done)).toBe(
      "mfa_required",
    )
  })
  it("passes on `amr`", async () => {
    const w = await mfa()
    expect((await w.callback({ claims: { amr: ["pwd", "otp"] } })).done.outcome).toBe(
      "signed_in",
    )
  })
  it("passes on an `acr` the connection lists, and only that one", async () => {
    const w = await mfa(["urn:acme:mfa"])
    expect(
      (await w.callback({ claims: { amr: [], acr: "urn:acme:mfa" } })).done.outcome,
    ).toBe("signed_in")
    const other = await mfa(["urn:acme:mfa"])
    expect(
      refusal(
        (await other.callback({ claims: { amr: [], acr: "urn:acme:pwd" } })).done,
      ),
    ).toBe("mfa_required")
  })
  it("sends the connection's acr_values", async () => {
    const w = await world({
      connection: oidcConnection({}, { acrValues: ["urn:acme:mfa"] }),
    })
    expect(new URL(await w.start()).searchParams.get("acr_values")).toBe("urn:acme:mfa")
  })
})

describe("signing algorithms", () => {
  it("refuses an IdP that signs ID tokens only with none or the HS family", async () => {
    for (const algs of [["none"], ["HS256"], ["HS256", "none"]]) {
      const w = await world({
        issuer: { discovery: { id_token_signing_alg_values_supported: algs } },
      })
      await expect(w.start()).rejects.toThrow(/no algorithm we accept/)
    }
  })
})

describe("Google Workspace", () => {
  const google = (live = ["acme.test"]) =>
    world({
      connection: connection({ protocol: "oidc", provider: "google", config: {} }),
      issuer: {
        issuer: "https://accounts.google.com",
        clientId: "google-client.apps.googleusercontent.com",
      },
      google: true,
      live,
    })

  it("refuses an account with no `hd`: a consumer Gmail account", async () => {
    const w = await google()
    const { done } = await w.callback({ claims: { email: "ada@acme.test" } })
    expect(refusal(done)).toBe("hosted_domain")
    expect(w.store.events.at(-1)!.data).toMatchObject({ hd: null })
  })
  it("refuses an `hd` the workspace has not verified, whatever the address says", async () => {
    const w = await google()
    const { done } = await w.callback({
      claims: { hd: "other.test", email: "ada@acme.test" },
    })
    expect(refusal(done)).toBe("hosted_domain")
  })
  it("signs in on a matching `hd`, with `sub` as the identifier", async () => {
    const w = await google()
    const { done, redirectUrl } = await w.callback({
      claims: { hd: "acme.test", sub: "1098765432" },
    })
    expect(done.outcome).toBe("signed_in")
    expect(w.store.identities[0]).toMatchObject({ subject: "1098765432" })
    // A hint for the account chooser, checked again on the way back.
    expect(new URL(redirectUrl).searchParams.get("hd")).toBe("acme.test")
  })
  it("passes the typed address as a login hint, and none when there is not one", async () => {
    const w = await world()
    expect(
      new URL(await w.start("sign_in", undefined, "ada@acme.test")).searchParams.get(
        "login_hint",
      ),
    ).toBe("ada@acme.test")
    expect(new URL(await w.start()).searchParams.has("login_hint")).toBe(false)
  })
  it("sends Google to its own redirect URI, and refuses its callback anywhere else (mix-up)", async () => {
    const w = await google()
    const { done, redirectUrl } = await w.callback(
      { claims: { hd: "acme.test" } },
      { via: "oidc" },
    )
    expect(new URL(redirectUrl).searchParams.get("redirect_uri")).toBe(
      `${REDIRECT}/google`,
    )
    expect(refusal(done)).toBe("engine_mismatch")
    expect(w.idp.calls.token).toBe(0)
  })
  it("refuses a customer IdP's callback that arrives at the Google URL", async () => {
    const w = await world()
    const { done } = await w.callback({}, { via: "google" })
    expect(refusal(done)).toBe("engine_mismatch")
    expect(w.idp.calls.token).toBe(0)
  })
  it("never asks Google for prompt=login on a step-up, only max_age=0", async () => {
    const w = await google()
    await w.store.store.bindSession(TENANT, {
      sessionId: "sess_1",
      clerkUserId: "user_ada",
      connectionId: CONNECTION,
      identityId: null,
      idpSession: null,
      authTime: new Date(),
      at: new Date(),
      freshAt: new Date(),
    })
    const url = new URL(
      await w.start("step_up", { userId: "user_ada", sessionId: "sess_1" }),
    )
    expect(url.searchParams.get("prompt")).toBeNull()
    expect(url.searchParams.get("max_age")).toBe("0")
  })
  it("asks Google for its account chooser on a forced login, with no max_age", async () => {
    const w = await google()
    const p = new URL(await w.start("sign_in", undefined, undefined, true)).searchParams
    expect(p.get("prompt")).toBe("select_account")
    expect(p.get("max_age")).toBeNull()
  })
  it("is not ready, and has no settings, without our Google client", () => {
    const c = connection({ protocol: "oidc", provider: "google" })
    expect(oidcReady(c, false)).toBe(false)
    expect(settingsFor(c, null)).toBeNull()
    expect(oidcReady(c, true)).toBe(true)
  })
  it("reads an unset client authentication as the preset's first, so the connection is ready", () => {
    const c = connection({
      protocol: "oidc",
      provider: "ping",
      config: {
        oidc: { issuer: "https://idp.acme.test", clientId: "c", clientSecretSet: true },
      },
    })
    expect(settingsFor(c, null)?.clientAuth).toBe(OIDC_PRESETS.ping.clientAuth[0])
    expect(oidcReady(c, false)).toBe(true)
  })
})

describe("private_key_jwt", () => {
  for (const provider of ["generic", "okta"] as const)
    it(`authenticates with our signed assertion (${provider})`, async () => {
      const key = await newSigningKey()
      const c = oidcConnection(
        { provider },
        {
          clientAuth: "private_key_jwt",
          clientSecretSet: false,
          keys: [key.publicKey],
        },
      )
      const w = await world({
        connection: c,
        secrets: { oidc: { privateKeys: [key.privateKey] } },
        issuer: {
          clientJwks: () => publicJwks(c) as never,
          assertionAudience: OIDC_PRESETS[provider].assertionAudience,
        },
      })
      expect((await w.callback()).done.outcome).toBe("signed_in")
      const body = w.idp.seen.tokenBodies[0]!
      expect(body.get("client_assertion_type")).toBe(
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      )
      expect(body.get("client_secret")).toBeNull()
    })

  it("publishes only public keys", async () => {
    const key = await newSigningKey()
    const jwks = publicJwks(oidcConnection({}, { keys: [key.publicKey] }))
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).toMatchObject({
      kty: "RSA",
      kid: key.publicKey.kid,
      alg: "RS256",
    })
    expect(JSON.stringify(jwks)).not.toContain('"d"')
  })
})

describe("the egress guard and outages", () => {
  /** The real `vetHost`, with DNS answering what the attacker's zone says. */
  const resolvesTo = (address: string) => (host: string, signal: AbortSignal) =>
    vetHost(host, { lookup: async () => [{ address, family: 4 }], signal })

  it("refuses an issuer that resolves to a private address, before any request", async () => {
    const w = await world({ vet: resolvesTo("10.0.0.5") })
    const error = await w.engine
      .discover({ issuer: "https://idp.acme.test", discoveryUrl: null })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IdpUnreachable)
    expect((error as IdpUnreachable).kind).toBe("blocked")
    expect(w.idp.calls.discovery).toBe(0)
    // Starting a sign-in throws, which the route answers with 503.
    await expect(w.start()).rejects.toBeInstanceOf(IdpUnreachable)
    expect(w.store.attempts.size).toBe(0)
  })

  it("refuses the metadata service and loopback too", async () => {
    for (const address of ["169.254.169.254", "127.0.0.1", "::1"]) {
      const w = await world({ vet: resolvesTo(address) })
      await expect(
        w.engine.discover({ issuer: "https://idp.acme.test", discoveryUrl: null }),
      ).rejects.toBeInstanceOf(IdpUnreachable)
    }
  })

  it("refuses plain http and does not follow redirects", async () => {
    const fetchGuarded = guardedFetch({
      vet: async () => PUBLIC,
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.1/" },
        })) as never,
    })
    await expect(
      fetchGuarded("http://idp.acme.test/x", { method: "GET", headers: {} }),
    ).rejects.toBeInstanceOf(IdpUnreachable)
    const redirected = await fetchGuarded("https://idp.acme.test/x", {
      method: "GET",
      headers: {},
    })
    expect(redirected.status).toBe(302)
  })

  it("refuses a response bigger than the cap", async () => {
    const fetchGuarded = guardedFetch({
      vet: async () => PUBLIC,
      maxBytes: 10,
      fetch: (async () => new Response("x".repeat(100))) as never,
    })
    await expect(
      fetchGuarded("https://idp.acme.test/x", { method: "GET", headers: {} }),
    ).rejects.toMatchObject({ kind: "too_large" })
  })

  it("pins the connection to the vetted address and keeps the name for Host and TLS", async () => {
    let seen: {
      url: string
      init: RequestInit & { tls?: { serverName?: string } }
    } | null = null
    const fetchGuarded = guardedFetch({
      vet: async () => PUBLIC,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response("{}")
      }) as never,
    })
    await fetchGuarded("https://idp.acme.test/.well-known/openid-configuration", {
      method: "GET",
      headers: {},
    })
    expect(seen!.url).toBe("https://93.184.216.34/.well-known/openid-configuration")
    expect((seen!.init.headers as Record<string, string>).host).toBe("idp.acme.test")
    expect(seen!.init.tls?.serverName).toBe("idp.acme.test")
    expect(seen!.init.redirect).toBe("manual")
  })

  it("refuses discovery naming a different issuer", async () => {
    const w = await world({ issuer: { discovery: { issuer: "https://evil.test" } } })
    await expect(w.start()).rejects.toThrow(/different issuer/)
  })

  it("refuses an IdP that does not offer PKCE S256", async () => {
    const w = await world({
      issuer: { discovery: { code_challenge_methods_supported: ["plain"] } },
    })
    await expect(w.start()).rejects.toThrow(/S256/)
  })

  it("answers an IdP outage at the token endpoint as unavailable, without spending the attempt", async () => {
    const w = await world()
    const redirectUrl = await w.start()
    const at = w.idp.authorize(redirectUrl)
    w.idp.fail.token = 503
    const done = await finishOidc(w.deps, w.engine, {
      via: "oidc",
      state: at.state,
      binding: BINDING,
      query: at.query,
    })
    expect(done.outcome).toBe("unavailable")
    const [attempt] = [...w.store.attempts.values()]
    expect(attempt!.consumedAt).toBeNull()
    expect(w.store.events.at(-1)).toMatchObject({ type: "sign_in.idp_unavailable" })
  })

  it("caches discovery between a start and its callback", async () => {
    const w = await world()
    await w.callback()
    await w.callback()
    expect(w.idp.calls.discovery).toBe(1)
    expect(w.idp.calls.jwks).toBe(1)
  })
})

describe("POST /sso/oidc/callback", () => {
  async function route(oidc = true) {
    const w = await world()
    const app = createSsoRoutes({
      bridge: w.deps,
      gate: { forget: () => {} },
      identify: async () => ({ status: "signed-out" }),
      returnOrigins: ["https://dash.i10.localhost"],
      testEngine: false,
      ...(oidc ? { oidc: w.engine } : {}),
      mayManage: async () => false,
      tenantOfConnection: async () => TENANT,
    } as unknown as SsoRouteDeps)
    const post = (body: unknown) =>
      app.request("/oidc/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    return { w, post }
  }

  it("answers a verified sign-in with the handoff code", async () => {
    const { w, post } = await route()
    const at = w.idp.authorize(await w.start())
    const res = await post({ state: at.state, binding: BINDING, query: at.query })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      outcome: "signed_in",
      returnTo: "https://dash.i10.localhost/",
    })
  })
  it("answers a sign-in as somebody other than the typed address with both, and the connection", async () => {
    const { w, post } = await route()
    const at = w.idp.authorize(await w.start("sign_in", undefined, "bob@acme.test"))
    const res = await post({ state: at.state, binding: BINDING, query: at.query })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      outcome: "signed_in",
      confirmAs: "ada@acme.test",
      typed: "bob@acme.test",
      connectionId: CONNECTION,
    })
  })
  it("answers a refusal with 409 and a reason, an outage with 503", async () => {
    const { w, post } = await route()
    const at = w.idp.authorize(await w.start(), { rogueKey: true })
    const res = await post({ state: at.state, binding: BINDING, query: at.query })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "invalid_response" })
    const again = w.idp.authorize(await w.start())
    w.idp.fail.token = 502
    const down = await post({
      state: again.state,
      binding: BINDING,
      query: again.query,
    })
    expect(down.status).toBe(503)
  })
  it("refuses a malformed body, and does not exist without the engine", async () => {
    const { post } = await route()
    expect(
      (await post({ state: "x", binding: BINDING, query: { code: "c" } })).status,
    ).toBe(422)
    expect(
      (await post({ state: "s".repeat(43), binding: BINDING, query: {} })).status,
    ).toBe(422)
    const off = await route(false)
    expect(
      (
        await off.post({
          state: "s".repeat(43),
          binding: BINDING,
          query: { code: "c" },
        })
      ).status,
    ).toBe(404)
  })
})

describe("claims", () => {
  const settings = { provider: OIDC_PRESETS.generic, mfaAcrValues: [] }
  it("follows the attribute mapping, but never for the subject", () => {
    const a = toAssertion(
      {
        iss: "x",
        aud: "y",
        iat: 0,
        exp: 0,
        sub: "s1",
        mail: "a@acme.test",
        email: "b@acme.test",
        email_verified: true,
        roles: ["eng"],
      } as never,
      { attributeMapping: { mail: "email", roles: "groups", sub2: "subject" } },
      settings,
    )
    expect(a).toMatchObject({ subject: "s1", email: "a@acme.test", groups: ["eng"] })
  })
  it("reads Entra's verification from `xms_edov`, and nothing else", () => {
    const entra = { provider: OIDC_PRESETS.entra, mfaAcrValues: [] }
    const base = { iss: "x", aud: "y", iat: 0, exp: 0, sub: "s1", email: "a@acme.test" }
    expect(
      toAssertion(
        { ...base, email_verified: true } as never,
        { attributeMapping: {} },
        entra,
      )!.emailVerified,
    ).toBe(false)
    expect(
      toAssertion(
        { ...base, xms_edov: true } as never,
        { attributeMapping: {} },
        entra,
      )!.emailVerified,
    ).toBe(true)
  })
  it("treats a missing email_verified as not verified", () => {
    const a = toAssertion(
      { iss: "x", aud: "y", iat: 0, exp: 0, sub: "s1", email: "a@acme.test" } as never,
      { attributeMapping: {} },
      settings,
    )
    expect(a!.emailVerified).toBe(false)
  })
  it("reads the callback query, and keeps only a well-formed IdP error code", () => {
    expect(readCallbackQuery({ code: "abc", iss: "https://i" })).toEqual({
      code: "abc",
      iss: "https://i",
      error: null,
    })
    expect(readCallbackQuery({ error: "<script>" })).toEqual({
      code: null,
      iss: null,
      error: "invalid",
    })
    expect(readCallbackQuery({})).toBeNull()
    expect(readCallbackQuery("x")).toBeNull()
  })
})

describe("the Google client in the environment", () => {
  const base = {
    DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
    REDIS_URL: "redis://localhost:6379",
    CLERK_WEBHOOK_SECRET: "whsec_test",
    CLERK_SECRET_KEY: "sk_test_abc",
    MAIL_DOMAINS: "i10.tech",
    SES_CONFIGURATION_SET: "i10-events",
  }
  it("is both or neither", () => {
    expect(loadEnv(base).GOOGLE_SSO_CLIENT_ID).toBeUndefined()
    expect(() =>
      loadEnv({ ...base, GOOGLE_SSO_CLIENT_ID: "123-abc.apps.googleusercontent.com" }),
    ).toThrow(/GOOGLE_SSO_CLIENT_SECRET/)
    expect(
      loadEnv({
        ...base,
        GOOGLE_SSO_CLIENT_ID: "123-abc.apps.googleusercontent.com",
        GOOGLE_SSO_CLIENT_SECRET: "GOCSPX-secret",
      }).GOOGLE_SSO_CLIENT_ID,
    ).toBe("123-abc.apps.googleusercontent.com")
  })
})
