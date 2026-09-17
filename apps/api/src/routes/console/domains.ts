import type { Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import {
  notFound,
  notWired,
  readJson,
  validation,
} from "./http.js"

/**
 * Sending domains, and the live DNS behind them.
 *
 * ⚠ EVERY WRITE GOES THROUGH `DomainStore`, WHICH IS THE ONLY PLACE A PLAN'S
 * DOMAIN LIMIT IS ENFORCED. A console path that wrote `core.domains` itself
 * would be a second implementation of that limit, and the console is exactly
 * where somebody would notice it was missing last.
 */
export function mountDomains(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Domains
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/domains", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.domains.list(tenantId) })
  })

  app.post("/domains", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    const name = typeof body?.name === "string" ? body.name : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    const created = await d.domains.create(tenantId, {
      name,
      ...(typeof body?.custom_return_path === "string"
        ? { custom_return_path: body.custom_return_path }
        : {}),
      ...(typeof body?.delegated === "boolean" ? { delegated: body.delegated } : {}),
    })

    switch (created.status) {
      case "created":
        return c.json(created.domain, 201)
      case "rejected":
        return c.json(validation(created.reason), 422)
      case "conflict":
        return c.json(
          {
            statusCode: 409,
            name: "domain_already_exists" as const,
            message: created.reason,
          },
          409,
        )
      default:
        // ⚠ 403 AND A MACHINE-READABLE NAME, BECAUSE THE CONSOLE TURNS THIS ONE
        // INTO AN UPGRADE PROMPT RATHER THAN AN ERROR TOAST. A plan limit is the
        // one refusal on this surface that has a button attached to it.
        return c.json(
          {
            statusCode: 403,
            name: "plan_limit_exceeded" as const,
            message: created.reason,
          },
          403,
        )
    }
  })

  app.get("/domains/:id", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const domain = await d.domains.get(tenantId, c.req.param("id"))
    return domain ? c.json(domain) : c.json(notFound("No domain with that id."), 404)
  })

  app.post("/domains/:id/verify", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const domain = await d.domains.verify(tenantId, c.req.param("id"))
    return domain ? c.json(domain) : c.json(notFound("No domain with that id."), 404)
  })

  app.delete("/domains/:id", async (c) => {
    if (!d.domains) return c.json(notWired("Domains"), 501)
    const { tenantId } = c.get("auth")
    const removed = await d.domains.remove(tenantId, c.req.param("id"))
    return removed
      ? c.json({ object: "domain", id: c.req.param("id"), deleted: true })
      : c.json(notFound("No domain with that id."), 404)
  })

  /**
   * Live DNS for a domain: who hosts it, and what we can currently see.
   *
   * ⚠ IT TAKES A NAME RATHER THAN AN ID, BECAUSE IT IS USED *BEFORE* THE DOMAIN
   * EXISTS. The onboarding flow asks "who is your DNS provider" while the
   * person is still typing the apex, so requiring a `core.domains` row first
   * would mean creating one to find out we cannot help with it — and then
   * having to delete it.
   */
  app.get("/dns/lookup", async (c) => {
    if (!d.dns) return c.json(notWired("DNS lookups"), 501)
    const name = (c.req.query("domain") ?? "").trim().toLowerCase()
    if (!name) return c.json(validation("`domain` is required."), 422)

    try {
      return c.json(await d.dns.inspect(name))
    } catch (error) {
      d.log.warn({ err: String(error), domain: name }, "dns lookup failed")
      /*
       * ⚠ 200 WITH AN `unknown` PROVIDER, NOT A 5xx. A failed NS lookup is an
       * ordinary outcome of typing a domain that does not exist yet — which is
       * most of what happens in an onboarding form. Answering with an error
       * status makes the console render a red box while somebody is still
       * halfway through typing.
       */
      return c.json({
        domain: name,
        nameservers: [],
        provider: null,
        records: {},
        error: "lookup_failed",
      })
    }
  })
}
