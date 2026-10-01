import { CATEGORY_TEXT, type Category } from "../../risk/types.js"
import type { Hono } from "hono"
import type { ConsoleDeps } from "./deps.js"
import { removalRefusal, suppressionsCsv } from "../../suppressions/store.js"
import {
  asId,
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
   * SES's sending status for the workspace (#157) and its open reputation
   * findings (#158), for the banner.
   *
   * ⚠ ALWAYS 200, AND `enabled` WHEN NOTHING IS KNOWN. The banner is advisory;
   * a missing store or no row must never paint a pause that did not happen.
   */
  app.get("/sending-status", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json(await sendingStatus(d, tenantId))
  })

  /*
   * The overview's sending-health card (#158): the status above plus the
   * workspace's own seven-day rates.
   *
   * ⚠ A SEPARATE ROUTE FROM THE BANNER'S, BECAUSE THE BANNER IS ON EVERY PAGE.
   * The rates are a scan of a week of `message_events`; paying for it on every
   * navigation to show a card on one page would be the wrong trade.
   *
   * ⚠ RATES ARE NULL, NOT ZERO, WITH NOTHING SENT. 0% of nothing reads as a
   * clean record the workspace has not earned.
   */
  app.get("/sending-health", async (c) => {
    const { tenantId } = c.get("auth")
    const [status, counts] = await Promise.all([
      sendingStatus(d, tenantId),
      d.sesReputation?.counts(tenantId, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
    ])
    const sends = counts?.sends ?? 0
    const rate = (n: number) => (sends > 0 ? n / sends : null)
    return c.json({
      ...status,
      window_days: 7,
      sends,
      hard_bounces: counts?.hardBounces ?? 0,
      soft_bounces: counts?.softBounces ?? 0,
      complaints: counts?.complaints ?? 0,
      bounce_rate: rate(counts?.hardBounces ?? 0),
      soft_bounce_rate: rate(counts?.softBounces ?? 0),
      complaint_rate: rate(counts?.complaints ?? 0),
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
      ...(asId(q.api_key_id) ? { apiKeyId: asId(q.api_key_id)! } : {}),
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
        ...(q.reason && SUPPRESSION_REASONS.has(q.reason) ? { reason: q.reason } : {}),
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
        ...(q.search ? { search: q.search.slice(0, 200) } : {}),
        ...(q.method && /^[A-Za-z]{3,7}$/.test(q.method) ? { method: q.method } : {}),
        ...(asId(q.api_key_id) ? { apiKeyId: asId(q.api_key_id)! } : {}),
        ...(parseDate(q.from) ? { from: parseDate(q.from)! } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })
}

/** The reasons a suppression can carry; anything else filters to nothing. */
const SUPPRESSION_REASONS = new Set([
  "hard_bounce",
  "complaint",
  "manual",
  "unsubscribe",
])

/**
 * `paused` when SES stopped the workspace, `at_risk` while any reputation
 * finding is open, `healthy` otherwise (#158).
 *
 * ⚠ THE CUSTOMER'S VIEW IS THREE WORDS AND SES'S OWN SENTENCE. Impact levels,
 * policies and finding types are ours to act on; what the customer needs is
 * whether mail is flowing and what to fix.
 */
export async function sendingStatus(d: ConsoleDeps, tenantId: string) {
  const [current, findings, hold] = await Promise.all([
    d.sesStatus?.current(tenantId),
    d.sesReputation?.openFindings(tenantId),
    d.holds?.current(tenantId).catch(() => null),
  ])
  const status = current?.status ?? "enabled"
  const open = findings ?? []
  return {
    status,
    cause: current?.cause ?? null,
    changed_at: current?.changedAt.toISOString() ?? null,
    /*
     * ⚠ A HOLD OUTRANKS EVERYTHING: it is the one state in which the API
     * refuses mail for a reason the customer cannot fix alone. The category is
     * the customer's sentence; the staff reason never leaves the server.
     */
    health: hold
      ? "held"
      : status === "disabled"
        ? "paused"
        : open.length > 0
          ? "at_risk"
          : "healthy",
    hold: hold
      ? {
          why: CATEGORY_TEXT[hold.category as Category] ?? "unusual sending activity",
          held_at: hold.heldAt.toISOString(),
          canceled_messages: hold.canceledMessages,
        }
      : null,
    findings: open.map((f) => ({
      type: f.type,
      impact: f.impact,
      description: f.description,
      opened_at: f.openedAt.toISOString(),
    })),
  }
}
