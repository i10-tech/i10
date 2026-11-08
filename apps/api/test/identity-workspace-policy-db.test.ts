import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { assertRlsSubject, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { workspacePolicyStore } from "../src/identity/workspace-policy-store.js"

/**
 * The workspace policy store (#345) against a real database as `i10_api`: no
 * row is nothing set, a change and its audit row land together, the CHECK
 * constraints are the net under the routes' bounds, session activity is
 * per workspace and pruned, and RLS keeps one workspace out of another's.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/identity-workspace-policy-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const ada = `user_ada_${acme.slice(0, 8)}`

suite("#345 workspace policy store", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`w-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => workspacePolicyStore(database)
  const audit = (tenant: string, type: string) =>
    owner`select actor_user_id, data from identity.events where tenant_id = ${tenant} and type = ${type} order by created_at`

  it("keeps the boot check passing with the new table", async () => {
    await assertRlsSubject(db)
  })

  it("reads nothing set for a workspace with no row, and makes no row", async () => {
    expect(await store().policy(acme)).toEqual({
      maxSessionSeconds: null,
      idleTimeoutSeconds: null,
      requireSecondFactor: false,
      network: { console: false, apiKeys: false, ranges: [], grace: null },
    })
    const rows =
      await owner`select 1 from identity.workspace_settings where tenant_id = ${acme}`
    expect(rows).toHaveLength(0)
  })

  it("refuses values the database bounds forbid", async () => {
    for (const statement of [
      "insert into identity.workspace_settings (tenant_id, max_session_seconds) values ($1, 60)",
      "insert into identity.workspace_settings (tenant_id, idle_timeout_seconds) values ($1, 10)",
      "insert into identity.workspace_settings (tenant_id, ip_grace_user_id) values ($1, 'user_x')",
      "insert into identity.workspace_settings (tenant_id, ip_ranges) values ($1, array_fill('10.0.0.0/24'::text, array[101]))",
    ]) {
      // ⚠ NOT `expect(query).rejects`: under bun 1.4.2 it never settles on a
      // postgres.js query, and the whole file hangs.
      const error = await owner.unsafe(statement, [rival]).then(
        () => null,
        (e: unknown) => e,
      )
      expect(String(error)).toContain("violates check constraint")
    }
  })

  it("writes each kind of change with its audit row, before and after", async () => {
    const s = store()
    const grace = {
      userId: ada,
      address: "203.0.113.7",
      until: new Date(Date.now() + 600_000),
    }
    await s.update(acme, ada, {
      kind: "session",
      maxSessionSeconds: 3600,
      idleTimeoutSeconds: 900,
    })
    await s.update(acme, ada, { kind: "second_factor", required: true })
    const done = await s.update(acme, ada, {
      kind: "network",
      console: true,
      apiKeys: true,
      ranges: ["198.51.100.0/24"],
      grace,
      lockoutConfirmed: true,
    })
    expect(done.before.network.ranges).toEqual([])
    expect(done.after).toMatchObject({
      maxSessionSeconds: 3600,
      idleTimeoutSeconds: 900,
      requireSecondFactor: true,
      network: { console: true, apiKeys: true, ranges: ["198.51.100.0/24"] },
    })
    expect(done.after.network.grace).toMatchObject({
      userId: ada,
      address: "203.0.113.7",
    })
    expect((await s.policy(acme)).network.grace?.until.getTime()).toBe(
      grace.until.getTime(),
    )
    const [net] = await audit(acme, "ip_allowlist.updated")
    expect(net!.actor_user_id).toBe(ada)
    expect(net!.data).toMatchObject({
      before: { console: false, ranges: [] },
      after: { console: true, ranges: ["198.51.100.0/24"] },
      lockoutConfirmed: true,
    })
    expect(await audit(acme, "session_policy.updated")).toHaveLength(1)
    expect(await audit(acme, "second_factor_policy.updated")).toHaveLength(1)
    // Clearing the grace clears all three columns together.
    await s.update(acme, ada, {
      kind: "network",
      console: false,
      apiKeys: false,
      ranges: [],
      grace: null,
      lockoutConfirmed: false,
    })
    expect((await s.policy(acme)).network.grace).toBeNull()
  })

  it("keeps one workspace's policy and sessions out of another's", async () => {
    const s = store()
    expect((await s.policy(rival)).maxSessionSeconds).toBeNull()
    await s.startActivity(acme, {
      sessionId: "sess_a",
      clerkUserId: ada,
      startedAt: new Date(Date.now() - 1000),
      now: new Date(),
    })
    expect((await s.sessionFacts(rival, "sess_a")).activity).toBeNull()
    expect((await s.sessionFacts(acme, "sess_a")).activity).not.toBeNull()
  })

  it("makes an activity row once, keeps its start, touches and revokes it once", async () => {
    const s = store()
    const started = new Date(Date.now() - 3_600_000)
    const first = await s.startActivity(acme, {
      sessionId: "sess_b",
      clerkUserId: ada,
      startedAt: started,
      now: new Date(),
    })
    const again = await s.startActivity(acme, {
      sessionId: "sess_b",
      clerkUserId: ada,
      startedAt: new Date(),
      now: new Date(),
    })
    expect(again.startedAt.getTime()).toBe(first.startedAt.getTime())
    expect(first.startedAt.getTime()).toBe(started.getTime())
    const later = new Date(Date.now() + 60_000)
    await s.touchActivity(acme, "sess_b", later)
    expect((await s.sessionFacts(acme, "sess_b")).activity?.lastSeenAt.getTime()).toBe(
      later.getTime(),
    )
    expect(await s.revokeActivity(acme, "sess_b", "idle", new Date())).toBe(true)
    expect(await s.revokeActivity(acme, "sess_b", "idle", new Date())).toBe(false)
    expect((await s.sessionFacts(acme, "sess_b")).revoked).toBe(true)
    // A revoked row is not touched back to life.
    await s.touchActivity(acme, "sess_b", new Date(Date.now() + 120_000))
    expect((await s.sessionFacts(acme, "sess_b")).activity?.lastSeenAt.getTime()).toBe(
      later.getTime(),
    )
  })

  it("prunes rows nobody has touched for longer than any policy allows", async () => {
    const s = store()
    await owner`insert into identity.session_activity (tenant_id, session_id, clerk_user_id, started_at, last_seen_at)
                values (${acme}, 'sess_old', ${ada}, now() - interval '200 days', now() - interval '200 days')`
    await s.startActivity(acme, {
      sessionId: "sess_new",
      clerkUserId: ada,
      startedAt: new Date(),
      now: new Date(),
    })
    const rows =
      await owner`select session_id from identity.session_activity where tenant_id = ${acme} and session_id = 'sess_old'`
    expect(rows).toHaveLength(0)
  })
})
