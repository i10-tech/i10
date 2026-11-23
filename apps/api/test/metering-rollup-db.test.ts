import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { MeterKey } from "@repo/metering"
import type { Database } from "../src/db/client.js"
import { meterEventStore } from "../src/metering/postgres.js"

/**
 * The gate's usage read through the hourly rollup (#507) gives the number that
 * summing the events gives, for every window shape, and the triggers keep the
 * rollup equal to the events through duplicates, deletes and concurrent writes.
 *
 *   METERING_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/metering-rollup-db.test.ts
 */
const URL = process.env.METERING_TEST_DATABASE_URL
const API_URL =
  process.env.METERING_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const T = crypto.randomUUID()
const KEY: MeterKey = { tenantId: T, featureId: "emails", shard: 0 }
const H = 3_600_000
// An hour boundary a few days back, so every window below is in the past.
const BASE = Math.floor(Date.now() / H) * H - 72 * H

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database

/** What the gate read before the rollup: every event in the window, summed. */
async function summed(start: number, end: number | null): Promise<number> {
  const [row] = await owner`
    select coalesce(sum(value), 0)::bigint as used from core.meter_events
     where tenant_id = ${T} and feature_id = 'emails' and shard = 0
       and occurred_at >= ${new Date(start).toISOString()}
       and (${end === null ? null : new Date(end).toISOString()}::timestamptz is null
            or occurred_at < ${end === null ? null : new Date(end).toISOString()}::timestamptz)`
  return Number(row!.used)
}

const read = (start: number, end: number | null) =>
  meterEventStore(db).usedIn(KEY, {
    start: new Date(start),
    end: end === null ? null : new Date(end),
  })

/**
 * ⚠ `.then(ok, err)`, NOT `expect(...).rejects`: under bun 1.4.2 `.rejects` on a
 * postgres.js query never settles and hangs the file.
 */
const failure = (query: PromiseLike<unknown>): Promise<string> =>
  Promise.resolve(query).then(
    () => "no error",
    (error: unknown) => String(error),
  )

async function rollupMatchesEvents(): Promise<void> {
  const [row] = await owner`
    select (select coalesce(sum(value), 0) from core.meter_events where tenant_id = ${T})::bigint as events,
           (select coalesce(sum(used), 0) from core.meter_usage_hourly where tenant_id = ${T})::bigint as rollup`
  expect(Number(row!.rollup)).toBe(Number(row!.events))
}

suite("usage read through the hourly rollup, against Postgres as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 8, onnotice: () => {}, prepare: false })
    db = drizzle({ client: app }) as unknown as Database
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${T}, ${`mr-${T.slice(0, 8)}`}, 'T', ${`metering-rollup-${T}`})`

    // Events on and around hour boundaries, a value above 1, across three days.
    const at = [
      BASE,
      BASE + 1,
      BASE + H - 1,
      BASE + H,
      BASE + 1.5 * H,
      BASE + 25 * H + 17,
      BASE + 47 * H + 59 * 60_000,
      BASE + 48 * H,
    ]
    await meterEventStore(db).record(
      KEY,
      at.map((ms, i) => ({ id: `m-${i}`, at: new Date(ms), value: i === 4 ? 3 : 1 })),
    )
  })

  afterAll(async () => {
    await owner`delete from core.tenants where id = ${T}`.catch(() => {})
    await owner?.end()
    await app?.end()
  })

  it("keeps the rollup equal to the events", async () => {
    await rollupMatchesEvents()
  })

  it("reads what summing the events reads, for every window shape", async () => {
    const windows: [number, number | null][] = [
      [BASE, BASE + 72 * H], // on the hour at both ends
      [BASE + 1, BASE + 48 * H], // a partial first hour
      [BASE + 30 * 60_000, BASE + 47 * H + 59 * 60_000 + 1], // partial at both ends
      [BASE + 10 * 60_000, BASE + 50 * 60_000], // inside one hour
      [BASE + 59 * 60_000, BASE + H + 60_000], // across one boundary, no whole hour
      [BASE + H, null], // lifetime, from an hour
      [BASE - 5, null], // lifetime, from before the first event
      [BASE + 48 * H, BASE + 48 * H], // empty
    ]
    for (const [start, end] of windows) {
      expect(await read(start, end)).toBe(await summed(start, end))
    }
  })

  it("adds nothing for a message id already recorded", async () => {
    const before = await read(BASE, null)
    const result = await meterEventStore(db).record(KEY, [
      { id: "m-0", at: new Date(BASE), value: 1 },
    ])
    expect(result.recorded).toBe(0)
    expect(await read(BASE, null)).toBe(before)
    await rollupMatchesEvents()
  })

  it("stays exact under concurrent records", async () => {
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        meterEventStore(db).record(KEY, [
          { id: `c-${i}-a`, at: new Date(BASE + 2 * H + i), value: 1 },
          { id: `c-${i}-b`, at: new Date(BASE + 3 * H - 1 - i), value: 2 },
        ]),
      ),
    )
    await rollupMatchesEvents()
    expect(await read(BASE + 2 * H, BASE + 3 * H)).toBe(72)
  })

  it("takes deleted events off the rollup", async () => {
    await owner`delete from core.meter_events where tenant_id = ${T} and event_id like 'c-%-b'`
    await rollupMatchesEvents()
    expect(await read(BASE + 2 * H, BASE + 3 * H)).toBe(24)
  })

  it("refuses to move an event, and still lets the flush mark it shipped", async () => {
    expect(
      await failure(
        owner`update core.meter_events set occurred_at = occurred_at - interval '1 day'
               where tenant_id = ${T} and event_id = 'm-0'`,
      ),
    ).toMatch(/append-only/)
    await owner`update core.meter_events set ingested_at = now()
                 where tenant_id = ${T} and event_id = 'm-0'`
    await rollupMatchesEvents()
  })

  it("does not let the API write the rollup", async () => {
    const write = app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${T}, true)`
      await tx`insert into core.meter_usage_hourly (tenant_id, feature_id, shard, hour, slot, used)
               values (${T}, 'emails', 0, now(), 0, -1000)`
    })
    expect(await failure(write)).toMatch(/row-level security/)
  })
})
