import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { providerBySlug } from "@repo/dns-providers"

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
  clientSecret: string
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
  now?: () => number
}

export interface AuthorizationStart {
  url: string
  state: string
}

const STATE_TTL_MS = 10 * 60 * 1000

export class OAuthError extends Error {
  constructor(
    readonly kind: "unconfigured" | "bad_state" | "exchange_failed",
    message: string,
    readonly detail?: string,
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
  /** Verifies `state` and returns who it belongs to. Throws on tampering. */
  verifyState(state: string): { slug: string; tenantId: string }
  exchange(input: { slug: string; code: string }): Promise<TokenGrant>
}

export function dnsOAuth(config: OAuthConfig): DnsOAuth {
  const now = config.now ?? (() => Date.now())
  const redirectFor = (slug: string) =>
    `${config.redirectBase.replace(/\/$/, "")}/${encodeURIComponent(slug)}`

  const sign = (payload: string) =>
    createHmac("sha256", config.stateSecret).update(payload).digest("base64url")

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
      const payload = [
        tenantId,
        slug,
        randomBytes(9).toString("base64url"),
        String(now() + STATE_TTL_MS),
      ].join("|")
      const state = `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`

      const url = new URL(oauth.authorizeUrl)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", app.clientId)
      url.searchParams.set("redirect_uri", redirectFor(slug))
      url.searchParams.set("state", state)
      if (oauth.scopes.length > 0) {
        url.searchParams.set("scope", oauth.scopes.join(" "))
      }

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

      const [tenantId, slug, , expiry] = payload.split("|")
      if (!tenantId || !slug || !expiry) {
        throw new OAuthError("bad_state", "That authorisation link is malformed.")
      }
      if (Number(expiry) < now()) {
        throw new OAuthError(
          "bad_state",
          "That authorisation took too long. Start again.",
        )
      }

      return { slug, tenantId }
    },

    async exchange({ slug, code }) {
      const provider = providerBySlug(slug)
      const oauth = provider?.api?.oauth
      const app = config.apps[slug]
      if (!oauth || !app) {
        throw new OAuthError("unconfigured", `${slug} is not configured for OAuth.`)
      }

      let response: Response
      try {
        response = await fetch(oauth.tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          /*
           * ⚠ THE SECRET GOES IN THE BODY, NOT IN A BASIC HEADER. Both are
           * permitted by RFC 6749 and providers differ on which they accept;
           * the body form is the one every provider in this registry documents.
           */
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: app.clientId,
            client_secret: app.clientSecret,
            redirect_uri: redirectFor(slug),
          }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        throw new OAuthError(
          "exchange_failed",
          `Could not reach ${provider.name}.`,
          String(error),
        )
      }

      const body = (await response.json().catch(() => null)) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        scope?: string
        error?: string
        error_description?: string
      } | null

      if (!response.ok || !body?.access_token) {
        throw new OAuthError(
          "exchange_failed",
          `${provider.name} did not complete the authorisation.`,
          body?.error_description ?? body?.error ?? `HTTP ${response.status}`,
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
    },
  }
}
