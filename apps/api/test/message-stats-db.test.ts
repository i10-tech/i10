import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { consoleQueries, type DailyStat } from "../src/console/queries.js"

/**
 * The overview chart from the daily rollup (#507) answers what counting the
 * events answers: before the first refresh, after it, for events that arrive
 * late, and at the edges of a day.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/message-stats-db.test.ts
 *
 * ⚠ `core.message_daily_stats_state` is one row for the whole database, so this
 * file resets it and must not run beside another that refreshes the rollup.
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const DAY = 86_400_000
const T = crypto.randomUUID()
const OTHER = crypto.randomUUID()

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database

/** Midnight UTC, `n` days before today. */
const day = (n: number) => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - n * DAY
}

/** A version 7 uuid minted at `ms`, as `uuidv7()` would have minted it then. */
function uuidv7At(ms: number): string {
  const hex =
    ms.toString(16).padStart(12, "0") +
    "7" +
    crypto.randomUUID().replaceAll("-", "").slice(13)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function event(
  tenantId: string,
  type: string,
  at: number,
  id?: string,
): Promise<void> {
  const ts = new Date(at).toISOString()
  if (id) {
    await owner`insert into core.message_events (id, tenant_id, message_id, type, occurred_at)
                values (${id}, ${tenantId}, ${crypto.randomUUID()}, ${type}::core.message_event_type, ${ts})`
  } else {
    await owner`insert into core.message_events (tenant_id, message_id, type, occurred_at)
                values (${tenantId}, ${crypto.randomUUID()}, ${type}::core.message_event_type, ${ts})`
  }
}

/**
 * What the chart showed before the rollup: 20260917035548's body, counting
 * every day of the window from the events.
 */
async function counted(tenantId: string, days: number): Promise<DailyStat[]> {
  const rows = await owner<DailyStat[]>`
    select d.bucket::date::text as date,
           coalesce(e.sent, 0)::int as sent, coalesce(e.delivered, 0)::int as delivered,
           coalesce(e.bounced, 0)::int as bounced, coalesce(e.complained, 0)::int as complained,
           coalesce(e.delayed, 0)::int as delayed, coalesce(e.failed, 0)::int as failed
      from generate_series(date_trunc('day', now() - ${days - 1} * interval '1 day'),
                           date_trunc('day', now()), interval '1 day') d(bucket)
      left join (
        select date_trunc('day', me.occurred_at) as bucket,
               count(*) filter (where me.type = 'sent') as sent,
               count(*) filter (where me.type = 'delivered') as delivered,
               count(*) filter (where me.type = 'bounced') as bounced,
               count(*) filter (where me.type = 'complained') as complained,
               count(*) filter (where me.type = 'delivery_delayed') as delayed,
               count(*) filter (where me.type in ('failed', 'rejected')) as failed
          from core.message_events me
         where me.tenant_id = ${tenantId}
           and me.occurred_at >= date_trunc('day', now() - ${days - 1} * interval '1 day')
           and me.occurred_at < now() + interval '1 day'
         group by 1) e on e.bucket = d.bucket
     order by d.bucket`
  return rows.map((r) => ({ ...r }))
}

const chart = async (tenantId: string, days = 30) =>
  (await consoleQueries(db).overview(tenantId, days)).series

const refresh = async () => {
  const [row] = await app`select cells, pruned from core.refresh_message_daily_stats()`
  return { cells: Number(row!.cells), pruned: Number(row!.pruned) }
}

/**
 * ⚠ `.then(ok, err)`, NOT `expect(...).rejects`: under bun 1.4.2 `.rejects` on a
 * postgres.js query can never settle and hang the file.
 */
const failure = (query: PromiseLike<unknown>): Promise<string> =>
  Promise.resolve(query).then(
    () => "no error",
    (error: unknown) => String(error),
  )

const on = (series: { date: string }[], n: number) =>
  series.find((r) => r.date === new Date(day(n)).toISOString().slice(0, 10))

suite("console overview from the daily rollup", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle({ client: app }) as unknown as Database
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${T}, ${`ms-${T.slice(0, 8)}`}, 'T', ${`user-${T}`}),
                       (${OTHER}, ${`ms-${OTHER.slice(0, 8)}`}, 'O', ${`user-${OTHER}`})`
    await owner`delete from core.message_daily_stats_state`

    // The edges of yesterday, and today's first instant (read live).
    await event(T, "sent", day(1))
    await event(T, "delivered", day(0) - 1)
    await event(T, "bounced", day(0))
    // Every counted type, and one that is not.
    for (const type of [
      "complained",
      "delivery_delayed",
      "failed",
      "rejected",
      "opened",
      "sent",
    ])
      await event(T, type, day(5) + 3_600_000)
    // The window's first day counts in full; the day before it not at all.
    await event(T, "sent", day(29) + 1_000)
    await event(T, "sent", day(29) - 1)
    await event(OTHER, "sent", day(1) + 1_000)
  })

  afterAll(async () => {
    await owner`delete from core.message_events where tenant_id in (${T}, ${OTHER})`.catch(
      () => {},
    )
    await owner`delete from core.message_daily_stats where tenant_id in (${T}, ${OTHER})`.catch(
      () => {},
    )
    await owner`delete from core.tenants where id in (${T}, ${OTHER})`.catch(() => {})
    await owner?.end()
    await app?.end()
  })

  it("counts every day from the events before the first refresh", async () => {
    expect(await chart(T)).toEqual(await counted(T, 30))
  })

  it("answers the same from the rollup after a refresh, edge days included", async () => {
    expect((await refresh()).cells).toBeGreaterThan(0)
    const [rolled] = await owner`
      select count(*)::int as n from core.message_daily_stats where tenant_id = ${T}`
    // Today, yesterday, 5, 29 and 30 days ago. Today's cell is written too, but
    // the chart reads today from the events.
    expect(rolled!.n).toBe(5)

    for (const days of [1, 7, 30, 90]) {
      expect(await chart(T, days)).toEqual(await counted(T, days))
    }
    expect(on(await chart(T), 1)).toMatchObject({ sent: 1, delivered: 1 })
    expect(on(await chart(T), 0)).toMatchObject({ bounced: 1 })
    expect(on(await chart(T), 5)).toMatchObject({
      sent: 1,
      complained: 1,
      delayed: 1,
      failed: 2,
    })
    expect(on(await chart(T), 29)).toMatchObject({ sent: 1 })
  })

  it("puts a late event in its own day on the next refresh, and only then", async () => {
    await event(T, "complained", day(3) + 7_200_000)
    expect(on(await chart(T), 3)).toMatchObject({ complained: 0 })

    await refresh()
    expect(on(await chart(T), 3)).toMatchObject({ complained: 1 })
    expect(await chart(T)).toEqual(await counted(T, 30))
  })

  it("catches an event whose id was minted before the last refresh began", async () => {
    const [state] = await owner`select started_at from core.message_daily_stats_state`
    const minted = (state!.started_at as Date).getTime() - 30 * 60_000
    await event(T, "bounced", day(7) + 1_000, uuidv7At(minted))

    await refresh()
    expect(on(await chart(T), 7)).toMatchObject({ bounced: 1 })
    expect(await chart(T)).toEqual(await counted(T, 30))
  })

  it("changes nothing when run again with nothing new", async () => {
    await refresh()
    expect((await refresh()).cells).toBe(0)
  })

  it("never shows another workspace's counts, and the API cannot write the rollup", async () => {
    const before = await chart(T)
    expect(on(await chart(OTHER), 1)).toMatchObject({ sent: 1 })
    expect(before).toEqual(await counted(T, 30))

    const write = app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${T}, true)`
      await tx`insert into core.message_daily_stats
                 (tenant_id, day, sent, delivered, bounced, complained, delayed, failed)
               values (${T}, current_date - 60, 1, 0, 0, 0, 0, 0)`
    })
    expect(await failure(write)).toMatch(/row-level security/)
  })

  it("never lowers a day's counts when a late event arrives after retention", async () => {
    // Day 6: counted, then its events expire, then a late bounce for it.
    await event(T, "sent", day(6) + 1_000)
    await event(T, "complained", day(6) + 2_000)
    await refresh()
    await owner`delete from core.message_events
                 where tenant_id = ${T} and occurred_at >= ${new Date(day(6)).toISOString()}
                   and occurred_at < ${new Date(day(5)).toISOString()}`
    await event(T, "bounced", day(6) + 3_000)
    await refresh()
    expect(on(await chart(T), 6)).toMatchObject({ sent: 1, complained: 1, bounced: 1 })
  })

  it("skips the events of a workspace whose tenant row is gone, and still runs", async () => {
    const gone = crypto.randomUUID()
    await event(gone, "sent", day(2) + 1_000)
    expect((await refresh()).cells).toBeGreaterThanOrEqual(0)
    const rows =
      await owner`select 1 from core.message_daily_stats where tenant_id = ${gone}`
    expect(rows).toHaveLength(0)
    await owner`delete from core.message_events where tenant_id = ${gone}`
  })

  it("keeps a day's counts after retention deletes its events", async () => {
    await owner`delete from core.message_events
                 where tenant_id = ${T} and occurred_at >= ${new Date(day(5)).toISOString()}
                   and occurred_at < ${new Date(day(4)).toISOString()}`
    await refresh()
    expect(on(await chart(T), 5)).toMatchObject({ sent: 1, complained: 1 })
  })
})
