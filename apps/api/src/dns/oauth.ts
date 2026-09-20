import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { providerBySlug } from "@repo/dns-providers"
import { DNS_USER_AGENT } from "./user-agent.js"

/**
 * The authorization-code flow, driven by the registry rather than per provider.
 *
 * ⚠ ONE IMPLEMENTATION FOR EVERY PROVIDER, BECAUSE OAUTH 2.0 IS THE SAME SHAPE
 * EIGHT TIMES. The registry already carries each provider's `authorizeUrl`,
 * `tokenUrl` and `scopes`; what differs per provider is a client id and secret,
 * which is configuration. Writing eight nearly identical flows would be eight
 * places to get `state` wrong, and `state` is the entire CSRF defence.
 *
 * ⚠ `state` IS SIGNED AND CARRIES THE TENANT, RATHER THAN BEING A RANDOM VALUE
 * IN A SESSION STORE. The callback arrives as a plain browser navigation with
 * no session we control, so the only thing telling us which workspace authorised
 * this is what we put in `state` — and if that is unauthenticated, anybody can
 * craft a callback that attaches THEIR DNS credential to SOMEBODY ELSE'S
 * workspace. That is not a theoretical: it is the standard OAuth
 * account-linking attack, and the consequence here is a stranger holding a
 * connection that publishes records into a zone they do not own. An HMAC over
 * `tenant|provider|nonce|expiry`, verified on the way back, closes it without a
 * server-side store.
 *
 * ⚠ AND IT EXPIRES. A signed state with no deadline is a bearer token for
 * account-linking that works for ever; ten minutes is longer than any honest
 * authorisation takes.
 */

export interface OAuthApp {
  clientId: string
  /**
   * ⚠ OPTIONAL, BECAUSE NOT EVERY PROVIDER ISSUES ONE. Cloudflare's OAuth has
   * `none` among its `token_endpoint_auth_methods_supported`, which is how
   * `wrangler` authenticates — a PUBLIC client, with no secret to keep, whose
   * entire protection against a stolen authorization code is PKCE. Requiring a
   * secret here would make such an app impossible to configure; sending an
   * empty one would be rejected by the token endpoint.
   */
  clientSecret?: string
  /**
   * Overrides the registry's scopes for this provider.
   *
   * ⚠ IT EXISTS BECAUSE A SCOPE NAME IS A FACT ABOUT SOMEBODY ELSE'S PRODUCT,
   * NOT ABOUT OURS. The registry's list is our best reading of each provider's
   * documentation at the time it was written, and providers rename scopes,
   * split them, and publish names in docs that differ from the strings their
   * authorize endpoint actually accepts. Cloudflare's are a live example: the
   * registry carries API-token syntax, and the real values come from an
   * endpoint that needs credentials to read.
   *
   * ⚠ SO GETTING ONE WRONG IS A DOPPLER EDIT RATHER THAN A DEPLOY. The failure
   * it fixes — a consent screen that refuses, or grants a token that cannot do
   * the one thing we need — is discovered during setup by whoever is holding
   * the dashboard, and making them wait for a release to try the next string is
   * the difference between ten minutes and an afternoon.
   */
  scopes?: readonly string[]
}

export interface OAuthConfig {
  /** Registry slug → the app we registered with that provider. */
  apps: Record<string, OAuthApp>
  /**
   * Where the provider sends the browser back.
   *
   * ⚠ ONE URL FOR EVERY PROVIDER, WITH THE SLUG IN THE PATH. Most providers
   * require every redirect URI to be registered ahead of time and compared
   * exactly, so building it from a request header would mean a redirect that
   * works on one hostname and is rejected on another — including, eventually,
   * production.
   */
  redirectBase: string
  /** Signs `state`. Not the same key as anything else; see `env.ts`. */
  stateSecret: string
  /**
   * Where to send a token exchange that our own egress is refused for.
   *
   * ⚠ IT EXISTS FOR EXACTLY ONE MEASURED FAILURE AND IS NOT A GENERAL PROXY.
   * `dash.cloudflare.com` is a dashboard host behind Cloudflare's bot
   * management; from psl-vps it answers a managed challenge to every client we
   * can construct — curl and Bun alike, HTTP/1.1 and h2 alike, over IPv4 and
   * IPv6 alike — while answering ordinary OAuth JSON to the same request from a
   * residential line. No header fixes that, because it is a decision about the
   * ADDRESS. See services/dns-oauth-broker.
   *
   * ⚠ UNSET IS A SUPPORTED STATE AND MEANS "CALL DIRECTLY". Every other
   * provider's token endpoint is an ordinary API host that answers us, and
   * routing eight providers through one Worker would turn a Cloudflare-shaped
   * problem into a single point of failure for all of them.
   */
  broker?: { url: string; secret: string }
  now?: () => number
}

/**
 * Token endpoints that will not answer our egress, so the broker is used.
 *
 * ⚠ A HOST LIST RATHER THAN A PROVIDER LIST, BECAUSE THE PROBLEM IS THE HOST.
 * What is challenged is `dash.cloudflare.com` — the dashboard — and not
 * Cloudflare as a company: their `api.cloudflare.com`, which the publish path
 * uses for every zone read and record write, has never been challenged from the
 * cluster. Keying on the provider slug would have brokered calls that work
 * perfectly well and hidden which half of Cloudflare is actually the problem.
 */
const BROKERED_HOSTS = new Set(["dash.cloudflare.com"])

export interface AuthorizationStart {
  url: string
  state: string
}

const STATE_TTL_MS = 10 * 60 * 1000

/** RFC 6749's token response, and RFC 6749's error response. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

/**
 * What actually happened, in one line an administrator can act on.
 *
 * ⚠ IT ALWAYS LEADS WITH THE STATUS. `invalid_grant` alone does not say
 * whether the provider answered at all, and a 502 from something in front of
 * them is a different problem from a 400 they sent deliberately.
 *
 * ⚠ AND THE RAW BODY IS ONLY SHOWN WHEN IT DID NOT PARSE AS JSON. A parsed
 * error response is already summarised by its own fields; an unparsed one is
 * an HTML page from a WAF, a proxy or a load balancer, and its first line is
 * the only thing that names which. Restricting the snippet to that case is
 * also what keeps a successful-looking body with an unexpected shape from
 * having its contents copied into a log.
 */
function describeFailure(
  response: Response,
  body: TokenResponse | null,
  raw: string,
): string {
  const parts = [`HTTP ${response.status}`]

  const named = body?.error_description ?? body?.error
  if (named) parts.push(named)
  else {
    const stopped = interference(response, raw)
    if (stopped.kind === "challenged") parts.push(CHALLENGED)
    else if (stopped.kind === "blocked") parts.push(blockedBy(stopped.code))
    else if (raw.trim()) parts.push(snippet(raw))
    else parts.push("the endpoint answered with an empty body")
  }

  /*
   * ⚠ THE RAY ID IS THE ONLY THING CLOUDFLARE SUPPORT WILL ASK FOR. It
   * identifies the exact request in their own logs, including the rule that
   * stopped it — which is the one fact nobody on this side of the connection
   * can otherwise discover. `wrangler` prints it for the same reason and in
   * the same situation; see `isBotChallenge`.
   */
  const ray = response.headers.get("cf-ray")
  if (ray) parts.push(`cf-ray ${ray}`)

  return parts.join(" · ")
}

const CHALLENGED =
  "Cloudflare challenged the request instead of answering it — a bot-management " +
  "decision about where we called from, not about your authorisation. Quote the " +
  "ray id to Cloudflare support."

const blockedBy = (code: string) =>
  `Cloudflare refused the request itself with error ${code}, before the OAuth ` +
  "endpoint saw it. Quote the ray id to Cloudflare support."

/**
 * What stopped this, when it was not the OAuth endpoint.
 *
 * ⚠ THESE WERE ONE BRANCH AND THEY ARE TWO DIFFERENT PROBLEMS WITH TWO
 * DIFFERENT FIXES. A CHALLENGE is bot management scoring the caller — the
 * address, the ASN, the TLS fingerprint, the user agent — and it clears by
 * changing one of those or by being allowlisted. A BLOCK (`error code: 1010`,
 * `1020`, and friends) is a firewall rule that matched, which is a different
 * conversation with support and often a different team. Reporting both as "a
 * bot challenge" was us asserting a cause we had not established, on a page
 * that then tells the customer it is nobody's fault — and being wrong about
 * that sends whoever reads it to argue the wrong case.
 *
 * ⚠ `Attention Required` HAS BEEN DROPPED AS A CHALLENGE MARKER, because it is
 * the TITLE OF THE BLOCK PAGE. It was the loosest of the three and the one
 * most likely to make a firewall rule look like a bot score. A block page with
 * no error code in it now falls through to `snippet`, which quotes the page
 * itself — less of a claim, and more information.
 *
 * ⚠ `cf-mitigated` IS STILL FIRST BECAUSE IT IS THE ONLY UNAMBIGUOUS SIGNAL.
 * Cloudflare sets it on a challenged response and on nothing else.
 *
 * ⚠ AND `challenge-platform` IS NOT A GUESS ABOUT SOMEBODY ELSE'S SYSTEM —
 * CLOUDFLARE'S OWN CLIENT MATCHES IT ON THIS EXACT ENDPOINT. `wrangler`'s
 * `getJSONFromResponse` tests `<!DOCTYPE html>` and then `challenge-platform`,
 * and prints "It looks like you might have hit a bot challenge page… please
 * provide your Ray ID".
 */
type Interference =
  { kind: "challenged" } | { kind: "blocked"; code: string } | { kind: "none" }

function interference(response: Response, raw: string): Interference {
  if (response.headers.get("cf-mitigated")) return { kind: "challenged" }
  if (!/<!DOCTYPE html>/i.test(raw)) return { kind: "none" }
  if (raw.includes("challenge-platform")) return { kind: "challenged" }

  const blocked = /error code: (10\d\d)/.exec(raw)
  if (blocked?.[1]) return { kind: "blocked", code: blocked[1] }

  return { kind: "none" }
}

/**
 * The page itself, for the log.
 *
 * ⚠ THE DETECTOR ABOVE WAS EATING THE ONLY EVIDENCE THERE IS, AND THAT IS WHY
 * THIS FAILURE HAS BEEN ARGUED ABOUT INSTEAD OF SETTLED. `describeFailure`
 * quotes the body only when it does NOT classify it — so in the one case where
 * we most need to know what Cloudflare actually served, the body was read,
 * matched against three substrings, reduced to a sentence, and dropped. Two
 * rounds of this were spent reasoning about a response nobody had ever seen.
 *
 * ⚠ IT CARRIES THE HEADERS THAT DECIDE THE CLASSIFICATION, not just the text.
 * `cf-mitigated` present or absent is the difference between a challenge and a
 * firewall rule, and it is invisible in the body.
 *
 * ⚠ IT IS BUILT ONLY WHEN THE BODY DID NOT PARSE AS JSON, which is what keeps
 * it safe to log. A token endpoint's JSON is the one thing here that can carry
 * a credential; an HTML page from a proxy cannot, and neither can an empty
 * body. The REQUEST holds our secret and is never included.
 *
 * ⚠ AND IT IS BOUNDED. A challenge page is a few kilobytes of inlined script;
 * the first 2000 characters carry the doctype, the title, the error code and
 * the ray, which is all of what identifies it.
 */
const EVIDENCE_HEADERS = [
  "cf-ray",
  "cf-mitigated",
  "content-type",
  "server",
  "retry-after",
] as const

function transcript(response: Response, raw: string): string {
  const headers = EVIDENCE_HEADERS.map(
    (name) => [name, response.headers.get(name)] as const,
  )
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`)

  return [...headers, "", raw.slice(0, 2000)].join("\n")
}

/** The first readable line of an HTML or plain-text body. */
function snippet(raw: string): string {
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

export class OAuthError extends Error {
  constructor(
    readonly kind: "unconfigured" | "bad_state" | "exchange_failed",
    message: string,
    readonly detail?: string,
    /**
     * The unparsed response, for the log and never for the browser.
     *
     * ⚠ `detail` IS A SENTENCE FOR A CUSTOMER AND THIS IS THE PROOF BEHIND IT.
     * They are separate because they go to different places: `detail` is
     * returned by the callback route, this is only ever logged. See
     * `transcript`.
     */
    readonly evidence?: string,
  ) {
    super(message)
    this.name = "OAuthError"
  }
}

export interface TokenGrant {
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds, when the provider gave an expiry. */
  expiresAt?: number
  scopes?: string
}

export interface DnsOAuth {
  /** `null` when no app is configured for that provider. */
  isConfigured(slug: string): boolean
  start(input: { slug: string; tenantId: string }): AuthorizationStart
  /**
   * Verifies `state` and returns who it belongs to. Throws on tampering.
   *
   * ⚠ IT ALSO RETURNS THE PKCE VERIFIER, RECOMPUTED RATHER THAN REMEMBERED.
   * See `pkceVerifier` below for why that is not a shortcut.
   */
  verifyState(state: string): { slug: string; tenantId: string; verifier: string }
  exchange(input: {
    slug: string
    code: string
    /** From `verifyState`. The token endpoint rejects the exchange without it. */
    verifier: string
  }): Promise<TokenGrant>
  /**
   * Trades a refresh token for a new access token.
   *
   * ⚠ WITHOUT THIS A CONNECTION IS GOOD FOR ONE ACCESS TOKEN AND THEN DEAD. The
   * grant was stored from the moment somebody authorised us and never looked at
   * again, so the first publish after the token expired failed `unauthorized`
   * — which the console correctly reports as "reconnect", asking a customer to
   * redo an authorisation that never actually lapsed.
   */
  refresh(input: { slug: string; refreshToken: string }): Promise<TokenGrant>
}

export function dnsOAuth(config: OAuthConfig): DnsOAuth {
  const now = config.now ?? (() => Date.now())
  const redirectFor = (slug: string) =>
    `${config.redirectBase.replace(/\/$/, "")}/${encodeURIComponent(slug)}`

  const sign = (payload: string) =>
    createHmac("sha256", config.stateSecret).update(payload).digest("base64url")

  /**
   * The PKCE code verifier for a given authorisation, derived rather than
   * stored.
   *
   * ⚠ PKCE EXISTS BECAUSE THE AUTHORIZATION CODE TRAVELS THROUGH A BROWSER WE
   * DO NOT CONTROL. Anything that can read the redirect — a malicious
   * extension, a proxy, a referrer log, shoulder-surfing a URL bar — holds a
   * code that can be exchanged for a credential that writes DNS in a customer's
   * zone. The challenge binds that code to a secret only this server knows.
   *
   * ⚠ WHICH IS EXACTLY WHY THE VERIFIER MUST NOT TRAVEL IN `state`. It is the
   * obvious place to put it — `state` already round-trips and is already
   * signed — but signed is not secret: the payload is base64url, readable by
   * anyone holding the URL. A verifier sitting beside the code it protects
   * protects nothing at all.
   *
   * ⚠ SO IT IS AN HMAC OF THE NONCE UNDER THE STATE SECRET. The nonce is public
   * and already in `state`; the secret is not, so the verifier can be
   * recomputed at callback time and never has to be written down, stored, or
   * sent anywhere. That keeps the "no server-side store" property this module
   * was built around.
   */
  const pkceVerifier = (nonce: string) =>
    createHmac("sha256", config.stateSecret).update(`pkce|${nonce}`).digest("base64url")

  /** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
  const pkceChallenge = (verifier: string) =>
    createHash("sha256").update(verifier).digest("base64url")

  return {
    isConfigured(slug) {
      return Boolean(config.apps[slug])
    },

    start({ slug, tenantId }) {
      const provider = providerBySlug(slug)
      const oauth = provider?.api?.oauth
      const app = config.apps[slug]

      if (!provider || !oauth) {
        throw new OAuthError(
          "unconfigured",
          `${slug} does not support connecting with OAuth.`,
        )
      }
      if (!app) {
        /*
         * ⚠ OUR MISCONFIGURATION, AND IT SAYS SO. An unregistered OAuth app is
         * not something the customer can fix and will never clear on its own,
         * so "try again later" would be false advice. The console renders this
         * as "not available yet" rather than as an error against their account.
         */
        throw new OAuthError(
          "unconfigured",
          `Connecting ${provider.name} is not configured on this deployment.`,
        )
      }

      // ⚠ THE NONCE MAKES TWO STARTS IN THE SAME MILLISECOND DIFFERENT, so a
      // state cannot be replayed from a browser history entry of another tab.
      //
      // ⚠ AND IT IS NOW ALSO THE SEED FOR THE PKCE VERIFIER, which is why it is
      // 18 bytes rather than 9: it is the only unpredictable input standing
      // between somebody holding a stolen code and a working credential.
      const nonce = randomBytes(18).toString("base64url")
      const payload = [tenantId, slug, nonce, String(now() + STATE_TTL_MS)].join("|")
      const state = `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`

      const url = new URL(oauth.authorizeUrl)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", app.clientId)
      url.searchParams.set("redirect_uri", redirectFor(slug))
      url.searchParams.set("state", state)
      // ⚠ THE CONFIGURED LIST WINS WHOLESALE, NOT MERGED. A merge would mean a
      // deployment could only ever ADD to whatever the registry happens to
      // say — so a registry entry that is simply wrong could not be corrected,
      // which is the entire case for this override existing.
      const scopes = app.scopes ?? oauth.scopes
      if (scopes.length > 0) {
        url.searchParams.set("scope", scopes.join(" "))
      }

      /*
       * ⚠ SENT FOR EVERY PROVIDER, NOT ONLY THE ONES THAT DEMAND IT. PKCE is
       * additive: a server that does not implement it ignores both parameters,
       * and one that does binds the code to us. Making it conditional would mean
       * a per-provider flag nobody updates, and the provider that quietly starts
       * requiring it would break on a Tuesday with no clue in the error.
       */
      url.searchParams.set("code_challenge", pkceChallenge(pkceVerifier(nonce)))
      url.searchParams.set("code_challenge_method", "S256")

      return { url: url.toString(), state }
    },

    verifyState(state) {
      const [encoded, signature] = state.split(".")
      if (!encoded || !signature) {
        throw new OAuthError("bad_state", "That authorisation link is malformed.")
      }

      const payload = Buffer.from(encoded, "base64url").toString()
      const expected = sign(payload)

      /*
       * ⚠ `timingSafeEqual`, AND THE LENGTH CHECK BEFORE IT. It throws on a
       * length mismatch rather than returning false, so comparing directly
       * turns a forged state of the wrong length into a 500 instead of a
       * refusal — and the difference in response is itself an oracle.
       */
      const a = Buffer.from(signature)
      const b = Buffer.from(expected)
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new OAuthError("bad_state", "That authorisation could not be verified.")
      }

      const [tenantId, slug, nonce, expiry] = payload.split("|")
      if (!tenantId || !slug || !nonce || !expiry) {
        throw new OAuthError("bad_state", "That authorisation link is malformed.")
      }
      if (Number(expiry) < now()) {
        throw new OAuthError(
          "bad_state",
          "That authorisation took too long. Start again.",
        )
      }

      return { slug, tenantId, verifier: pkceVerifier(nonce) }
    },

    async exchange({ slug, code, verifier }) {
      return token(slug, (app) => ({
        grant_type: "authorization_code",
        code,
        client_id: app.clientId,
        // ⚠ OMITTED ENTIRELY FOR A PUBLIC CLIENT, not sent empty. An empty
        // `client_secret` is a supplied-and-wrong secret to a token
        // endpoint, which answers `invalid_client` — indistinguishable in
        // the log from a real secret that has been rotated.
        ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
        code_verifier: verifier,
        redirect_uri: redirectFor(slug),
      }))
    },

    async refresh({ slug, refreshToken }) {
      return token(slug, (app) => ({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: app.clientId,
        ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
        // ⚠ NO `code_verifier` AND NO `redirect_uri`. PKCE binds the
        // AUTHORIZATION CODE to this server; a refresh carries no code, and
        // sending either parameter is rejected by strict implementations.
      }))
    },
  }

  /**
   * One POST to a provider's token endpoint, whatever is being traded.
   *
   * ⚠ SHARED SO THE TWO GRANTS CANNOT DRIFT. An authorization-code exchange and
   * a refresh differ only in the body; everything around them — the form
   * encoding, the timeout, which failures are `exchange_failed`, how an expiry
   * becomes an absolute timestamp — is identical, and the half that is easy to
   * forget in a second copy is the one that only matters an hour after somebody
   * connected.
   */
  async function token(
    slug: string,
    form: (app: OAuthApp) => Record<string, string>,
  ): Promise<TokenGrant> {
    const provider = providerBySlug(slug)
    const oauth = provider?.api?.oauth
    const app = config.apps[slug]
    if (!oauth || !app) {
      throw new OAuthError("unconfigured", `${slug} is not configured for OAuth.`)
    }

    /*
     * ⚠ THE BODY IS BUILT ONCE AND SENT WHICHEVER WAY IT GOES. The broker
     * forwards it verbatim, so a difference between the two paths here would be
     * a bug that only ever appears for Cloudflare and only in production.
     */
    const payload = new URLSearchParams(form(app))
    const broker = BROKERED_HOSTS.has(new URL(oauth.tokenUrl).host)
      ? config.broker
      : undefined

    let response: Response
    try {
      response = await fetch(broker ? broker.url : oauth.tokenUrl, {
        method: "POST",
        headers: {
          /*
           * ⚠ THE BROKER'S OWN CREDENTIAL, AND IT IS NOT THE PROVIDER'S. It
           * authorises us to the Worker; the client secret that authorises us
           * to Cloudflare is in the body, untouched, exactly as it would be on
           * the direct path.
           */
          ...(broker ? { Authorization: `Bearer ${broker.secret}` } : {}),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          /*
           * ⚠ CLOUDFLARE'S TOKEN ENDPOINT IS BEHIND THEIR OWN BOT MANAGEMENT,
           * AND IT IS NOT WHAT FIXED CLOUDFLARE. Identifying ourselves is worth
           * doing on every provider's endpoint; it is simply not sufficient on
           * `dash.cloudflare.com`, which refuses us on the address regardless.
           * See ./user-agent.ts and `broker` above.
           */
          "User-Agent": DNS_USER_AGENT,
        },
        /*
         * ⚠ THE SECRET GOES IN THE BODY, NOT IN A BASIC HEADER. Both are
         * permitted by RFC 6749 and providers differ on which they accept;
         * the body form is the one every provider in this registry documents.
         */
        body: payload,
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new OAuthError(
        "exchange_failed",
        `Could not reach ${provider.name}.`,
        String(error),
      )
    }

    /*
     * ⚠ THE BROKER'S OWN REFUSAL IS NOT THE PROVIDER'S, AND CONFLATING THEM
     * WOULD UNDO THE POINT OF IT. A rotated broker secret answers 401, which is
     * the same status Cloudflare uses for `invalid_client` — so without this
     * header a misconfigured Worker would be reported to an administrator as
     * "your client secret is wrong", sending them to edit the one thing that
     * was correct. `x-broker-error` is set only by the Worker; Cloudflare never
     * sends it.
     */
    const brokerError = response.headers.get("x-broker-error")
    if (brokerError) {
      throw new OAuthError(
        "exchange_failed",
        `Could not reach ${provider.name}.`,
        `the OAuth broker refused the request (${brokerError})`,
      )
    }

    /*
     * ⚠ READ AS TEXT FIRST, BECAUSE THE FAILURE WE CANNOT DIAGNOSE IS THE ONE
     * THAT IS NOT JSON. `response.json().catch(() => null)` threw away the
     * whole body, so a Cloudflare challenge page — the single most likely
     * reason a token exchange fails from inside a datacentre — arrived here as
     * `null` and was reported as the bare status. "HTTP 403" and "the client
     * secret is wrong" were indistinguishable, and the difference is the whole
     * question: one is our egress being challenged, the other is a Doppler
     * edit. The text is read once and parsed from memory, which costs nothing
     * and keeps the evidence.
     */
    const raw = await response.text().catch(() => "")

    let body: TokenResponse | null = null
    try {
      body = raw ? (JSON.parse(raw) as TokenResponse) : null
    } catch {
      body = null
    }

    if (!response.ok || !body?.access_token) {
      throw new OAuthError(
        "exchange_failed",
        `${provider.name} did not complete the authorisation.`,
        describeFailure(response, body, raw),
        // See `transcript`: only when the body was not JSON, so it cannot hold
        // a token, and it is the answer to "what did they actually send".
        body === null ? transcript(response, raw) : undefined,
      )
    }

    return {
      accessToken: body.access_token,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.expires_in === "number"
        ? { expiresAt: now() + body.expires_in * 1000 }
        : {}),
      ...(body.scope ? { scopes: body.scope } : {}),
    }
  }
}
