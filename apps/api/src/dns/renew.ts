import type { DnsConnectionStore } from "./connections.js"
import type { DnsOAuth } from "./oauth.js"
import type { Credential } from "./port.js"

/**
 * Keeping a customer's DNS credential alive.
 *
 * ⚠ WITHOUT THIS A CONNECTION IS GOOD FOR ONE ACCESS TOKEN AND THEN DEAD. The
 * grant was stored the moment somebody authorised us and never read again, so
 * the first publish after the token expired failed `unauthorized` — and the
 * console correctly told the customer to reconnect, asking them to redo an
 * authorisation that had not actually lapsed. The refresh token was sitting in
 * the row the whole time.
 *
 * ⚠ IT IS A NO-OP FOR A PASTED API TOKEN, which is how most of the registry is
 * reachable. Those carry no expiry and no refresh token, so there is nothing to
 * renew and nothing to get wrong.
 */

/**
 * ⚠ RENEWED EARLY, NOT AT THE MOMENT OF EXPIRY. A publish is several round
 * trips — list zones, list records, create each one — so a token with thirty
 * seconds left at the first call is an expired token by the third, and the
 * failure lands halfway through writing a delegation.
 */
const SKEW_MS = 5 * 60 * 1000

interface OAuthCredential {
  accessToken?: unknown
  refreshToken?: unknown
  expiresAt?: unknown
}

export interface RenewalDeps {
  oauth: DnsOAuth
  connections: DnsConnectionStore
  log?: { warn: (o: object, m: string) => void }
  now?: () => number
}

export function credentialRenewal({
  oauth,
  connections,
  log,
  now = Date.now,
}: RenewalDeps) {
  return async function renew(input: {
    tenantId: string
    provider: string
    credential: Credential
  }): Promise<Credential> {
    const held = input.credential as OAuthCredential

    const expiresAt = typeof held.expiresAt === "number" ? held.expiresAt : null
    const refreshToken =
      typeof held.refreshToken === "string" && held.refreshToken.length > 0
        ? held.refreshToken
        : null

    // Nothing to renew: a pasted token, or one with plenty of life left.
    if (!refreshToken || expiresAt === null) return input.credential
    if (expiresAt - now() > SKEW_MS) return input.credential

    let grant
    try {
      grant = await oauth.refresh({ slug: input.provider, refreshToken })
    } catch (error) {
      /*
       * ⚠ THE OLD CREDENTIAL IS RETURNED RATHER THAN THROWN OVER. A refresh can
       * fail because the customer revoked our access — in which case the
       * publish is going to fail anyway, and it should fail with the provider's
       * own `unauthorized`, which the console already turns into "reconnect".
       * Throwing here would replace that with an error about a token endpoint,
       * which is true and useless.
       *
       * ⚠ AND IT IS A WARNING, NOT AN ERROR. A provider's token endpoint having
       * a bad minute is not an incident; the same publish will renew again next
       * time. What matters is that it is written down, because a refresh that
       * fails EVERY time is invisible otherwise.
       */
      log?.warn(
        { err: String(error), tenantId: input.tenantId, provider: input.provider },
        "could not renew the DNS credential; using the one we hold",
      )
      return input.credential
    }

    /*
     * ⚠ THE OLD REFRESH TOKEN IS KEPT WHEN THE PROVIDER DOES NOT SEND A NEW
     * ONE. Some rotate it on every use and some never do; storing `undefined`
     * over a still-valid one turns the next renewal into a reconnection, which
     * is the exact failure this function exists to prevent.
     */
    const renewed: Credential = {
      ...input.credential,
      accessToken: grant.accessToken,
      ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    }

    await connections.updateCredential({
      tenantId: input.tenantId,
      provider: input.provider,
      credential: renewed,
    })

    return renewed
  }
}
