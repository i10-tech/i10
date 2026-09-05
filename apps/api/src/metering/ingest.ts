import { sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import type { PolarClient, UsageIngestEvent } from "../billing/polar.js"

/**
 * Getting usage into Polar's meter.
 *
 * ⚠ EVERY UNIT IS SENT, NOT ONLY THE ONES PAST THE ALLOWANCE, AND THAT IS THE
 * WHOLE REASON THIS FILE IS SHORT. The obvious design is to compute the
 * included/billable split ourselves and ship only the billable part — and it is
 * wrong twice over. Polar's Meter Credits benefit already draws the included
 * allowance down before the metered price charges anything, so splitting here
 * would be a second implementation of arithmetic they own; and it would mean a
 * customer who turns overage on next month has a meter that never saw the
 * usage before it. We supply the count. They decide what it costs.
 *
 * ⚠ AND IT IS OFF THE SEND PATH, WHICH IS THE POINT OF THE LEDGER. `recordSent`
 * writes a row and returns. This walks those rows later, in batches, and can
 * fail and retry without a customer ever waiting on it.
 */

/**
 * ⚠ HOW MANY UNITS ONE PASS SHIPS. It bounds a single Polar request and the
 * transaction that marks the rows, not the backlog — a larger backlog is drained
 * over more passes rather than in one request big enough to time out halfway and
 * leave us unsure whether it landed.
 */
export const INGEST_LIMIT = 500

/**
 * The oldest un-ingested usage, across every tenant.
 *
 * ⚠ THROUGH A SECURITY DEFINER FUNCTION, because the flush holds no tenant
 * context and the question spans all of them. See 0019 for what it returns and
 * what it deliberately does not.
 */
export const unshippedStatement = (featureId: string, limit: number): SQL => sql`
  select tenant_id::text as tenant_id, event_id, occurred_at, value
    from core.unshipped_meter_events(${featureId}, ${limit})
`

/**
 * ⚠ SCOPED TO ONE TENANT AND TO THE EXACT IDS THAT WERE SENT. A bulk "mark
 * everything older than X" would sweep up rows that arrived during the request
 * and were never in it — under-billing, invisibly, with no row left un-shipped
 * to notice.
 */
export const markShippedStatement = (
  tenantId: string,
  featureId: string,
  eventIds: readonly string[],
): SQL => sql`
  update core.meter_events
     set ingested_at = now()
   where tenant_id  = ${tenantId}::uuid
     and feature_id = ${featureId}
     and event_id   = any(${eventIds}::text[])
     and ingested_at is null
`

export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

export interface FlushDeps {
  db: Database
  polar: PolarClient
  /** The metered feature to drain. `emails`. */
  featureId: string
  /** ⚠ Must match what the Polar meter filters on, or it aggregates nothing. */
  eventName: string
  limit?: number
  log?: Logger
}

export interface FlushReport {
  /** Units Polar accepted as new. */
  shipped: number
  /** Units Polar had already seen. Normal on a retry; not a failure. */
  duplicates: number
  /** ⚠ A full batch means there is more to come — run again. */
  batchWasFull: boolean
}

export async function flushUsage({
  db,
  polar,
  featureId,
  eventName,
  limit = INGEST_LIMIT,
  log,
}: FlushDeps): Promise<FlushReport> {
  const rows = (await db.execute(unshippedStatement(featureId, limit))) as unknown as {
    tenant_id: string
    event_id: string
    occurred_at: string | Date
    value: string | number
  }[]

  if (rows.length === 0) return { shipped: 0, duplicates: 0, batchWasFull: false }

  const events: UsageIngestEvent[] = rows.map((row) => ({
    name: eventName,
    externalId: String(row.event_id),
    tenantId: String(row.tenant_id),
    at: new Date(row.occurred_at),
    units: Number(row.value),
  }))

  // ⚠ POLAR FIRST, THE WATERMARK SECOND, AND NEVER THE OTHER WAY ROUND. If this
  // throws, nothing is marked and the next pass finds the same rows. If it
  // succeeds and the marking below fails, the next pass re-sends them and Polar
  // answers `duplicates` — which costs a request and bills nobody twice. Only
  // one of those two orders can lose revenue.
  const result = await polar.ingestEvents(events)

  const byTenant = new Map<string, string[]>()
  for (const event of events) {
    const ids = byTenant.get(event.tenantId)
    if (ids) ids.push(event.externalId)
    else byTenant.set(event.tenantId, [event.externalId])
  }

  // ⚠ ONE TRANSACTION PER TENANT, BECAUSE ROW LEVEL SECURITY IS PER TENANT.
  // The read above crosses tenants through a privileged function; the write
  // cannot, and should not — a bulk cross-tenant UPDATE is exactly the shape
  // that turns one bad id into everyone's problem.
  for (const [tenantId, eventIds] of byTenant) {
    try {
      await withTenant(db, tenantId, async (tx) =>
        tx.execute(markShippedStatement(tenantId, featureId, eventIds)),
      )
    } catch (error) {
      // The units are in Polar. Failing to record that costs a re-send, which
      // is free — so this is worth a line and not worth failing the pass.
      log?.error(
        { err: error, tenantId, count: eventIds.length },
        "usage reached polar but was not marked shipped — it will be re-sent",
      )
    }
  }

  log?.info(
    { featureId, ...result, tenants: byTenant.size },
    "usage ingested into polar",
  )

  return {
    shipped: result.inserted,
    duplicates: result.duplicates,
    batchWasFull: rows.length >= limit,
  }
}
