import type { WebhookEventName, WebhookStatsBucket } from "@repo/contracts"
import { sql, type SQL } from "drizzle-orm"
import type { withTenant } from "../db/client.js"

/**
 * Webhook stats over time (#300): deliveries and attempts in hour or day
 * steps, by event type, and by endpoint.
 *
 * ⚠ TWO CLOCKS, ON PURPOSE. A delivery is counted in the step it was created
 * in; an attempt in the step it was made in. "How many events did we send you
 * on Tuesday" and "how often did your server fail on Wednesday" are different
 * questions, and folding retries into the day the event happened would show a
 * Wednesday outage as a bad Tuesday.
 *
 * ⚠ THE ERROR RATE IS ATTEMPTS, NOT DELIVERIES. One delivery that took five
 * tries before succeeding is a 100% delivery rate and an 80% error rate, and
 * the second number is the one that says the receiver is in trouble.
 *
 * ⚠ ALIGNED TO UTC. `date_trunc` with an explicit zone, so a step is the same
 * hour or day whichever session asks; the console localises for display.
 */

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]
type Row = Record<string, unknown>

export type StatsBucket = "hour" | "day"

export interface StatsWindow {
  since: Date
  until: Date
  bucket: StatsBucket
}

/** The most steps one request may ask for. */
export const MAX_BUCKETS = 200

const STEP_MS: Record<StatsBucket, number> = { hour: 3_600_000, day: 86_400_000 }

/**
 * The window a request asked for, aligned and checked. Defaults: the last 24
 * hours in hours; a range longer than a week defaults to days.
 */
export function statsWindow(
  input: { since?: Date; until?: Date; bucket?: StatsBucket },
  now = new Date(),
): StatsWindow | { error: string } {
  const until = input.until ?? now
  const since = input.since ?? new Date(until.getTime() - STEP_MS.day)
  if (since >= until) return { error: "`since` must be before `until`." }
  const bucket =
    input.bucket ??
    (until.getTime() - since.getTime() > 7 * STEP_MS.day ? "day" : "hour")
  const aligned = new Date(
    Math.floor(since.getTime() / STEP_MS[bucket]) * STEP_MS[bucket],
  )
  const steps = Math.ceil((until.getTime() - aligned.getTime()) / STEP_MS[bucket])
  if (steps > MAX_BUCKETS)
    return {
      error: `That is ${steps} ${bucket}s; ask for at most ${MAX_BUCKETS}, or use a larger bucket.`,
    }
  return { since: aligned, until, bucket }
}

const int = (v: unknown) => Number(v ?? 0)
const ms = (v: unknown) =>
  v === null || v === undefined ? null : Math.round(Number(v))
const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as string | Date).toISOString()

export interface DeliveryCounts {
  delivered: number
  failed: number
  pending: number
}
export interface AttemptCounts {
  attempts: number
  failed_attempts: number
  p50_ms: number | null
  p95_ms: number | null
}

export const successRate = (c: DeliveryCounts): number | null =>
  c.delivered + c.failed > 0 ? c.delivered / (c.delivered + c.failed) : null

const deliveryCounts = (r: Row | undefined): DeliveryCounts => ({
  delivered: int(r?.delivered),
  failed: int(r?.failed),
  pending: int(r?.pending),
})
const attemptCounts = (r: Row | undefined): AttemptCounts => ({
  attempts: int(r?.attempts),
  failed_attempts: int(r?.failed_attempts),
  p50_ms: ms(r?.p50_ms),
  p95_ms: ms(r?.p95_ms),
})

const DELIVERY_COUNTS = sql`
  count(*) filter (where status = 'delivered')::int as delivered,
  count(*) filter (where status = 'failed')::int as failed,
  count(*) filter (where status = 'pending')::int as pending`

const ATTEMPT_COUNTS = sql`
  count(*)::int as attempts,
  count(*) filter (where error_kind is not null)::int as failed_attempts,
  percentile_cont(0.5) within group (order by duration_ms) as p50_ms,
  percentile_cont(0.95) within group (order by duration_ms) as p95_ms`

export interface StatsResult extends DeliveryCounts, AttemptCounts {
  series: WebhookStatsBucket[]
  by_event_type: Array<DeliveryCounts & { event_type: WebhookEventName }>
}

export type EndpointStatsRow = DeliveryCounts & {
  endpoint_id: string
  success_rate: number | null
  attempts: number
  failed_attempts: number
  last_success_at: string | null
}

/**
 * Every count for one window, inside the caller's tenant transaction (RLS
 * scopes it to the workspace). `endpointId` narrows it to one endpoint.
 */
export async function collectStats(
  tx: Tx,
  window: StatsWindow,
  endpointId?: string,
): Promise<StatsResult> {
  const { since, until, bucket } = window
  const inWindow = sql`created_at >= ${since.toISOString()}::timestamptz
                   and created_at < ${until.toISOString()}::timestamptz`
  const scope: SQL = endpointId ? sql`and endpoint_id = ${endpointId}::uuid` : sql``
  const step = sql.raw(`'${bucket}'`)

  const run = async (q: SQL) => (await tx.execute(q)) as unknown as Row[]
  const [deliveryTotals, attemptTotals, deliverySteps, attemptSteps, byType] =
    await Promise.all([
      run(sql`select ${DELIVERY_COUNTS} from core.webhook_deliveries
               where ${inWindow} ${scope}`),
      run(sql`select ${ATTEMPT_COUNTS} from core.webhook_attempts
               where ${inWindow} ${scope}`),
      run(sql`select date_trunc(${step}, created_at, 'UTC') as start, ${DELIVERY_COUNTS}
                from core.webhook_deliveries where ${inWindow} ${scope}
               group by 1`),
      run(sql`select date_trunc(${step}, created_at, 'UTC') as start, ${ATTEMPT_COUNTS}
                from core.webhook_attempts where ${inWindow} ${scope}
               group by 1`),
      run(sql`select event_type, ${DELIVERY_COUNTS} from core.webhook_deliveries
               where ${inWindow} ${scope}
               group by 1 order by count(*) desc, 1`),
    ])

  // ⚠ EVERY STEP, EMPTY ONES INCLUDED. A chart with the quiet hours missing
  // draws a line straight across an outage.
  const key = (v: unknown) => new Date(v as string | Date).getTime()
  const deliveriesAt = new Map(deliverySteps.map((r) => [key(r.start), r]))
  const attemptsAt = new Map(attemptSteps.map((r) => [key(r.start), r]))
  const series: WebhookStatsBucket[] = []
  for (let t = since.getTime(); t < until.getTime(); t += STEP_MS[bucket]) {
    series.push({
      start: new Date(t).toISOString(),
      ...deliveryCounts(deliveriesAt.get(t)),
      ...attemptCounts(attemptsAt.get(t)),
    })
  }

  return {
    ...deliveryCounts(deliveryTotals[0]),
    ...attemptCounts(attemptTotals[0]),
    series,
    by_event_type: byType.map((r) => ({
      event_type: r.event_type as WebhookEventName,
      ...deliveryCounts(r),
    })),
  }
}

/** One row per endpoint with any traffic in the window, for the workspace view. */
export async function collectByEndpoint(
  tx: Tx,
  window: StatsWindow,
): Promise<EndpointStatsRow[]> {
  const inWindow = sql`created_at >= ${window.since.toISOString()}::timestamptz
                   and created_at < ${window.until.toISOString()}::timestamptz`
  const rows = (await tx.execute(sql`
    select coalesce(d.endpoint_id, a.endpoint_id) as endpoint_id,
           d.delivered, d.failed, d.pending, d.last_success_at,
           a.attempts, a.failed_attempts
      from (select endpoint_id, ${DELIVERY_COUNTS},
                   max(delivered_at) as last_success_at
              from core.webhook_deliveries where ${inWindow}
             group by 1) d
      full join (select endpoint_id, count(*)::int as attempts,
                        count(*) filter (where error_kind is not null)::int as failed_attempts
                   from core.webhook_attempts where ${inWindow}
                  group by 1) a
        on a.endpoint_id = d.endpoint_id
     order by 1`)) as unknown as Row[]
  return rows.map((r) => {
    const counts = deliveryCounts(r)
    return {
      endpoint_id: String(r.endpoint_id),
      ...counts,
      success_rate: successRate(counts),
      attempts: int(r.attempts),
      failed_attempts: int(r.failed_attempts),
      last_success_at: iso(r.last_success_at),
    }
  })
}
