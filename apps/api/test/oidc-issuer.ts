import { createHash, randomBytes } from "node:crypto"
import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JWK,
} from "jose"

/**
 * A minimal OpenID Provider that runs in the test process (#338): discovery,
 * JWKS, an "authorize" step the test drives as the browser would, and a token
 * endpoint that checks the code, the PKCE verifier, the redirect URI and the
 * client's authentication, then signs an ID token with `jose`.
 *
 * It is reached only through `fetch`, which the engine's egress guard calls
 * with the vetted address in the URL and the issuer's name in `Host`, so the
 * guard and the pin run for real; no socket is opened.
 *
 * Every way an ID token can be wrong is a knob on `authorize`.
 */

export interface TokenKnobs {
  /** Claims to add or override (`sub`, `email`, `hd`, `amr`, `acr`...). */
  claims?: Record<string, unknown>
  /** Claims to leave out of the ID token. */
  omit?: string[]
  /** Sign with a key the JWKS does not publish. */
  rogueKey?: boolean
  /** The callback's `iss` parameter: the issuer by default, null for none. */
  issParam?: string | null
}

export interface IssuerOptions {
  issuer?: string
  clientId?: string
  clientSecret?: string
  /** `authorization_response_iss_parameter_supported` in discovery. */
  issSupported?: boolean
  /** Extra or overriding discovery fields. */
  discovery?: Record<string, unknown>
  /** For private_key_jwt: our published keys, and the `aud` the IdP wants. */
  clientJwks?: () => { keys: JWK[] }
  assertionAudience?: "issuer" | "token_endpoint"
}

export async function testIssuer(options: IssuerOptions = {}) {
  const issuer = options.issuer ?? "https://idp.acme.test"
  const origin = new URL(issuer).origin
  const host = new URL(issuer).host
  const clientId = options.clientId ?? "client-acme"
  const clientSecret = options.clientSecret ?? "s3cret-value-for-tests"
  const signing = await generateKeyPair("RS256")
  const rogue = await generateKeyPair("RS256")
  const kid = "idp-key-1"
  const publicJwk = {
    ...(await exportJWK(signing.publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
  }

  const issued = new Map<
    string,
    {
      redirectUri: string
      challenge: string
      nonce: string
      knobs: TokenKnobs
      used: boolean
    }
  >()
  const calls = { discovery: 0, jwks: 0, token: 0 }
  const fail = {
    token: null as number | null,
    discovery: null as number | null,
    jwks: null as number | null,
  }
  const seen: { authorize: URLSearchParams[]; tokenBodies: URLSearchParams[] } = {
    authorize: [],
    tokenBodies: [],
  }

  const discovery = () => ({
    issuer,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    jwks_uri: `${origin}/jwks`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
    ],
    ...(options.issSupported
      ? { authorization_response_iss_parameter_supported: true }
      : {}),
    ...options.discovery,
  })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })

  async function clientAuthenticated(
    req: Headers,
    body: URLSearchParams,
  ): Promise<boolean> {
    const basic = req.get("authorization")
    if (basic?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(basic.slice(6), "base64")
        .toString("utf8")
        .split(":")
        .map(decodeURIComponent)
      return id === clientId && secret === clientSecret
    }
    if (body.get("client_secret") !== null)
      return (
        body.get("client_id") === clientId && body.get("client_secret") === clientSecret
      )
    const assertion = body.get("client_assertion")
    if (assertion && options.clientJwks) {
      try {
        const { payload } = await jwtVerify(
          assertion,
          createLocalJWKSet(options.clientJwks()),
          {
            issuer: clientId,
            subject: clientId,
            audience:
              options.assertionAudience === "token_endpoint"
                ? `${origin}/token`
                : issuer,
          },
        )
        return Boolean(payload.jti)
      } catch {
        return false
      }
    }
    return false
  }

  /** The fetch the guard is given. It only answers requests for the issuer's host. */
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString())
    const headers = new Headers(init?.headers)
    if (headers.get("host") !== host)
      throw new Error(`no route to ${headers.get("host")}`)
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      calls.discovery += 1
      if (fail.discovery) return json({}, fail.discovery)
      return json(discovery())
    }
    if (url.pathname === "/jwks") {
      calls.jwks += 1
      if (fail.jwks) return json({}, fail.jwks)
      return json({ keys: [publicJwk] })
    }
    if (url.pathname === "/token" && init?.method === "POST") {
      calls.token += 1
      if (fail.token) return json({ error: "temporarily_unavailable" }, fail.token)
      const body = new URLSearchParams(String(init.body))
      seen.tokenBodies.push(body)
      if (!(await clientAuthenticated(headers, body)))
        return json({ error: "invalid_client" }, 401)
      const grant = issued.get(body.get("code") ?? "")
      if (!grant || grant.used) return json({ error: "invalid_grant" }, 400)
      grant.used = true
      const verifier = body.get("code_verifier") ?? ""
      const challenge = createHash("sha256").update(verifier).digest("base64url")
      if (
        challenge !== grant.challenge ||
        body.get("redirect_uri") !== grant.redirectUri
      )
        return json({ error: "invalid_grant" }, 400)
      const now = Math.floor(Date.now() / 1000)
      const claims: Record<string, unknown> = {
        iss: issuer,
        aud: clientId,
        sub: "idp|ada",
        email: "ada@acme.test",
        email_verified: true,
        given_name: "Ada",
        family_name: "Lovelace",
        nonce: grant.nonce,
        iat: now,
        exp: now + 300,
        auth_time: now - 5,
        amr: ["pwd"],
        sid: "idp-session-1",
        ...grant.knobs.claims,
      }
      for (const name of grant.knobs.omit ?? []) delete claims[name]
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .sign(grant.knobs.rogueKey ? rogue.privateKey : signing.privateKey)
      return json({
        access_token: randomBytes(16).toString("hex"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken,
      })
    }
    return json({ error: "not_found" }, 404)
  }) as typeof globalThis.fetch

  /**
   * The browser at the IdP: reads the authorization URL the engine built,
   * "signs the person in", and returns the query the IdP redirects back with.
   */
  function authorize(redirectUrl: string, knobs: TokenKnobs = {}) {
    const url = new URL(redirectUrl)
    seen.authorize.push(url.searchParams)
    const p = url.searchParams
    const code = randomBytes(24).toString("base64url")
    issued.set(code, {
      redirectUri: p.get("redirect_uri") ?? "",
      challenge: p.get("code_challenge") ?? "",
      nonce: p.get("nonce") ?? "",
      knobs,
      used: false,
    })
    const iss = knobs.issParam === undefined ? issuer : knobs.issParam
    return {
      state: p.get("state") ?? "",
      query: { code, iss, error: null as string | null },
      params: p,
    }
  }

  /**
   * A Back-Channel Logout token (#345) as the IdP would send it, with every
   * way it can be wrong a knob: claims to change or leave out, a key the
   * JWKS does not publish, or another algorithm (`HS256` with the client
   * secret, `none`).
   */
  async function logoutToken(
    claims: Record<string, unknown> = {},
    knobs: {
      omit?: string[]
      rogueKey?: boolean
      alg?: "RS256" | "HS256" | "none"
      kid?: string
    } = {},
  ) {
    const now = Math.floor(Date.now() / 1000)
    const payload: Record<string, unknown> = {
      iss: issuer,
      aud: clientId,
      iat: now,
      exp: now + 120,
      jti: randomBytes(12).toString("hex"),
      sub: "idp|ada",
      sid: "idp-session-1",
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
      ...claims,
    }
    for (const name of knobs.omit ?? []) delete payload[name]
    if (knobs.alg === "none") return new UnsecuredJWT(payload).encode()
    if (knobs.alg === "HS256")
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", kid })
        .sign(new TextEncoder().encode(clientSecret))
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: knobs.kid ?? kid })
      .sign(knobs.rogueKey ? rogue.privateKey : signing.privateKey)
  }

  return {
    issuer,
    clientId,
    clientSecret,
    fetch,
    authorize,
    logoutToken,
    calls,
    fail,
    seen,
  }
}
