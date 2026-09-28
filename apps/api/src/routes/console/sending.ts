import type { Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { removalRefusal, suppressionsCsv } from "../../suppressions/store.js"
import {
  clampInt,
  notFound,
  notWired,
  parseDate,
  readJson,
  validation,
} from "./http.js"

/**
 * The mail itself: what was sent, what happened to it, and who is blocked.
 *
 * ⚠ EVERY LIST HERE IS CURSOR-PAGINATED AND NONE OF THEM COUNTS. `core.messages`
 * is partitioned; an OFFSET of forty thousand makes Postgres produce and discard
 * forty thousand rows, and a `count(*)` over the same predicate is the single
 * most expensive thing these endpoints could do to answer a question nobody
 * asked. See console/queries.ts.
 */
export function mountSending(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Overview
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/overview", async (c) => {
    const { tenantId } = c.get("auth")
    // ⚠ CLAMPED, BECAUSE THE WINDOW IS A `generate_series` AND AN UNBOUNDED ONE
    // IS A DENIAL OF SERVICE AGAINST OURSELVES. `?days=1000000` would ask
    // Postgres to synthesise a million rows and left-join a partitioned table
    // against every one of them.
    const days = clampInt(c.req.query("days"), 1, 90, 30)
    return c.json(await d.queries.overview(tenantId, days))
  })

  /*
   * SES's sending status for the workspace (#157), for the banner.
   *
   * ⚠ ALWAYS 200, AND `enabled` WHEN NOTHING IS KNOWN. The banner is advisory;
   * a missing store or no row must never paint a pause that did not happen.
   */
  app.get("/sending-status", async (c) => {
    const { tenantId } = c.get("auth")
    const current = await d.sesStatus?.current(tenantId)
    return c.json({
      status: current?.status ?? "enabled",
      cause: current?.cause ?? null,
      changed_at: current?.changedAt.toISOString() ?? null,
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Emails
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/emails", async (c) => {
    const { tenantId } = c.get("auth")
    const q = c.req.query()

    const page = await d.queries.listEmails(tenantId, {
      ...(q.status ? { status: q.status.split(",").filter(Boolean) } : {}),
      ...(q.domain_id ? { domainId: q.domain_id } : {}),
      ...(q.broadcast_id ? { broadcastId: q.broadcast_id } : {}),
      ...(q.search ? { search: q.search.slice(0, 200) } : {}),
      ...(parseDate(q.from) ? { from: parseDate(q.from)! } : {}),
      ...(parseDate(q.to) ? { to: parseDate(q.to)! } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    })

    return c.json(page)
  })

  app.get("/emails/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const detail = await d.queries.emailDetail(tenantId, c.req.param("id"))
    return detail ? c.json(detail) : c.json(notFound("No email with that id."), 404)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Suppressions
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/suppressions", async (c) => {
    const { tenantId } = c.get("auth")
    const store = d.suppressions
    if (!store) return c.json(notWired("Suppressions"), 501)
    const q = c.req.query()
    return c.json(
      await store.list(tenantId, {
        ...(q.search ? { search: q.search.slice(0, 200) } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })

  app.post("/suppressions", async (c) => {
    const { tenantId } = c.get("auth")
    const store = d.suppressions
    if (!store) return c.json(notWired("Suppressions"), 501)
    const body = await readJson(c)
    const address = typeof body?.address === "string" ? body.address.trim() : ""
    if (!address.includes("@")) return c.json(validation("`address` is required."), 422)

    await store.add(tenantId, address)
    return c.json({ address: address.toLowerCase(), suppressed: true }, 201)
  })

  app.delete("/suppressions/:address", async (c) => {
    const { tenantId } = c.get("auth")
    const store = d.suppressions
    if (!store) return c.json(notWired("Suppressions"), 501)
    /*
     * ⚠ NOT DECODED AGAIN - HONO HAS ALREADY DONE IT. An address in a path is
     * percent-encoded (`bob+news@acme.com` arrives as `bob%2Bnews@acme.com`),
     * and `c.req.param` decodes any segment containing a `%`. A second
     * `decodeURIComponent` is a no-op for almost every address and a THROWN
     * `URIError` for one that legitimately contains a percent sign: `a%b@c.com`
     * is sent as `a%25b@c.com`, comes back as `a%b@c.com`, and decoding that
     * again is a malformed-URI exception, i.e. a 500 on a valid request.
     */
    const address = c.req.param("address")
    const outcome = await store.remove(tenantId, address, {
      confirmComplaint: c.req.query("confirm") === "complaint",
    })
    if (outcome === "removed") return c.json({ address, deleted: true })
    const refusal = removalRefusal(outcome)
    return c.json(refusal.body, refusal.status)
  })

  /*
   * ⚠ A GET ON `/suppressions/:address` ADDED LATER WOULD HAVE TO BE
   * REGISTERED BELOW THIS ONE. Today `:address` is DELETE only, so nothing can
   * read `export.csv` as an address; a GET registered above this route would.
   */
  app.get("/suppressions/export.csv", async (c) => {
    const { tenantId } = c.get("auth")
    const store = d.suppressions
    if (!store) return c.json(notWired("Suppressions"), 501)
    const csv = suppressionsCsv(await store.exportAll(tenantId))
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="suppressions.csv"',
      "Cache-Control": "no-store",
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Request log
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/requests", async (c) => {
    const { tenantId } = c.get("auth")
    const q = c.req.query()
    return c.json(
      await d.queries.listRequests(tenantId, {
        ...(q.status === "ok" || q.status === "error" ? { status: q.status } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })
}
