import { Hono } from "hono"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { requireTenant } from "../middleware/tenant.js"
import type { ConsoleDeps } from "./console/deps.js"
import { notWired } from "./console/http.js"
import { mountAccount } from "./console/account.js"
import { mountAudience } from "./console/audience.js"
import { mountCampaigns } from "./console/campaigns.js"
import { mountCredentials } from "./console/credentials.js"
import { mountDomains } from "./console/domains.js"
import { mountSending } from "./console/sending.js"

export type { ConsoleDeps }

/**
 * The console's own surface.
 *
 * ⚠ SESSION AUTHENTICATED, NEVER API-KEY AUTHENTICATED, AND THE `app.use("*")`
 * BELOW IS THE WHOLE GUARD. Every route here is reachable only through
 * `requireTenant`, which verifies a Clerk session and resolves it to a tenant.
 * An API key must not reach these: a sending key's advertised blast radius is
 * "can send mail", and rotating keys, reading invoices and connecting a DNS
 * provider are emphatically not that. A wildcard guard fails closed — a route
 * added in any of the six modules below is protected because nobody remembered
 * to protect it, which is the only version of this that stays correct.
 *
 * ⚠ AND IT IS OUTSIDE THE OPENAPI DOCUMENT, LIKE `/billing` AND `/webhooks`.
 * `/emails` and `/domains` are the product's API and belong in every generated
 * SDK; "list my invoices" is a dashboard action. Publishing it would put it in
 * the surface customers write code against, and then it would have to be
 * supported there forever.
 *
 * ⚠ MUTATIONS DELEGATE TO THE STORE THAT ALREADY OWNS THE RULE. Creating a
 * domain goes through `DomainStore`, which is the only place a plan's domain
 * limit is enforced; minting a key goes through `KeyStore`. A console path that
 * wrote `core.domains` itself would be a second implementation of the limit,
 * and the console is exactly where somebody would notice it was missing last.
 */

declare module "hono" {
  interface ContextVariableMap {
    /**
     * Set by the route-scoped body limit, read by the wildcard one.
     *
     * ⚠ IT MEANS "A LIMIT HAS ALREADY BEEN APPLIED", NOT "THIS IS THE IMPORT".
     * The wildcard stands down rather than wrapping an already-wrapped stream —
     * see the note in `createConsole` for why nesting two limits silently
     * enforces the smaller one.
     */
    bodyLimited?: boolean
  }
}

export function createConsole(deps?: ConsoleDeps) {
  const app = new Hono()

  if (!deps) {
    // ⚠ MOUNTED AND REFUSING, RATHER THAN NOT MOUNTED. A 404 here would read as
    // "the console is pointed at the wrong URL", which sends somebody looking
    // at ingress rules for a wiring problem in this process.
    app.all("*", (c) => c.json(notWired("Console routes"), 501))
    return app
  }

  const d = deps

  app.use("*", async (c, next) => {
    c.set("tenantAuth", {
      sessions: d.sessions,
      tenants: d.tenants,
      ...(d.activeOrg ? { activeOrg: d.activeOrg } : {}),
    })
    await next()
  })
  app.use("*", requireTenant)

  /*
   * ⚠ EVERY MUTATION HERE IS CAPPED, INCLUDING THE ONES THAT LOOK HARMLESS.
   * These routes are reached with a session rather than a key, so the caller is
   * a browser on somebody's laptop — but a signed-in caller is still an
   * authenticated caller, and `await c.req.json()` on a 500 MB body buffers the
   * whole thing in this process before a single line of validation runs. One
   * signed-in account could take the API down for every tenant on it.
   *
   * ⚠ THE LIMIT IS ENFORCED AS THE BODY STREAMS, WHICH IS THE PART THAT
   * MATTERS. Checking `Content-Length` is checking a claim: it is absent on a
   * chunked request and is not binding on any request. `bodyLimit` counts the
   * bytes actually read and aborts mid-stream, so the refusal costs 256 KB of
   * memory rather than however much the sender decided to send.
   *
   * ⚠ 256 KB IS GENEROUS FOR EVERYTHING EXCEPT THE CSV IMPORT. The largest
   * ordinary body on this surface is a broadcast's HTML; a contacts CSV is the
   * one route whose whole purpose is bulk, and it keeps the 20 MB it documents.
   *
   * ⚠ THE EXEMPTION IS A ROUTE-SCOPED `use()`, WHICH IS THE ONLY FORM THAT
   * SURVIVES BEING MOUNTED. Two obvious alternatives are both wrong here, and
   * both fail silently:
   *
   *   • `c.req.path.endsWith("/contacts/import")` reads the FULL path, prefix
   *     and all, so it also matches `/console/anything/contacts/import` — a
   *     path with no handler, which still runs wildcard middleware before
   *     answering 404, and would therefore read twenty megabytes before
   *     deciding it did not want them.
   *   • `except("/contacts/import", …)` from `hono/combine` matches its pattern
   *     against `c.req.path` too. Unmounted that is `/contacts/import` and it
   *     works; mounted at `/console` the real path is `/console/contacts/import`
   *     and the exemption stops matching — so the import silently drops to the
   *     256 KB limit, in production only, while a test against the bare router
   *     passes. `app.use(path, …)` is different: `app.route()` rewrites a
   *     sub-app's registered paths, so this one moves with the mount point.
   *
   * ⚠ AND THE TWO LIMITS MUST NOT NEST, WHICH IS WHAT THE FLAG IS FOR.
   * `bodyLimit` wraps the request stream, so a 256 KB wrapper around a 20 MB one
   * caps at 256 KB and the import breaks at exactly the size it is documented to
   * accept. The route-scoped limit is registered FIRST — Hono runs matching
   * middleware in registration order — and marks the request, and the wildcard
   * below stands down when it sees the mark.
   */
  const tooLarge = (c: Context) =>
    c.json(
      {
        statusCode: 413 as const,
        name: "validation_error" as const,
        message: "That request body is too large.",
      },
      413,
    )

  const jsonBodyLimit = bodyLimit({ maxSize: 256 * 1024, onError: tooLarge })
  const csvBodyLimit = bodyLimit({ maxSize: 20 * 1024 * 1024, onError: tooLarge })

  app.use("/contacts/import", async (c, next) => {
    c.set("bodyLimited", true)
    return csvBodyLimit(c, next)
  })
  app.use("*", async (c, next) =>
    c.get("bodyLimited") ? next() : jsonBodyLimit(c, next),
  )

  /*
   * ⚠ THE ROUTES ARE MOUNTED IN SIX GROUPS, AND THE SPLIT IS BY WHAT A CHANGE
   * TOUCHES RATHER THAN BY HTTP VERB. Sixty-three handlers in one file is a file
   * nobody reads to the end of — and the thing a reviewer most needs to be able
   * to see at a glance here is that every one of them is behind the guard above.
   * Each group is a plain function that takes the same `app`, so the ORDER and
   * the middleware chain are identical to one file; nothing is nested, and there
   * is no second router with its own lifecycle to reason about.
   */
  mountAccount(app, d)
  mountSending(app, d)
  mountDomains(app, d)
  mountCredentials(app, d)
  mountAudience(app, d)
  mountCampaigns(app, d)

  return app
}
