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
    expect(url.searchParams.get("scope")).toBe("dns.write zone.read offline_access")
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

  /**
   * ⚠ A SCOPE NAME IS A FACT ABOUT SOMEBODY ELSE'S PRODUCT, AND OURS CAN BE
   * WRONG. The registry's list is our reading of each provider's docs at the
   * time it was written; providers rename scopes and publish names that differ
   * from the strings their authorize endpoint accepts. Correcting one is a
   * Doppler edit, which is only true if the configured list actually wins.
   */
  it("prefers the configured scopes over the registry's", () => {
    const o = oauth({
      apps: {
        cloudflare: {
          clientId: "cid-123",
          clientSecret: "csec-456",
          scopes: ["dns.write", "zone.read"],
        },
      },
    })

    expect(new URL(start(o).url).searchParams.get("scope")).toBe("dns.write zone.read")
  })

  /**
   * ⚠ WHOLESALE, NOT MERGED. A merge would mean a deployment could only ever
   * ADD to whatever the registry says — so a registry entry that is simply
   * wrong could never be corrected, which is the whole case for the override.
   */
  it("does not merge the configured scopes with the registry's", () => {
    const o = oauth({
      apps: { cloudflare: { clientId: "cid-123", scopes: ["dns.write"] } },
    })
    const scope = new URL(start(o).url).searchParams.get("scope")

    expect(scope).toBe("dns.write")
    expect(scope).not.toContain("zone.read")
  })

  /**
   * ⚠ THE REGISTRY'S DEFAULTS ARE THE REAL CLOUDFLARE SCOPES, read off a live
   * client's edit page rather than inferred from the docs — they were
   * `dns_records:edit` and `zone:read`, which is API TOKEN syntax and is what
   * every integration guide repeats. `offline_access` is what makes the
   * connection outlive its first access token.
   */
  it("falls back to the registry when none are configured", () => {
    expect(new URL(start().url).searchParams.get("scope")).toBe(
      "dns.write zone.read offline_access",
    )
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

  /**
   * ⚠ WHAT A BOT FILTER ANSWERS WITH, AND THE CASE THE OLD `detail` COULD NOT
   * DESCRIBE. `dash.cloudflare.com` is a dashboard host behind Cloudflare's own
   * bot management, so a refused token exchange comes back as an HTML
   * challenge page rather than an OAuth error — and the body was being parsed
   * as JSON, discarded on failure, and reported as the bare status. "HTTP 403"
   * reads identically whether the client secret is wrong or the cluster's
   * egress is being challenged, and those have nothing in common.
   */
  const captureText = (
    text: string,
    status: number,
    headers: Record<string, string> = {},
  ) => {
    globalThis.fetch = (async () =>
      new Response(text, {
        status,
        headers: { "content-type": "text/html", ...headers },
      })) as unknown as typeof fetch
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

  /*
   * ⚠ THE STATUS LEADS, AND IT IS NOT DECORATION. `invalid_grant` alone does
   * not say whether the provider answered at all — a 400 they sent on purpose
   * and a 502 from something standing in front of them are different problems
   * with the same word attached.
   */
  it("carries the provider's own reason when it refuses", async () => {
    capture({ error: "invalid_grant", error_description: "code already used" }, 400)
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({
      kind: "exchange_failed",
      detail: "HTTP 400 · code already used",
    })
  })

  it("quotes a body that is not JSON at all", async () => {
    captureText(
      "<html><head><title>Attention Required</title></head><body>" +
        "<h1>Sorry, you have been blocked</h1>error code: 1010</body></html>",
      403,
    )
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    /*
     * ⚠ THE TAGS COME OUT AND THE SENTENCE STAYS. An administrator reading
     * "error code: 1010" can look it up; one reading "HTTP 403" cannot, and
     * that is the difference between a Doppler edit and a week.
     */
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({
      detail:
        "HTTP 403 · Attention Required Sorry, you have been blocked error code: 1010",
    })
  })

  /**
   * ⚠ THE FAILURE THIS WHOLE BLOCK EXISTS FOR, AND CLOUDFLARE'S OWN CLIENT
   * CHECKS FOR THE SAME THING. `wrangler` matches `<!DOCTYPE html>` and then
   * `challenge-platform` on this exact endpoint and tells you to quote the ray
   * id to support. It is not a credential problem, it is not the customer's
   * problem, and pressing the button again will not clear it — three things
   * "Cloudflare did not complete the authorisation" says none of.
   */
  it("names a bot challenge as a bot challenge", async () => {
    captureText(
      '<!DOCTYPE html><html><head><script src="/cdn-cgi/challenge-platform/h/b/orchestrate">' +
        "</script></head><body>Just a moment…</body></html>",
      403,
      { "cf-ray": "9a1b2c3d4e5f6789-LHR" },
    )
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    const detail = await o
      .exchange({ slug: "cloudflare", code: "c", verifier })
      .then(() => null)
      .catch((error: { detail?: string }) => error.detail ?? null)

    expect(detail).toContain("challenged the request")
    expect(detail).toContain("cf-ray 9a1b2c3d4e5f6789-LHR")
    // ⚠ AND IT SAYS WHOSE PROBLEM IT IS, because the customer authorised
    // correctly and the sentence they used to get blamed them for it.
    expect(detail).toContain("not about your authorisation")
  })

  /**
   * ⚠ A FIREWALL RULE IS NOT A BOT SCORE, AND CALLING IT ONE SENDS SOMEBODY TO
   * ARGUE THE WRONG CASE. `error code: 1020` is a WAF rule that matched; a
   * challenge is bot management scoring the caller. They are cleared by
   * different people in different places, and the old classifier reported both
   * with the same sentence because `Attention Required` — the title of the
   * BLOCK page — was one of its challenge markers.
   */
  it("calls a firewall block a firewall block, not a challenge", async () => {
    captureText(
      "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>" +
        "</head><body>Sorry, you have been blocked. error code: 1020</body></html>",
      403,
      { "cf-ray": "9a1b2c3d4e5f6789-CDG" },
    )
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    const detail = await o
      .exchange({ slug: "cloudflare", code: "c", verifier })
      .then(() => null)
      .catch((error: { detail?: string }) => error.detail ?? null)

    expect(detail).toContain("error 1020")
    expect(detail).not.toContain("challenged the request")
    expect(detail).toContain("cf-ray 9a1b2c3d4e5f6789-CDG")
  })

  /**
   * ⚠ THE CLASSIFIER WAS EATING THE ONLY EVIDENCE THERE IS. `detail` quotes
   * the body only when it does NOT recognise it, so in the one case worth
   * diagnosing the page was read, matched against three substrings, reduced to
   * a sentence and dropped — and two rounds were then spent reasoning about a
   * response nobody had seen. `evidence` is the page, for the log only.
   */
  it("keeps the page Cloudflare actually served, with the headers that classify it", async () => {
    captureText("<!DOCTYPE html><html><body>Just a moment…</body></html>", 403, {
      "cf-ray": "9a1b2c3d4e5f6789-CDG",
      "cf-mitigated": "challenge",
    })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    const evidence = await o
      .exchange({ slug: "cloudflare", code: "c", verifier })
      .then(() => null)
      .catch((error: { evidence?: string }) => error.evidence ?? null)

    expect(evidence).toContain("cf-mitigated: challenge")
    expect(evidence).toContain("cf-ray: 9a1b2c3d4e5f6789-CDG")
    expect(evidence).toContain("Just a moment")
  })

  /*
   * ⚠ AND NEVER FOR A BODY THAT PARSED, WHICH IS WHAT KEEPS IT SAFE TO LOG. A
   * token endpoint's JSON is the one thing in this exchange that can carry a
   * credential; an HTML page from a proxy cannot.
   */
  it("keeps no evidence when the provider answered in JSON", async () => {
    capture({ error: "invalid_grant", error_description: "code already used" }, 400)
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    const error = await o
      .exchange({ slug: "cloudflare", code: "c", verifier })
      .then(() => null)
      .catch((e: { evidence?: string }) => e)

    expect(error?.evidence).toBeUndefined()
  })

  /**
   * ⚠ A CHALLENGE WITHOUT THE TELL-TALE BODY IS STILL A CHALLENGE. Cloudflare
   * sets `cf-mitigated` on a challenged response, and it is the unambiguous
   * signal where the markup is not.
   */
  it("trusts cf-mitigated over the markup", async () => {
    captureText("<!DOCTYPE html><html><body>Sorry.</body></html>", 403, {
      "cf-mitigated": "challenge",
    })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({
      detail: expect.stringContaining("challenged the request"),
    })
  })

  /**
   * ⚠ THE RAY ID IS THE ONLY THING CLOUDFLARE SUPPORT WILL ASK FOR. It names
   * the exact request in their logs, including the rule that stopped it —
   * which is the one fact nobody on this side of the connection can discover.
   */
  it("keeps the Cloudflare ray id when there is one", async () => {
    captureText("blocked", 403, { "cf-ray": "9a1b2c3d4e5f6789-LHR" })
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({
      detail: "HTTP 403 · blocked · cf-ray 9a1b2c3d4e5f6789-LHR",
    })
  })

  /**
   * ⚠ A GENERIC RUNTIME USER AGENT FROM A DATACENTRE IP IS WHAT BOT MANAGEMENT
   * IS LOOKING FOR. Bun sends `Bun/1.4.2` when none is given — measured
   * against `cloudflare.com/cdn-cgi/trace`. See dns/user-agent.ts.
   *
   * ⚠ AND IT MUST NOT LOOK LIKE A CRAWLER EITHER, which is the assertion on
   * the second line. `name/version (+url)` is how Googlebot and every other
   * crawler declares itself; volunteering that to a host that scores user
   * agents was worse than saying nothing. See dns/user-agent.ts.
   */
  it("identifies itself rather than sending the runtime's default", async () => {
    const seen: (string | null)[] = []
    globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers).get("user-agent"))
      return new Response(JSON.stringify({ access_token: "at" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)
    await o.exchange({ slug: "cloudflare", code: "c", verifier })

    expect(seen).toEqual(["i10/1.0"])
    expect(seen[0]).not.toContain("(+")
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

  /**
   * ⚠ A REFRESH CARRIES NO CODE, SO IT CARRIES NO VERIFIER. PKCE binds the
   * AUTHORIZATION CODE to this server; sending `code_verifier` or `redirect_uri`
   * on a refresh is rejected outright by strict implementations.
   */
  it("trades a refresh token without PKCE or a redirect", async () => {
    const sent = capture({ access_token: "newer", expires_in: 3600 })
    const o = oauth()

    const grant = await o.refresh({ slug: "cloudflare", refreshToken: "rt-1" })

    expect(sent[0]?.get("grant_type")).toBe("refresh_token")
    expect(sent[0]?.get("refresh_token")).toBe("rt-1")
    expect(sent[0]?.get("client_id")).toBe("cid-123")
    expect(sent[0]?.get("client_secret")).toBe("csec-456")
    expect(sent[0]?.has("code_verifier")).toBe(false)
    expect(sent[0]?.has("redirect_uri")).toBe(false)
    expect(grant.accessToken).toBe("newer")
  })

  it("omits the secret on a refresh for a public client too", async () => {
    const sent = capture({ access_token: "newer" })
    const o = oauth({ apps: { cloudflare: { clientId: "cid-123" } } })
    await o.refresh({ slug: "cloudflare", refreshToken: "rt-1" })
    expect(sent[0]?.has("client_secret")).toBe(false)
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

/**
 * Routing the one exchange our egress is refused for.
 *
 * ⚠ THE THING UNDER TEST IS *WHERE* THE REQUEST GOES, WHICH NOTHING ELSE HERE
 * LOOKS AT. `dash.cloudflare.com` answers psl-vps with a managed challenge to
 * every client we can construct — measured over IPv4 and IPv6, HTTP/1.1 and h2,
 * curl and Bun — so the fix could only ever be a different caller. That makes
 * the destination a correctness property rather than plumbing: brokering the
 * wrong host sends a client secret somewhere it did not need to go, and
 * brokering none of them leaves the feature broken in production while passing
 * every other test in this file.
 */
describe("the OAuth broker", () => {
  const spy = () => {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ access_token: "at" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    return calls
  }

  const withBroker = () =>
    oauth({ broker: { url: "https://broker.workers.dev", secret: "shh" } })

  it("sends Cloudflare's exchange to the broker, with the broker's own bearer", async () => {
    const calls = spy()
    const o = withBroker()
    const { verifier } = o.verifyState(start(o).state)

    await o.exchange({ slug: "cloudflare", code: "the-code", verifier })

    expect(calls[0]?.url).toBe("https://broker.workers.dev")
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer shh",
    )
  })

  it("still sends the client secret in the body, untouched", async () => {
    const calls = spy()
    const o = withBroker()
    const { verifier } = o.verifyState(start(o).state)

    await o.exchange({ slug: "cloudflare", code: "the-code", verifier })

    // ⚠ THE BROKER AUTHORISES US TO THE WORKER; THIS AUTHORISES US TO
    // CLOUDFLARE. Losing the second one would turn a fixed exchange into
    // `invalid_client`, which is the failure this whole change is meant to
    // stop being reported for the wrong reason.
    const sent = new URLSearchParams(String(calls[0]?.init.body))
    expect(sent.get("client_secret")).toBe("csec-456")
    expect(sent.get("code_verifier")).toBe(verifier)
  })

  it("calls the provider directly when no broker is configured", async () => {
    const calls = spy()
    const o = oauth()
    const { verifier } = o.verifyState(start(o).state)

    await o.exchange({ slug: "cloudflare", code: "c", verifier })

    expect(calls[0]?.url).toBe("https://dash.cloudflare.com/oauth2/token")
    expect(calls[0]?.init.headers).not.toHaveProperty("Authorization")
  })

  /**
   * ⚠ `api.cloudflare.com` IS NOT `dash.cloudflare.com`, AND THE DIFFERENCE IS
   * THE WHOLE DIAGNOSIS. Every zone read and record write the publish path
   * makes goes to the API host and has never been challenged from the cluster;
   * only the dashboard host refuses us. A broker keyed on "Cloudflare" rather
   * than on the host would have relayed calls that work perfectly well.
   */
  it("brokers by host, so only the challenged endpoint is routed", async () => {
    const calls = spy()
    const o = oauth({
      apps: { digitalocean: { clientId: "do-id", clientSecret: "do-secret" } },
      broker: { url: "https://broker.workers.dev", secret: "shh" },
    })
    const { verifier } = o.verifyState(
      o.start({ slug: "digitalocean", tenantId: "t" }).state,
    )

    await o.exchange({ slug: "digitalocean", code: "c", verifier })

    expect(calls[0]?.url).not.toBe("https://broker.workers.dev")
    expect(calls[0]?.init.headers).not.toHaveProperty("Authorization")
  })

  /**
   * ⚠ A 401 FROM THE BROKER AND A 401 FROM CLOUDFLARE ARE THE SAME STATUS AND
   * OPPOSITE PROBLEMS. One is a rotated `BROKER_SECRET`, which is ours; the
   * other is `invalid_client`, which sends an administrator to edit a client
   * secret that was correct. `x-broker-error` is the only thing that tells them
   * apart, and the Worker is the only thing that sets it.
   */
  it("reports the broker's own refusal as the broker's, not the provider's", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", {
        status: 401,
        headers: { "x-broker-error": "unauthorized" },
      })) as unknown as typeof fetch

    const o = withBroker()
    const { verifier } = o.verifyState(start(o).state)

    await expect(
      o.exchange({ slug: "cloudflare", code: "c", verifier }),
    ).rejects.toMatchObject({
      kind: "exchange_failed",
      detail: "the OAuth broker refused the request (unauthorized)",
    })
  })
})
