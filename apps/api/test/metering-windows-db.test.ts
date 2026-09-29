import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { postgresMetering } from "../src/metering/service.js"

/**
 * Free limits start on the first send, and plan changes never carry usage into
 * a free window - against the real schema, as `i10_api`, with the trigger that
 * moves `plan_since` (0077-0080).
 *
 *   METERING_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/storage_scratch bun test test/metering-windows-db.test.ts
 */
const URL = process.env.METERING_TEST_DATABASE_URL
const API_URL =
  process.env.METERING_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database
const T = crypto.randomUUID()
const H = 3_600_000
let clock = Date.now()

const metering = () =>
  postgresMetering({
    db,
    featureId: "emails",
    freePlanId: "free",
    now: () => new Date(clock),
  })

async function sent(n: number, at = clock) {
  for (let i = 0; i < n; i++) {
    await owner`insert into core.meter_events (tenant_id, feature_id, event_id, occurred_at, value)
                values (${T}, 'emails', ${crypto.randomUUID()}, ${new Date(at).toISOString()}, 1)`
  }
}

suite("first-send windows and plan changes, against Postgres as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
    db = drizzle(app, { schema }) as unknown as Database
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${T}, ${`m-${T.slice(0, 8)}`}, 'T', ${`metering-test-${T}`})`
    // Anchored long ago, on free since then.
    await owner`insert into core.plan_assignments (tenant_id, plan_id, anchor, plan_since)
                values (${T}, 'free', now() - interval '90 days', now() - interval '90 days')`
  })

  afterAll(async () => {
    await owner`delete from core.tenants where id = ${T}`.catch(() => {})
    await owner?.end()
    await app?.end()
  })

  it("the boundary burst: 100 sent, then refused a few minutes later for 24h from the first send", async () => {
    await sent(100, clock - 23.9 * H)
    const q = await metering().checkQuota(T, 1)
    expect(q.status).toBe("exceeded")
    expect((q as { resetsAt: Date }).resetsAt.getTime()).toBeCloseTo(
      clock + 0.1 * H,
      -3,
    )

    // A minute past that window's end, nothing sent since: a fresh window.
    clock += 0.12 * H
    expect((await metering().checkQuota(T, 100)).status).toBe("allowed")
  })

  it("Pro to Free: Pro's sends do not count against the free day or month", async () => {
    await owner`update core.plan_assignments set plan_id = 'pro' where tenant_id = ${T}`
    await sent(400)
    // The downgrade lands; the trigger moves plan_since.
    clock += 60_000
    await owner`update core.plan_assignments set plan_id = 'free', plan_since = now() - interval '10 years' where tenant_id = ${T}`
    const [row] =
      await owner`select plan_since from core.plan_assignments where tenant_id = ${T}`
    expect(Date.now() - new Date(row!.plan_since).getTime()).toBeLessThan(60_000)

    // plan_since is "now" on the DB clock; move the test clock past it.
    clock = Date.now() + 1_000
    expect((await metering().checkQuota(T, 100)).status).toBe("allowed")
  })

  it("re-granting the plan already held does not move plan_since (a webhook replay)", async () => {
    const [before] =
      await owner`select plan_since from core.plan_assignments where tenant_id = ${T}`
    await owner`update core.plan_assignments set plan_id = 'free', updated_at = now() where tenant_id = ${T}`
    const [after] =
      await owner`select plan_since from core.plan_assignments where tenant_id = ${T}`
    expect(new Date(after!.plan_since).getTime()).toBe(
      new Date(before!.plan_since).getTime(),
    )
  })
})
