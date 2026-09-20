import type { Hono } from "hono"
import { providerBySlug } from "@repo/dns-providers"
import { OAuthError } from "../../dns/oauth.js"
import { connectableProviders, writerFor } from "../../dns/writers.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * Connecting a customer's DNS provider, and publishing their records for them.
 *
 * ⚠ THE WHOLE POINT IS THAT NOBODY TYPES SIX RECORDS. Delegation already got it
 * down to three names; this removes the typing entirely wherever we hold a
 * credential — which is also where the most expensive support conversation used
 * to start, because a record typed into the wrong field looks identical to one
 * that has not propagated.
 *
 * ⚠ AND EVERY ROUTE HERE HANDLES SOMETHING THAT CAN REWRITE A CUSTOMER'S MX
 * RECORDS. They are session-authenticated like the rest of `/console`, the
 * credential is sealed before it is stored, and no route returns one. The one
 * that writes refuses on the first call when it would have to delete something,
 * and says what.
 */
export function mountDns(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // What can be connected, and what is
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ⚠ THE API ANSWERS WHAT IS CONNECTABLE; THE CONSOLE DOES NOT ASSUME. Whether
   * a provider can be connected depends on an adapter existing AND, for the
   * one-click path, on an OAuth app being registered — one is a deploy and the
   * other is configuration. A console that decided this from the registry alone
   * would render a live button for twenty-nine providers we cannot write to.
   */
  app.get("/dns/providers", async (c) => {
    const slugs = connectableProviders()
    return c.json({
      data: slugs.map((slug) => {
        const provider = providerBySlug(slug)
        return {
          slug,
          name: provider?.name ?? slug,
          /** A registered OAuth app exists, so the browser can be sent there. */
          oauth: d.dnsOAuth?.isConfigured(slug) ?? false,
          /** A token can be pasted instead. True wherever an adapter exists. */
          token: true,
          scope: provider?.api?.scope ?? null,
          docs: provider?.api?.docs ?? null,
          zoneScoped: provider?.api?.zoneScoped ?? false,
        }
      }),
    })
  })

  app.get("/dns/connections", async (c) => {
    if (!d.dnsConnections) return c.json(notWired("DNS connections"), 501)
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.dnsConnections.list(tenantId) })
  })

  app.delete("/dns/connections/:provider", async (c) => {
    if (!d.dnsConnections) return c.json(notWired("DNS connections"), 501)
    const { tenantId } = c.get("auth")
    const removed = await d.dnsConnections.remove(tenantId, c.req.param("provider"))
    return removed
      ? c.json({ object: "dns_connection", deleted: true })
      : c.json(notFound("No connection for that provider."), 404)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Connecting
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Starts an OAuth authorisation.
   *
   * ⚠ IT RETURNS A URL RATHER THAN REDIRECTING. The caller is a `fetch` from a
   * server action, not a browser following a link, and a 302 to a third party
   * from an XHR is either followed invisibly or blocked by CORS depending on
   * the browser. The console navigates deliberately.
   */
  app.post("/dns/connect/:provider", async (c) => {
    if (!d.dnsOAuth) return c.json(notWired("DNS connections"), 501)
    const { tenantId } = c.get("auth")
    const slug = c.req.param("provider")

    if (!writerFor(slug)) {
      return c.json(validation(`We cannot publish records at ${slug} yet.`), 422)
    }

    /*
     * ⚠ WHERE TO GO AFTERWARDS, AND IT IS THE CALLER'S TO NAME BECAUSE ONLY THE
     * CALLER KNOWS. The same button is pressed from onboarding, from the add
     * form and from a domain page, and each of them is somewhere different to
     * come back to — onboarding in particular was LOSING people, because the
     * callback lands in the console shell and the flow they were half-way
     * through is not there.
     *
     * ⚠ AND IT IS SANITISED WHERE IT IS SIGNED, NOT HERE. `dnsOAuth.start`
     * refuses anything that is not a path on this origin; passing it through
     * untouched keeps one rule in one place rather than two that can drift.
     */
    const body = await readJson(c)
    const returnTo = typeof body?.return_to === "string" ? body.return_to : undefined

    try {
      const start = d.dnsOAuth.start({
        slug,
        tenantId,
        ...(returnTo ? { returnTo } : {}),
      })
      return c.json({ url: start.url })
    } catch (error) {
      if (error instanceof OAuthError) {
        /*
         * ⚠ 501, NOT 422, FOR AN UNREGISTERED APP. It is our configuration and
         * not the customer's request, and it will never clear by retrying —
         * the console renders it as "paste a token instead" rather than as an
         * error against their account.
         */
        return c.json(
          {
            statusCode: 501,
            name: "internal_server_error" as const,
            message: error.message,
          },
          501,
        )
      }
      throw error
    }
  })

  /**
   * Finishes an OAuth authorisation.
   *
   * ⚠ THE TENANT COMES FROM THE SIGNED `state`, NOT FROM THE SESSION, AND THAT
   * IS THE SECURITY PROPERTY OF THIS ROUTE. A callback is a plain browser
   * navigation; if the workspace were taken from whoever happens to be signed
   * in, anybody could complete an authorisation they started elsewhere against
   * a workspace they are merely a member of — or trick somebody into attaching
   * an attacker's DNS credential to their own. The HMAC over the tenant is what
   * makes the two the same workspace. See dns/oauth.ts.
   *
   * ⚠ AND IT IS STILL SESSION-AUTHENTICATED, because `state` proves which
   * workspace began the flow and not that the person finishing it may act for
   * it. Both checks, and they answer different questions.
   */
  app.post("/dns/callback/:provider", async (c) => {
    if (!d.dnsOAuth || !d.dnsConnections)
      return c.json(notWired("DNS connections"), 501)

    const { tenantId } = c.get("auth")
    const slug = c.req.param("provider")
    const body = await readJson(c)
    const code = typeof body?.code === "string" ? body.code : ""
    const state = typeof body?.state === "string" ? body.state : ""

    if (!code || !state)
      return c.json(validation("`code` and `state` are required."), 422)

    let claimed: { slug: string; tenantId: string; verifier: string; returnTo?: string }
    try {
      claimed = d.dnsOAuth.verifyState(state)
    } catch (error) {
      return c.json(
        validation(error instanceof OAuthError ? error.message : "Bad state."),
        422,
      )
    }

    /*
     * ⚠ BOTH HALVES ARE COMPARED. A state signed for another workspace, or for
     * another provider, is a valid signature over the wrong thing — which is
     * precisely the attack the signature exists to stop, and checking only that
     * it verifies would let it through.
     */
    if (claimed.tenantId !== tenantId || claimed.slug !== slug) {
      return c.json(
        validation("That authorisation was started by a different workspace."),
        422,
      )
    }

    const writer = writerFor(slug)
    if (!writer) return c.json(validation(`We cannot publish records at ${slug}.`), 422)

    try {
      const grant = await d.dnsOAuth.exchange({
        slug,
        code,
        verifier: claimed.verifier,
      })

      /*
       * ⚠ THE ZONES ARE READ BEFORE THE CONNECTION IS SAVED, so a credential
       * that parses but cannot do anything never becomes a connection the
       * console reports as working. This is the moment the wrong Hetzner
       * product, a missing DigitalOcean scope or a Cloudflare token for a zone
       * they no longer own turns into a sentence in the dialog they are looking
       * at rather than a failure three screens later.
       */
      const credential = {
        accessToken: grant.accessToken,
        ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
        ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      }
      const zones = await writer.zones(credential)

      const saved = await d.dnsConnections.save({
        tenantId,
        provider: slug,
        /*
         * ⚠ NOT `grant.scopes`. `label` is "what the customer called it" and is
         * rendered as the connection's name, so putting the granted scope
         * string there made every OAuth connection display as
         * "dns.write zone.read offline_access". An authorisation supplies no
         * name, and `null` is the honest answer — the console already shows the
         * provider and the zones it reached.
         */
        label: null,
        credential,
        zones: zones.map((z) => z.name),
      })

      // ⚠ THE RETURN PATH COMES BACK WITH THE CONNECTION, so the callback page
      // can finish the job and then put somebody back where they started. It
      // came out of the signed `state` and was re-checked there.
      return c.json(
        { ...saved, ...(claimed.returnTo ? { return_to: claimed.returnTo } : {}) },
        201,
      )
    } catch (error) {
      /*
       * ⚠ `detail` IS THE ONLY FIELD THAT SAYS WHAT ACTUALLY HAPPENED, AND IT
       * WAS BEING THROWN AWAY. `String(error)` renders an `OAuthError` as its
       * `message`, which is the sentence written for the customer — "Cloudflare
       * did not complete the authorisation." — and is identical for an expired
       * code, a rejected client secret, a PKCE mismatch and a WAF page. The
       * provider's own `error` / `error_description`, which distinguishes all
       * four, is carried on `detail` and appeared nowhere: not in the log, not
       * in the response. A failure that reproduces only from inside the cluster
       * is exactly the failure this field exists for, and debugging one without
       * it means replaying an authorization code by hand.
       */
      const detail = error instanceof OAuthError ? error.detail : undefined
      /*
       * ⚠ LOGGED, NEVER RETURNED. `detail` is a sentence for the administrator
       * standing in front of the failure; this is the page the provider
       * actually served, and it is the thing that ends an argument about what
       * happened rather than starting one. It exists only when the body was not
       * JSON — see `transcript` in dns/oauth.ts for why that makes it safe.
       */
      const evidence = error instanceof OAuthError ? error.evidence : undefined
      d.log.warn(
        {
          err: String(error),
          ...(detail ? { detail } : {}),
          ...(evidence ? { evidence } : {}),
          kind: error instanceof OAuthError ? error.kind : "unknown",
          tenantId,
          provider: slug,
        },
        "dns oauth callback failed",
      )
      return c.json(
        {
          statusCode: 502,
          name: "internal_server_error" as const,
          /*
           * ⚠ ONLY AN `OAuthError`'S MESSAGE IS SAFE TO RETURN, AND `instanceof
           * Error` WAS NOT A NEAR-MISS — IT PUBLISHED A CREDENTIAL. Those
           * messages are written for a customer to read. Every OTHER Error
           * reaching here is internal, and drizzle's in particular embeds the
           * full failing statement WITH ITS PARAMETERS — which for this insert
           * means the sealed credential, the tenant id and the customer's zone
           * names, rendered in the browser on the callback page.
           *
           * ⚠ THE CAUSE STILL GOES TO THE LOG, one line above. Nothing is lost
           * for whoever has to diagnose it; what is lost is the copy that was
           * being handed to the browser.
           */
          message:
            error instanceof OAuthError
              ? error.message
              : "Could not complete the connection.",
          /*
           * ⚠ RETURNED, BECAUSE THE PERSON LOOKING AT IT IS THE ONE WHO CAN ACT
           * ON IT. This is a workspace administrator who just authorised their
           * own DNS account thirty seconds ago; "invalid_grant" or "the redirect
           * URI does not match" tells them whether to press the button again or
           * to tell us. It carries no credential — it is the provider's own
           * error string — and the alternative is a support conversation that
           * starts with no information at all.
           */
          ...(detail ? { detail } : {}),
        },
        502,
      )
    }
  })

  /**
   * Connecting with a token the customer pasted.
   *
   * ⚠ THE PATH MOST PROVIDERS ONLY HAVE. Twenty-nine of the thirty-two
   * providers in the registry with an API offer no third-party OAuth at all, so
   * treating the pasted token as a fallback rather than a first-class route
   * would leave most customers with nothing.
   *
   * ⚠ AND THE TOKEN IS PROVED BEFORE IT IS STORED, for the same reason the
   * OAuth path proves it. A stored credential that has never worked is a
   * connection the console shows as healthy and every publish fails against.
   */
  app.post("/dns/connections/:provider/token", async (c) => {
    if (!d.dnsConnections) return c.json(notWired("DNS connections"), 501)

    const { tenantId } = c.get("auth")
    const slug = c.req.param("provider")
    const body = await readJson(c)
    const token = typeof body?.token === "string" ? body.token.trim() : ""
    const label = typeof body?.label === "string" ? body.label.slice(0, 120) : null

    if (!token) return c.json(validation("`token` is required."), 422)

    const writer = writerFor(slug)
    if (!writer) {
      return c.json(validation(`We cannot publish records at ${slug} yet.`), 422)
    }

    try {
      const credential = { token }
      const zones = await writer.zones(credential)

      if (zones.length === 0) {
        /*
         * ⚠ A CREDENTIAL THAT REACHES NO ZONES IS REFUSED RATHER THAN STORED.
         * It is almost always the wrong kind of token — a Hetzner Cloud token
         * instead of a DNS Console one is the documented example — and storing
         * it produces a connection that looks fine and can publish nothing.
         */
        return c.json(
          validation(
            "That token works but can see no zones. Check it was created in " +
              "the DNS product rather than elsewhere in the account.",
          ),
          422,
        )
      }

      const saved = await d.dnsConnections.save({
        tenantId,
        provider: slug,
        label,
        credential,
        zones: zones.map((z) => z.name),
      })
      return c.json(saved, 201)
    } catch (error) {
      d.log.warn(
        { err: String(error), tenantId, provider: slug },
        "dns token connection failed",
      )
      return c.json(
        validation(
          error instanceof Error ? error.message : "That token was not accepted.",
        ),
        422,
      )
    }
  })
}
