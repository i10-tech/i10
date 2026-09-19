import { describe, expect, it, mock } from "bun:test"
import { credentialRenewal } from "../src/dns/renew.js"
import type { DnsConnectionStore } from "../src/dns/connections.js"
import type { DnsOAuth, TokenGrant } from "../src/dns/oauth.js"
import type { Credential } from "../src/dns/port.js"

/**
 * Keeping a customer's DNS credential alive.
 *
 * ⚠ THE BUG THIS CLOSES WAS INVISIBLE FOR EXACTLY AS LONG AS AN ACCESS TOKEN
 * LASTS. The grant was stored the moment somebody authorised us and never read
 * again, so everything worked in testing and the first publish an hour later
 * failed `unauthorized` — which the console correctly reports as "reconnect",
 * asking a customer to redo an authorisation that had not lapsed, while the
 * refresh token sat unused in their row.
 */

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const grant = (over: Partial<TokenGrant> = {}): TokenGrant => ({
  accessToken: "fresh-access",
  refreshToken: "fresh-refresh",
  expiresAt: NOW + 60 * MINUTE,
  ...over,
})

function harness(over: { grant?: TokenGrant; fail?: Error } = {}) {
  const refresh = mock(async (): Promise<TokenGrant> => {
    if (over.fail) throw over.fail
    return over.grant ?? grant()
  })
  const updateCredential = mock(async () => {})
  const warn = mock(() => {})

  const renew = credentialRenewal({
    oauth: { refresh } as unknown as DnsOAuth,
    connections: { updateCredential } as unknown as DnsConnectionStore,
    log: { warn },
    now: () => NOW,
  })

  const run = (credential: Credential) =>
    renew({ tenantId: "t1", provider: "cloudflare", credential })

  return { renew: run, refresh, updateCredential, warn }
}

describe("a credential with nothing to renew", () => {
  /**
   * ⚠ MOST OF THE REGISTRY IS REACHABLE ONLY BY A PASTED API TOKEN, and those
   * carry no expiry and no refresh token. Touching one would be a round trip
   * for nothing at best, and at worst an attempt to refresh something that was
   * never an OAuth grant.
   */
  it("leaves a pasted API token exactly as it is", async () => {
    const h = harness()
    const token = { token: "stub-pasted-token" }

    expect(await h.renew(token)).toBe(token)
    expect(h.refresh).not.toHaveBeenCalled()
    expect(h.updateCredential).not.toHaveBeenCalled()
  })

  it("leaves a grant that has no refresh token", async () => {
    const h = harness()
    const held = { accessToken: "a", expiresAt: NOW - MINUTE }
    expect(await h.renew(held)).toBe(held)
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it("leaves a grant with plenty of life left", async () => {
    const h = harness()
    const held = { accessToken: "a", refreshToken: "r", expiresAt: NOW + 60 * MINUTE }
    expect(await h.renew(held)).toBe(held)
    expect(h.refresh).not.toHaveBeenCalled()
  })
})

describe("a credential that is about to expire", () => {
  /**
   * ⚠ RENEWED EARLY, NOT AT THE MOMENT OF EXPIRY. A publish is several round
   * trips — list zones, list records, create each record — so a token with
   * thirty seconds left at the first call is an expired token by the third, and
   * the failure lands halfway through writing a delegation.
   */
  it("is renewed inside the skew window, before it has actually expired", async () => {
    const h = harness()
    const renewed = await h.renew({
      accessToken: "old",
      refreshToken: "r",
      expiresAt: NOW + 2 * MINUTE,
    })

    expect(h.refresh).toHaveBeenCalledWith({ slug: "cloudflare", refreshToken: "r" })
    expect(renewed).toMatchObject({ accessToken: "fresh-access" })
  })

  it("is renewed once it has expired", async () => {
    const h = harness()
    await h.renew({ accessToken: "old", refreshToken: "r", expiresAt: NOW - MINUTE })
    expect(h.refresh).toHaveBeenCalled()
  })

  /** ⚠ AND WRITTEN BACK, or the next publish repeats the refresh for ever. */
  it("stores the renewed credential", async () => {
    const h = harness()
    await h.renew({ accessToken: "old", refreshToken: "r", expiresAt: NOW })

    expect(h.updateCredential).toHaveBeenCalledWith({
      tenantId: "t1",
      provider: "cloudflare",
      credential: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: NOW + 60 * MINUTE,
      },
    })
  })

  /**
   * ⚠ THE OLD REFRESH TOKEN IS KEPT WHEN THE PROVIDER DOES NOT SEND A NEW ONE.
   * Some rotate on every use and some never do; storing `undefined` over a
   * still-valid one turns the NEXT renewal into a reconnection, which is the
   * precise failure this whole file exists to prevent.
   */
  it("keeps the refresh token it already has when none is returned", async () => {
    const h = harness({
      grant: { accessToken: "fresh-access", expiresAt: NOW + MINUTE },
    })
    const renewed = await h.renew({
      accessToken: "old",
      refreshToken: "keep-me",
      expiresAt: NOW,
    })

    expect(renewed).toMatchObject({ refreshToken: "keep-me" })
  })

  it("takes a rotated refresh token when one is returned", async () => {
    const h = harness()
    const renewed = await h.renew({
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: NOW,
    })
    expect(renewed).toMatchObject({ refreshToken: "fresh-refresh" })
  })

  /** Anything else the credential carried is preserved. */
  it("does not drop the rest of the credential", async () => {
    const h = harness()
    const renewed = await h.renew({
      accessToken: "old",
      refreshToken: "r",
      expiresAt: NOW,
      accountId: "acc-1",
    })
    expect(renewed).toMatchObject({ accountId: "acc-1" })
  })
})

describe("when the refresh itself fails", () => {
  /**
   * ⚠ THE OLD CREDENTIAL IS RETURNED RATHER THAN THROWN OVER. A refresh can
   * fail because the customer revoked our access — in which case the publish is
   * going to fail anyway, and it should fail with the PROVIDER's `unauthorized`,
   * which the console already turns into "reconnect". Throwing here replaces
   * that with an error about a token endpoint: true, and useless.
   */
  it("falls back to the credential we hold instead of throwing", async () => {
    const h = harness({ fail: new Error("invalid_grant") })
    const held = { accessToken: "old", refreshToken: "r", expiresAt: NOW }

    expect(await h.renew(held)).toBe(held)
    expect(h.updateCredential).not.toHaveBeenCalled()
  })

  /** ⚠ AND IT IS WRITTEN DOWN. A refresh failing EVERY time is invisible otherwise. */
  it("writes it down", async () => {
    const h = harness({ fail: new Error("invalid_grant") })
    await h.renew({ accessToken: "old", refreshToken: "r", expiresAt: NOW })
    expect(h.warn).toHaveBeenCalled()
  })
})
