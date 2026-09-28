import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "../src/db/schema.js"
import { assertRlsSubject, type Database } from "../src/db/client.js"
import { sendingTierStore } from "../src/metering/tiers.js"
import { recordContent } from "../src/risk/content.js"
import { loadFacts } from "../src/risk/facts.js"
import { holdStore } from "../src/risk/holds.js"
import { identityStore, recordSighting } from "../src/risk/identity.js"
import { labelStore } from "../src/risk/labels.js"
import { runAll, scoreTenant, type RiskDeps } from "../src/risk/runner.js"
import { assessmentStore } from "../src/risk/store.js"
import type { SendEmail } from "@repo/contracts"

/**
 * The risk engine against a real Postgres, as the role the API runs as (#170).
 *
 * ⚠ THIS IS WHERE THE SQL IS PROVEN. The unit suites fake the database; this
 * one runs every definer, every RLS policy and every door against the real
 * schema, as `i10_api`, so a policy that blocks a legitimate read or a definer
 * granted to the wrong role fails here rather than in production.
 *
 * Run it against a THROWAWAY database with every migration applied:
 *
 *   RISK_TEST_DATABASE_URL=postgres://i10:<pw>@localhost:5433/i10_risk_scratch bun test test/risk-db.test.ts
 *
 * The URL is the OWNER's (to seed); the code under test connects with
 * `role=i10_api`, which is what makes RLS apply.
 */
const URL = process.env.RISK_TEST_DATABASE_URL
const FREE = "free"
const suite = URL ? describe : describe.skip
/** Unique per run, so a scratch database reused across runs never leaks rows into a count. */
const RUN = crypto.randomUUID().slice(0, 8)

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database

const ids = {
  a: crypto.randomUUID(),
  b: crypto.randomUUID(),
  c: crypto.randomUUID(),
  d: crypto.randomUUID(),
  e: crypto.randomUUID(),
  clean: crypto.randomUUID(),
}

class FakeRedis {
  kv = new Map<string, string>()
  sets = new Map<string, Set<string>>()
  async set(k: string, v: string, _m?: string, _s?: number, nx?: string) {
    if (nx && this.kv.has(k)) return null
    this.kv.set(k, v)
    return "OK"
  }
  async get(k: string) {
    return this.kv.get(k) ?? null
  }
  async setex(k: string, _s: number, v: string) {
    this.kv.set(k, v)
    return "OK"
  }
  async eval(_script: string, _n: number, key: string, token: string) {
    if (this.kv.get(key) === token) this.kv.delete(key)
    return 1
  }
  async sadd(k: string, ...m: string[]) {
    const s = this.sets.get(k) ?? new Set()
    m.forEach((x) => s.add(x))
    this.sets.set(k, s)
    return m.length
  }
  async spop(k: string, count: number) {
    const s = [...(this.sets.get(k) ?? [])].slice(0, count)
    s.forEach((x) => this.sets.get(k)!.delete(x))
    return s
  }
  async sismember(k: string, m: string) {
    return this.sets.get(k)?.has(m) ? 1 : 0
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])]
  }
  pipeline() {
    const ops: (() => Promise<unknown>)[] = []
    const p = {
      sadd: (k: string, m: string) => (ops.push(() => this.sadd(k, m)), p),
      expire: () => (ops.push(async () => 1), p),
      scard: (k: string) => (ops.push(async () => this.sets.get(k)?.size ?? 0), p),
      exec: async () => {
        const out: [null, unknown][] = []
        for (const f of ops) out.push([null, await f()])
        return out
      },
    }
    return p
  }
}

function riskDeps(
  redis = new FakeRedis(),
  over: Partial<RiskDeps> = {},
): RiskDeps & { alerts: string[] } {
  const alerts: string[] = []
  return {
    db,
    freePlanId: FREE,
    ownerInfo: async () => ({ mfa: false, email: "owner@gmail.com" }),
    act: {
      tiers: sendingTierStore(db),
      holds: holdStore(db),
      assessments: assessmentStore(db),
      alert: (m) => alerts.push(m),
    },
    labels: labelStore(db),
    switches: { enabled: true, tiers: true, holds: true, sesPolicy: true },
    redis: redis as never,
    alerts,
    ...over,
  }
}

async function seedTenant(
  id: string,
  { createdAgoHours = 24, owner: who = `risk-test-${RUN}-${id.slice(0, 8)}` } = {},
) {
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, created_at)
              values (${id}, ${`t-${id.slice(0, 8)}`}, ${"T"}, ${who}, now() - ${`${createdAgoHours} hours`}::interval)`
  await owner`insert into core.plan_assignments (tenant_id, plan_id, anchor) values (${id}, ${FREE}, now())`
}

const promo = (i: number): SendEmail =>
  ({
    from: "a@x.top",
    to: `r${i}@example.com`,
    subject: "Exclusive offer just for you",
    html: `<p>Claim your reward today, friend ${i}. Limited stock, act now before the offer ends. Visit https://deals.example.top/c?u=${i}</p>`,
  }) as SendEmail

suite("the risk engine against Postgres, as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(URL!, {
      max: 4,
      onnotice: () => {},
      connection: { role: "i10_api" } as never,
      prepare: false,
    })
    db = drizzle(app, { schema }) as unknown as Database
    const [plan] = await owner`select id from core.plans where id = ${FREE}`
    if (!plan) {
      await owner`insert into core.plans (id, name, source) values (${FREE}, 'Free', 'catalog') on conflict do nothing`.catch(
        () => {},
      )
    }
    for (const id of Object.values(ids))
      await seedTenant(id, { createdAgoHours: id === ids.clean ? 24 * 90 : 3 })
  })

  afterAll(async () => {
    for (const id of Object.values(ids))
      await owner`delete from core.tenants where id = ${id}`.catch(() => {})
    await owner`delete from core.identity_events where clerk_user_id like 'risk-test-%'`.catch(
      () => {},
    )
    await owner?.end()
    await app?.end()
  })

  it("connects as a role row level security applies to", async () => {
    await assertRlsSubject(app)
    const [who] = await app`select current_user`
    expect(who?.current_user).toBe("i10_api")
  })

  it("cannot read identity events or models directly: they are deny-all", async () => {
    await identityStore(db).record({
      userId: "risk-test-direct",
      tenantId: null,
      kind: "session",
      sessionId: "s",
      ip: "1.2.3.4",
      country: "DE",
      tor: false,
      userAgent: "ua",
      deviceId: "d",
      timezone: null,
      language: null,
    })
    const rows = await app`select * from core.identity_events`
    expect(rows).toHaveLength(0)
    const [row] =
      await owner`select count(*)::int as n from core.identity_events where clerk_user_id = 'risk-test-direct'`
    expect(row?.n).toBe(1)
  })

  it("respects a staff tier under the lock", async () => {
    const tiers = sendingTierStore(db)
    await tiers.set({
      tenantId: ids.clean,
      tier: "normal",
      source: "staff",
      reason: "trusted",
      setBy: "mo",
    })
    const r = await tiers.set({
      tenantId: ids.clean,
      tier: "strict",
      source: "score",
      reason: "r",
      setBy: "risk-score",
      respectStaff: true,
    })
    expect(r.refused).toBe("staff")
    expect((await tiers.current(ids.clean)).tier).toBe("normal")
  })

  it("holds: cancels queued mail in the same transaction, refuses a second hold, releases with a pause", async () => {
    await owner`insert into core.messages (tenant_id, from_address, to_addresses, subject, status, queue)
                values (${ids.e}, 'a@x.top', '{r@example.com}', 's', 'queued', 'transactional'),
                       (${ids.e}, 'a@x.top', '{r@example.com}', 's', 'queued', 'bulk')`
    const holds = holdStore(db)
    const first = await holds.hold({
      tenantId: ids.e,
      source: "staff",
      reason: "test",
      category: "bounces",
      setBy: "mo",
    })
    expect(first?.canceled).toBe(2)
    expect(
      await holds.hold({
        tenantId: ids.e,
        source: "staff",
        reason: "again",
        category: "bounces",
        setBy: "mo",
      }),
    ).toBeNull()
    const [row] =
      await owner`select count(*)::int as n from core.messages where tenant_id = ${ids.e} and status = 'canceled'`
    expect(row?.n).toBe(2)
    await assessmentStore(db).save({
      tenantId: ids.e,
      assessment: { score: 90, band: "critical", contributions: [], rulesetVersion: 1 },
      bandSince: new Date(),
      modelScore: null,
      previous: null,
      actions: [],
      trigger: "test",
      at: new Date(),
    })
    expect(
      await holds.release({
        tenantId: ids.e,
        setBy: "mo",
        reason: "fixed",
        outcome: "false_positive",
      }),
    ).toBe(true)
    expect(await holds.current(ids.e)).toBeNull()
    const current = await assessmentStore(db).current(ids.e)
    expect(current?.autoActionsPausedUntil!.getTime()).toBeGreaterThan(Date.now())
    const events =
      await owner`select action from core.sending_hold_events where tenant_id = ${ids.e} order by occurred_at`
    expect(events.map((e) => e.action)).toEqual(["hold", "release"])
  })

  it("refuses an automatic hold of mailboxes", async () => {
    await expect(
      holdStore(db).hold({
        tenantId: ids.clean,
        source: "score",
        reason: "r",
        category: "bounces",
        setBy: "risk-score",
        scope: "all",
      }),
    ).rejects.toThrow()
  })

  it("finds a farm: shared content through the GIN overlap, linked through owners' devices", async () => {
    // Four young workspaces, owners on one device, sending near-copies.
    const members = [ids.a, ids.b, ids.c, ids.d]
    const store = identityStore(db)
    for (const [i, id] of members.entries()) {
      const [t] =
        await owner`select owner_clerk_user_id from core.tenants where id = ${id}`
      await store.record({
        userId: t!.owner_clerk_user_id,
        tenantId: id,
        kind: "session",
        sessionId: `s${i}`,
        ip: `203.0.113.${10 + i}`,
        country: "VN",
        tor: false,
        userAgent: "ua",
        deviceId: `farm-${RUN}`,
        timezone: "Asia/Ho_Chi_Minh",
        language: "vi",
      })
      await recordContent(id, [promo(i), promo(i + 100)], { db, threshold: 99 })
    }
    const facts = await loadFacts(ids.a, {
      db,
      freePlanId: FREE,
      ownerInfo: async () => null,
    })
    expect(facts.farm.peers.length).toBe(3)
    for (const p of facts.farm.peers) {
      expect(p.ownerDevice).toBe(true)
      expect(p.createdNear).toBe(true)
      expect(p.exactShared + p.nearShared).toBeGreaterThan(0)
    }
    expect(facts.identity?.devicePeers).toBe(3)
    expect(facts.identity?.subnetSignupPeers).toBe(3)
  })

  it("scores and acts end to end, and is idempotent run after run", async () => {
    const redis = new FakeRedis()
    const deps = riskDeps(redis)
    const r1 = await scoreTenant(ids.a, "test", deps)
    expect(r1.status).toBe("scored")
    // A four-workspace ring (three peers) is elevated on content and device
    // alone: strict tiers now, a hold once any member is held (below).
    expect(["elevated", "high", "critical"]).toContain(r1.band!)
    expect((await sendingTierStore(db).current(ids.a)).tier).toBe("strict")

    const r2 = await scoreTenant(ids.a, "test", deps)
    expect(r2.score).toBe(r1.score)
    const tierEvents =
      await owner`select count(*)::int as n from core.sending_tier_events where tenant_id = ${ids.a}`
    expect(tierEvents[0]!.n).toBe(1)
    const holdEvents =
      await owner`select count(*)::int as n from core.sending_hold_events where tenant_id = ${ids.a} and action = 'hold'`
    expect(holdEvents[0]!.n).toBeLessThanOrEqual(1)
    const assessmentEvents =
      await owner`select count(*)::int as n from core.risk_assessment_events where tenant_id = ${ids.a}`
    expect(assessmentEvents[0]!.n).toBe(1)
  })

  it("serialises concurrent scores of one workspace with the lease", async () => {
    const redis = new FakeRedis()
    const deps = riskDeps(redis)
    const results = await Promise.all([
      scoreTenant(ids.b, "a", deps),
      scoreTenant(ids.b, "b", deps),
      scoreTenant(ids.b, "c", deps),
    ])
    expect(results.filter((r) => r.status === "scored")).toHaveLength(1)
    expect(results.filter((r) => r.status === "locked")).toHaveLength(2)
  })

  it("holds a farm member once another is held, and blocks it at accept", async () => {
    await holdStore(db).hold({
      tenantId: ids.c,
      source: "staff",
      reason: "farm",
      category: "linked_workspaces",
      setBy: "mo",
    })
    const r = await scoreTenant(ids.d, "test", riskDeps())
    expect(r.band).toBe("critical")
    expect(await holdStore(db).current(ids.d)).not.toBeNull()
  })

  it("leaves a clean, old workspace alone", async () => {
    const r = await scoreTenant(ids.clean, "test", riskDeps())
    expect(r.band).toBe("low")
    expect(await holdStore(db).current(ids.clean)).toBeNull()
  })

  it("skips an exempt workspace entirely", async () => {
    const r = await scoreTenant(
      ids.clean,
      "test",
      riskDeps(new FakeRedis(), { exempt: new Set([ids.clean]) }),
    )
    expect(r.status).toBe("exempt")
  })

  it("runs the hourly pass: dirty workspaces first, then the stale ones", async () => {
    const redis = new FakeRedis()
    await redis.sadd("risk:dirty", ids.clean)
    const summary = await runAll({ ...riskDeps(redis) }, { concurrency: 2 })
    expect(summary.failed).toBe(0)
    expect(summary.scored).toBeGreaterThan(0)
  })

  it("records a sighting, spots impossible travel, and responds", async () => {
    const redis = new FakeRedis()
    const store = identityStore(db)
    const responded: string[] = []
    const t0 = new Date()
    await recordSighting(
      {
        userId: `risk-test-${RUN}-traveller`,
        tenantId: null,
        sessionId: "s1",
        ip: "81.2.69.160",
        country: "DE",
        userAgent: "ua",
        deviceId: "d1",
        timezone: null,
        language: null,
      },
      { store, redis: redis as never, now: () => t0 },
    )
    const r = await recordSighting(
      {
        userId: `risk-test-${RUN}-traveller`,
        tenantId: null,
        sessionId: "s2",
        ip: "200.1.2.3",
        country: "BR",
        userAgent: "ua",
        deviceId: "d2",
        timezone: null,
        language: null,
      },
      {
        store,
        redis: redis as never,
        takeover: { respond: async ({ userId }) => void responded.push(userId) },
        now: () => new Date(t0.getTime() + 60_000),
      },
    )
    expect(r).toBe("anomaly")
    expect(responded).toEqual([`risk-test-${RUN}-traveller`])
  })

  it("stores labels and models through the definers, and keeps a failed model inactive", async () => {
    const labels = labelStore(db)
    await labels.add({
      tenantId: ids.a,
      label: "abuse",
      source: "staff",
      features: { farm_linked: 1 },
      setBy: "mo",
    })
    expect(await labels.count()).toBeGreaterThan(0)
    const r = await labels.retrain()
    expect(r.active).toBe(false)
    expect((await labels.model(true))?.active ?? false).toBe(false)
    expect((await labels.model(false))?.version).toBe(r.version)
  })
})
