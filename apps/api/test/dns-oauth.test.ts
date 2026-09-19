import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { dnsOAuth, OAuthError } from "../src/dns/oauth.js"

/**
 * Connecting a customer's DNS provider.
 *
 * ⚠ TWO THINGS DEFEND THIS FLOW AND NEITHER WAS TESTED. `state` is the entire
 * CSRF defence: the callback arrives as a plain browser navigation with no
 * session of ours, so an unauthenticated state lets anybody craft a callback
 * that attaches THEIR DNS credential to SOMEBODY ELSE'S workspace — the
 * standard OAuth account-linking attack, whose payoff here is a stranger
 * holding a connection that writes records into a zone they do not own.
 *
 * ⚠ AND PKCE IS THE OTHER HALF, because the authorization code travels through
 * a browser we do not control. Anything that can read the redirect holds a code
 * exchangeable for that same credential. The verifier binds the code to this
 * server — and only if it never travels beside it, which is the property the
 * tests below are really guarding.
 */

const NOW = 1_800_000_000_000
const SECRET = "state-signing-key-for-tests-only"

const oauth = (over: Partial<Parameters<typeof dnsOAuth>[0]> = {}) =>
  dnsOAuth({
    apps: { cloudflare: { clientId: "cid-123", clientSecret: "csec-456" } },
    redirectBase: "https://dash.i10.tech/dns/callback",
    stateSecret: SECRET,
    now: () => NOW,
    ...over,
  })

const start = (o = oauth()) => o.start({ slug: "cloudflare", tenantId: "tenant-1" })

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

describe("starting an authorisation", () => {
  it("refuses a provider with no app configured, as our fault not theirs", () => {
    const o = oauth({ apps: {} })
    expect(() => start(o)).toThrow(OAuthError)
    try {
      start(o)
    } catch (error) {
      expect((error as OAuthError).kind).toBe("unconfigured")
      // ⚠ NOT "try again later" — an unregistered app never clears on its own.
      expect((error as OAuthError).message).toContain(
        "not configured on this deployment",
      )
    }
  })

  it("refuses a provider the registry has no OAuth for", () => {
    expect(() => oauth().start({ slug: "not-a-provider", tenantId: "t" })).toThrow(
      OAuthError,
    )
  })

  it("builds the authorize URL the provider expects", () => {
    const url = new URL(start().url)
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("cid-123")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://dash.i10.tech/dns/callback/cloudflare",
    )
    expect(url.searchParams.get("scope")).toBe("dns_records:edit zone:read")
  })

  /**
   * ⚠ SENT FOR EVERY PROVIDER, NOT ONLY THE ONES THAT DEMAND IT. A server that
   * does not implement PKCE ignores both parameters; one that does binds the
   * code to us. A per-provider flag would be a flag nobody updates, and the
   * provider that quietly starts requiring it breaks on a Tuesday.
   */
  it("always sends an S256 challenge", () => {
    const url = new URL(start().url)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("gives two authorisations different states and different challenges", () => {
    const a = start()
    const b = start()
    expect(a.state).not.toBe(b.state)
    expect(new URL(a.url).searchParams.get("code_challenge")).not.toBe(
      new URL(b.url).searchParams.get("code_challenge"),
    )
  })
})

describe("the PKCE verifier", () => {
  /**
   * ⚠ THE ASSERTION THIS WHOLE MECHANISM EXISTS FOR. `state` is signed but NOT
   * secret — its payload is base64url and readable by anyone holding the URL —
   * so a verifier carried inside it would sit beside the very code it is meant
   * to protect, and protect nothing.
   */
  it("never appears in the state that travels through the browser", () => {
    const o = oauth()
    const { state } = start(o)
    const { verifier } = o.verifyState(state)

    expect(state).not.toContain(verifier)
    const [encoded] = state.split(".")
    expect(Buffer.from(encoded!, "base64url").toString()).not.toContain(verifier)
  })

  it("is the preimage of the challenge that was sent", () => {
    const o = oauth()
    const { url, state } = start(o)
    const { verifier } = o.verifyState(state)

    expect(new URL(url).searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    )
  })

  /** ⚠ DERIVED FROM THE SIGNING SECRET, so holding the state is not enough. */
  it("cannot be recomputed without the signing secret", () => {
    const { state } = start()
    const impostor = oauth({ stateSecret: "a-different-key-entirely" })
    expect(() => impostor.verifyState(state)).toThrow(OAuthError)
  })

  it("is a valid RFC 7636 verifier", () => {
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
  })
})

describe("verifying the state on the way back", () => {
  it("round-trips the workspace and the provider", () => {
    const o = oauth()
    expect(o.verifyState(start(o).state)).toMatchObject({
      slug: "cloudflare",
      tenantId: "tenant-1",
    })
  })

  /**
   * ⚠ THE ACCOUNT-LINKING ATTACK, and the reason `state` is signed rather than
   * random. A forged state naming another workspace must not verify.
   */
  it("rejects a payload edited to name another workspace", () => {
    const { state } = start()
    const [encoded, signature] = state.split(".")
    const payload = Buffer.from(encoded!, "base64url").toString()
    const forged = payload.replace("tenant-1", "tenant-2")
    const attack = `${Buffer.from(forged).toString("base64url")}.${signature}`

    expect(() => oauth().verifyState(attack)).toThrow(OAuthError)
  })

  /**
   * ⚠ A SIGNATURE OF THE WRONG LENGTH MUST REFUSE, NOT CRASH. `timingSafeEqual`
   * THROWS on a length mismatch rather than returning false, so comparing
   * without the length check turns a forged state into a 500 — and a 500 where
   * a 422 belongs is itself an oracle.
   */
  it("refuses a short signature instead of throwing", () => {
    const { state } = start()
    const [encoded] = state.split(".")
    try {
      oauth().verifyState(`${encoded}.tooshort`)
      throw new Error("should have refused")
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthError)
      expect((error as OAuthError).kind).toBe("bad_state")
    }
  })

  it("refuses something that is not a state at all", () => {
    for (const bad of ["", "nodot", ".", "a.b.c"]) {
      expect(() => oauth().verifyState(bad)).toThrow(OAuthError)
    }
  })

  /** ⚠ A SIGNED STATE WITH NO DEADLINE IS A BEARER TOKEN THAT WORKS FOR EVER. */
  it("refuses one that took longer than ten minutes", () => {
    const { state } = start()
    const later = oauth({ now: () => NOW + 11 * 60 * 1000 })
    expect(() => later.verifyState(state)).toThrow(/took too long/)
  })

  it("still accepts one inside the window", () => {
    const { state } = start()
    const later = oauth({ now: () => NOW + 9 * 60 * 1000 })
    expect(later.verifyState(state).tenantId).toBe("tenant-1")
  })
})

describe("exchanging the code", () => {
  const capture = (body: unknown, status = 200) => {
    const sent: URLSearchParams[] = []
    globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
      sent.push(new URLSearchParams(String(init.body)))
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    return sent
  }

  it("sends the verifier, without which the exchange is refused", async () => {
    const sent = capture({ access_token: "at", expires_in: 3600, scope: "zone:read" })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    const grant = await o.exchange({ slug: "cloudflare", code: "the-code", verifier })

    expect(sent[0]?.get("code_verifier")).toBe(verifier)
    expect(sent[0]?.get("grant_type")).toBe("authorization_code")
    expect(sent[0]?.get("redirect_uri")).toBe(
      "https://dash.i10.tech/dns/callback/cloudflare",
    )
    expect(grant).toEqual({
      accessToken: "at",
      expiresAt: NOW + 3_600_000,
      scopes: "zone:read",
    })
  })

  /**
   * ⚠ OMITTED ENTIRELY FOR A PUBLIC CLIENT, NOT SENT EMPTY. An empty
   * `client_secret` is a supplied-and-wrong secret, answered `invalid_client` —
   * indistinguishable in a log from a real secret that has been rotated.
   */
  it("omits the client secret for a public client", async () => {
    const sent = capture({ access_token: "at" })
    const o = oauth({ apps: { cloudflare: { clientId: "cid-123" } } })
    const { verifier } = o.verifyState(start(o).state)

    await o.exchange({ slug: "cloudflare", code: "c", verifier })

    expect(sent[0]?.has("client_secret")).toBe(false)
    expect(sent[0]?.get("client_id")).toBe("cid-123")
    expect(sent[0]?.get("code_verifier")).toBe(verifier)
  })

  it("sends it for a confidential client", async () => {
    const sent = capture({ access_token: "at" })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await o.exchange({ slug: "cloudflare", code: "c", verifier })
    expect(sent[0]?.get("client_secret")).toBe("csec-456")
  })

  it("keeps a refresh token when one is granted", async () => {
    capture({ access_token: "at", refresh_token: "rt" })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    const grant = await o.exchange({ slug: "cloudflare", code: "c", verifier })
    expect(grant.refreshToken).toBe("rt")
  })

  it("carries the provider's own reason when it refuses", async () => {
    capture({ error: "invalid_grant", error_description: "code already used" }, 400)
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({ kind: "exchange_failed", detail: "code already used" })
  })

  /** ⚠ A 200 WITH NO `access_token` IS STILL A FAILURE, and providers send them. */
  it("treats a 200 with no token as a failure", async () => {
    capture({ token_type: "bearer" })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toBeInstanceOf(OAuthError)
  })

  it("reports an unreachable token endpoint as such", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ETIMEDOUT")
    }) as unknown as typeof fetch
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({ kind: "exchange_failed" })
  })
})
