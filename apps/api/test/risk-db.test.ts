import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "../src/db/schema.js"
import { assertRlsSubject, withTenant, type Database } from "../src/db/client.js"
import { riskFactSnapshots } from "../src/db/core.js"
import { sendingTierStore } from "../src/metering/tiers.js"
import { recordContent } from "../src/risk/content.js"
import { loadFacts } from "../src/risk/facts.js"
import { holdStore } from "../src/risk/holds.js"
import { identityStore, recordSighting } from "../src/risk/identity.js"
import { labelStore } from "../src/risk/labels.js"
import { runAll, scoreTenant, type RiskDeps } from "../src/risk/runner.js"
import { evaluate } from "../src/risk/engine.js"
import { RULES } from "../src/risk/rules.js"
import { reviveFacts, snapshotStore } from "../src/risk/snapshot.js"
import type { Rule } from "../src/risk/types.js"
import { assessmentStore } from "../src/risk/store.js"
import type { ResolvedEmail } from "../src/send/accept.js"

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
 *   RISK_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/risk_scratch bun test test/risk-db.test.ts
 *
 * The URL is the OWNER's (to seed); the code under test logs in as `i10_api`
 * (the dev password, or RISK_TEST_API_DATABASE_URL), which is what makes RLS
 * apply. ⚠ IT NEEDS PGVECTOR: the dev compose runs the production CNPG image,
 * whose template1 carries it, so a database `i10` creates has it too.
 */
const URL = process.env.RISK_TEST_DATABASE_URL
const API_URL =
  process.env.RISK_TEST_API_DATABASE_URL ??
  URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const FREE = "free"
const suite = URL ? describe : describe.skip
/** Unique per run, so a scratch database reused across runs never leaks rows into a count. */
const RUN = crypto.randomUUID().slice(0, 8)

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database

/** Workspaces a test creates on its own, cleaned up with the rest. */
const extra: string[] = []

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
    snapshots: snapshotStore(db),
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

const promo = (i: number): ResolvedEmail =>
  ({
    from: "a@x.top",
    to: `r${i}@example.com`,
    subject: "Exclusive offer just for you",
    html: `<p>Claim your reward today, friend ${i}. Limited stock, act now before the offer ends. Visit https://deals.example.top/c?u=${i}</p>`,
  }) as ResolvedEmail

suite("the risk engine against Postgres, as i10_api", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    // ⚠ LOGS IN AS i10_api ITSELF, the way the API does. On the CNPG image the
    // owner `i10` is not a superuser (as in production) and cannot SET ROLE.
    app = postgres(API_URL!, { max: 4, onnotice: () => {}, prepare: false })
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
    for (const id of [...Object.values(ids), ...extra])
      await owner`delete from core.tenants where id = ${id}`.catch(() => {})
    await owner`delete from core.identity_events where clerk_user_id like 'risk-test-%'`.catch(
      () => {},
    )
    // The boilerplate list is global: its test entries go by name.
    await owner`delete from core.risk_boilerplate where name like ${`test/%-${RUN}`}`.catch(
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

  it("cannot read identity events directly: they are deny-all", async () => {
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
      shadow: [],
      bandSince: new Date(),
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

  // ⚠ FACT SNAPSHOTS: every event's facts, otherwise the first score of a UTC
  // day, and never readable by a workspace (risk/snapshot.ts).
  it("snapshots the facts on every event, and otherwise once per workspace per UTC day", async () => {
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id)
    const count = async () =>
      (
        await owner`select count(*)::int as n from core.risk_fact_snapshots where tenant_id = ${id}`
      )[0]!.n as number
    const events = async () =>
      (
        await owner`select count(*)::int as n from core.risk_assessment_events where tenant_id = ${id}`
      )[0]!.n as number
    const day = new Date()
    day.setUTCHours(1, 0, 0, 0)
    const at = (hours: number) => new Date(day.getTime() + hours * 3_600_000)
    const deps = (hours: number) => riskDeps(new FakeRedis(), { now: () => at(hours) })

    // The first assessment is an event: its facts are kept.
    await scoreTenant(id, "test", deps(0))
    expect(await events()).toBe(1)
    expect(await count()).toBe(1)
    // Nothing moved an hour later: no event, and today already has one.
    await scoreTenant(id, "hourly", deps(1))
    await scoreTenant(id, "hourly", deps(2))
    expect(await events()).toBe(1)
    expect(await count()).toBe(1)
    // The next UTC day keeps its first quiet score, and only its first.
    await scoreTenant(id, "hourly", deps(23.5))
    await scoreTenant(id, "hourly", deps(24.5))
    expect(await count()).toBe(2)
    // An event is kept whatever the day already has.
    const store = snapshotStore(db)
    const facts = await loadFacts(id, {
      db,
      freePlanId: FREE,
      ownerInfo: async () => null,
    })
    const e = evaluate(facts)
    expect(
      await store.record({
        tenantId: id,
        at: at(25),
        trigger: "t",
        evaluated: e,
        facts,
        force: false,
      }),
    ).toBe(false)
    expect(
      await store.record({
        tenantId: id,
        at: at(25),
        trigger: "t",
        evaluated: e,
        facts,
        force: true,
      }),
    ).toBe(true)
    expect(await count()).toBe(3)

    // What was kept replays to what was stored, through real jsonb.
    const kept = await store.list({
      since: at(-1),
      until: at(48),
      tenantId: id,
      limit: 10,
    })
    expect(kept.map((k) => k.trigger)).toEqual(["test", "hourly", "t"])
    for (const k of kept) {
      const back = reviveFacts(k.facts)
      expect(back.now).toBeInstanceOf(Date)
      expect(evaluate(back).band).toBe(k.band)
      expect(evaluate(back).score).toBe(k.score)
    }
    // Keyset paging walks the same rows one at a time.
    const first = await store.list({
      since: at(-1),
      until: at(48),
      tenantId: id,
      limit: 1,
    })
    const second = await store.list({
      since: at(-1),
      until: at(48),
      tenantId: id,
      after: first[0]!,
      limit: 1,
    })
    expect(second[0]!.id).toBe(kept[1]!.id)
  })

  it("keeps fact snapshots deny-all: a workspace cannot read even its own", async () => {
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id)
    await scoreTenant(id, "test", riskDeps())
    const [kept] =
      await owner`select count(*)::int as n from core.risk_fact_snapshots where tenant_id = ${id}`
    expect(kept!.n).toBe(1)
    const own = await withTenant(db, id, (tx) => tx.select().from(riskFactSnapshots))
    expect(own).toHaveLength(0)
    expect(await app`select * from core.risk_fact_snapshots`).toHaveLength(0)
    await expect(
      withTenant(db, id, (tx) =>
        tx.insert(riskFactSnapshots).values({
          tenantId: id,
          takenAt: new Date(),
          rulesetVersion: 1,
          trigger: "forged",
          score: 0,
          band: "low",
          contributions: [],
          shadow: [],
          facts: {},
        }),
      ),
    ).rejects.toThrow()
  })

  it("purges fact snapshots past the retention window in the hourly run", async () => {
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id)
    const store = snapshotStore(db)
    const facts = await loadFacts(id, {
      db,
      freePlanId: FREE,
      ownerInfo: async () => null,
    })
    const e = evaluate(facts)
    const old = new Date(Date.now() - 181 * 86_400_000)
    const recent = new Date(Date.now() - 179 * 86_400_000)
    for (const at of [old, recent])
      await store.record({
        tenantId: id,
        at,
        trigger: "t",
        evaluated: e,
        facts,
        force: true,
      })

    const summary = await runAll(riskDeps(), { concurrency: 2 })
    expect(summary.snapshotsPurged).toBeGreaterThanOrEqual(1)
    const left =
      await owner`select taken_at from core.risk_fact_snapshots where tenant_id = ${id} and trigger = 't'`
    expect(left.map((r) => new Date(r.taken_at).getTime())).toEqual([recent.getTime()])
  })

  it("records shadow contributions with the assessment and its event, and lets them move nothing", async () => {
    const loud: Rule = {
      id: "test.shadow_critical",
      category: "content",
      summary: "Test-only: always fires at critical, in shadow",
      mode: "shadow",
      evaluate: () => ({ points: 100, evidence: { test: true }, floor: "critical" }),
    }
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id, { createdAgoHours: 24 * 90 })
    const r = await scoreTenant(
      id,
      "test",
      riskDeps(new FakeRedis(), { rules: [...RULES, loud] }),
    )
    expect(r.band).toBe("low")
    expect(r.actions).toEqual([])
    expect(await holdStore(db).current(id)).toBeNull()

    const current = await assessmentStore(db).current(id)
    expect(current!.shadow.map((c) => c.rule)).toEqual([loud.id])
    expect(current!.contributions.map((c) => c.rule)).not.toContain(loud.id)
    const [event] = await assessmentStore(db).history(id, 1)
    expect((event!.shadow as { rule: string }[]).map((c) => c.rule)).toEqual([loud.id])
    const [snap] = await snapshotStore(db).list({
      since: new Date(Date.now() - 3_600_000),
      until: new Date(Date.now() + 3_600_000),
      tenantId: id,
      limit: 1,
    })
    expect(snap!.shadow.map((c) => c.rule)).toEqual([loud.id])
  })

  // ⚠ THE LINK PROVIDERS' WIRING: what each says is stored once, an answer that
  // is not yet enough stays unchecked for the next run, and the score reads the
  // providers back out of the stored verdict (#222).
  it("stores each link host's verdict from the providers, leaves an unsure one unchecked, and scores by who flagged it", async () => {
    const t = crypto.randomUUID()
    extra.push(t)
    await seedTenant(t)
    const link = (host: string) => `<a href="https://${host}/x">${host}</a>`
    await recordContent(
      t,
      [
        {
          from: "a@x.top",
          to: "r@example.com",
          subject: "Exclusive offer just for you",
          html:
            "<p>Claim your reward today, friend. Limited stock, act now before the offer ends. " +
            ["one-list", "two-lists", "unsure", "fine"]
              .map((h) => link(`${h}-${RUN}.example.top`))
              .join(" ") +
            "</p>",
        } as ResolvedEmail,
      ],
      { db, threshold: 99 },
    )
    const verdicts: Record<string, string | null> = {
      [`one-list-${RUN}.example.top`]: "cloudflare=blocked",
      [`two-lists-${RUN}.example.top`]: "cloudflare=blocked;quad9=blocked",
      [`unsure-${RUN}.example.top`]: null,
    }
    const links = {
      cached: async () => null,
      lookup: async (host: string) => (host in verdicts ? verdicts[host]! : "clean"),
      stats: () => ({
        cloudflare: { clean: 1, unsafe: 2, unknown: 1, skipped: 0 },
      }),
    }
    const redis = new FakeRedis()
    await redis.sadd("risk:dirty", t)
    const summary = await runAll(riskDeps(redis, { links }), { concurrency: 2 })

    const rows =
      await owner`select host, verdict, checked_at from core.link_hosts where tenant_id = ${t}`
    const byHost = new Map(rows.map((r) => [r.host as string, r]))
    expect(byHost.get(`one-list-${RUN}.example.top`)?.verdict).toBe(
      "cloudflare=blocked",
    )
    expect(byHost.get(`two-lists-${RUN}.example.top`)?.verdict).toBe(
      "cloudflare=blocked;quad9=blocked",
    )
    expect(byHost.get(`fine-${RUN}.example.top`)?.verdict).toBe("clean")
    // not enough to store: asked again next run, never recorded clean
    expect(byHost.get(`unsure-${RUN}.example.top`)?.checked_at).toBeNull()
    expect(summary.linksChecked).toBeGreaterThanOrEqual(3)
    expect(summary.unsafe).toBeGreaterThanOrEqual(2)
    expect(summary.links).toEqual({
      cloudflare: { clean: 1, unsafe: 2, unknown: 1, skipped: 0 },
    })

    const rule = (await assessmentStore(db).current(t))?.contributions.find(
      (c) => c.rule === "links.unsafe",
    )
    expect(rule?.points).toBe(90)
    expect(rule?.floor).toBe("critical")
    expect(String(rule?.evidence.hosts)).toContain(
      "cloudflare: blocked, quad9: blocked",
    )
    expect(String(rule?.evidence.hosts)).toContain("cloudflare: blocked)")
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

  it("stores labels under the workspace's own policy", async () => {
    const labels = labelStore(db)
    const since = new Date(Date.now() - 60_000)
    expect(await labels.has(ids.a, "staff", since)).toBe(false)
    await labels.add({ tenantId: ids.a, label: "abuse", source: "staff", setBy: "mo" })
    expect(await labels.has(ids.a, "staff", since)).toBe(true)
    expect(await labels.has(ids.b, "staff", since)).toBe(false)
  })

  it("counts only staff demotions toward the demotion rule, never the score's own", async () => {
    const { evaluate } = await import("../src/risk/engine.js")
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id)
    const tiers = sendingTierStore(db)
    const move = (tier: "strict" | "normal", source: "score" | "staff") =>
      tiers.set({ tenantId: id, tier, source, reason: "test", setBy: source })
    const facts = () =>
      loadFacts(id, { db, freePlanId: FREE, ownerInfo: async () => null })
    const demotionRule = async () =>
      evaluate(await facts()).contributions.find((c) => c.rule === "history.demotions")

    // The score demoting twice is the score's own verdict: no new evidence.
    for (const tier of ["strict", "normal", "strict", "normal"] as const)
      await move(tier, "score")
    expect((await facts()).history.staffDemotions90d).toBe(0)
    expect(await demotionRule()).toBeUndefined()

    // A person demoting twice still counts.
    for (const tier of ["strict", "normal", "strict"] as const)
      await move(tier, "staff")
    expect((await facts()).history.staffDemotions90d).toBe(2)
    expect((await demotionRule())?.points).toBe(8)
  })

  it("scores past a rule that throws, and logs and reports it with the rule and workspace", async () => {
    const { spyOn } = await import("bun:test")
    const { RULES } = await import("../src/risk/rules.js")
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id)
    // The owner's address is on the workspace's own domain, so trust.owner_domain
    // has something to say while trust.mfa throws.
    const domain = `throws-${RUN}.com`
    await owner`insert into core.domains (tenant_id, name, status, verified_at)
                values (${id}, ${domain}, 'verified', now())`
    const broken = RULES.find((r) => r.id === "trust.mfa")!
    const spy = spyOn(broken, "evaluate").mockImplementation(() => {
      throw new Error("boom")
    })
    const logged: object[] = []
    const reported: Record<string, unknown>[] = []
    try {
      const r = await scoreTenant(
        id,
        "test",
        riskDeps(new FakeRedis(), {
          ownerInfo: async () => ({ mfa: true, email: `owner@${domain}` }),
          log: { error: (o, m) => m === "risk rule threw" && logged.push(o) },
          report: (_error, context) => reported.push(context),
        }),
      )
      expect(r.status).toBe("scored")
      expect(r.ruleFailures).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(logged).toEqual([
      expect.objectContaining({ rule: "trust.mfa", tenantId: id }),
    ])
    expect(reported).toEqual([
      expect.objectContaining({ rule: "trust.mfa", tenantId: id }),
    ])
    // The other rules still scored: the stored assessment lists them.
    const stored = await assessmentStore(db).current(id)
    const rules = stored?.contributions.map((c) => c.rule) ?? []
    expect(rules).toContain("trust.owner_domain")
    expect(rules).not.toContain("trust.mfa")
  })

  // ─── Templates, compaction and the vector layer (#169, #170, #171) ───

  const receipt = (name: string, order: string) =>
    `<html><body><table width="600"><tr><td><img src="https://cdn.acme.com/logo.png"></td></tr>` +
    `<tr><td><h1>Thanks for your order, ${name}!</h1><p>Your order <b>#${order}</b> is confirmed ` +
    `and ships within two business days. Questions? Reply to this email and our team will help.</p>` +
    `<p style="color:#999">Acme Inc, 1 Market St, San Francisco</p></td></tr></table></body></html>`

  async function seedSent(
    tenantId: string,
    html: string,
    text: string | null = null,
    status = "sent",
  ) {
    // ⚠ ONE STATEMENT. Reading `created_at` back into a JS Date drops the
    // microseconds, and the body would then not join its message - the same
    // reason the worker threads `createdAt` through instead of re-deriving it.
    const [m] = await owner`
      with m as (
        insert into core.messages (tenant_id, from_address, to_addresses, subject, status, queue, sent_at)
        values (${tenantId}, 'shop@acme.com', '{a@example.com}', 'Your order', ${status}, 'transactional', now())
        returning id, created_at, tenant_id
      )
      insert into core.message_bodies (message_id, created_at, tenant_id, html, text)
      select id, created_at, tenant_id, ${html}, ${text} from m
      returning message_id as id`
    return m!
  }

  it("discovers a template, links each match once, compacts only when established, and restores byte-exactly", async () => {
    const { compactContent } = await import("../src/content/compact.js")
    const { restoreBodies } = await import("../src/content/restore.js")
    const { withTenant } = await import("../src/db/client.js")
    const sent = []
    for (const [i, n] of ["John", "Sarah", "Li", "Zo\u00eb", "O'Brien"].entries()) {
      sent.push({
        m: await seedSent(ids.clean, receipt(n, String(1000 + i)), `Thanks ${n}`),
        html: receipt(n, String(1000 + i)),
        text: `Thanks ${n}`,
      })
    }
    const queued = await seedSent(ids.clean, receipt("Queued", "9"), null, "queued")

    const first = await compactContent(ids.clean, { db, promoteAt: 3 })
    expect(first.derived).toBeGreaterThan(0)
    expect(first.matched).toBe(5)
    expect(first.compacted).toBe(5)
    expect(first.bytesSaved).toBeGreaterThan(0)

    const [tmpl] =
      await owner`select messages from core.content_templates where tenant_id = ${ids.clean}`
    expect(tmpl?.messages).toBe(5)
    const again = await compactContent(ids.clean, { db, promoteAt: 3 })
    expect(again.matched).toBe(0)
    const [tmpl2] =
      await owner`select messages from core.content_templates where tenant_id = ${ids.clean}`
    expect(tmpl2?.messages).toBe(5)

    const [q] =
      await owner`select html, template_id from core.message_bodies where message_id = ${queued.id}`
    expect(q?.template_id).toBeNull()
    expect(q?.html).toBe(receipt("Queued", "9"))

    for (const { m, html, text } of sent) {
      const [raw] =
        await owner`select html, text, template_id from core.message_bodies where message_id = ${m.id}`
      expect(raw?.html).toBeNull()
      expect(raw?.template_id).not.toBeNull()
      const restored = await withTenant(db, ids.clean, async (tx) => {
        const rows = await tx
          .select({
            html: schema.messageBodies.html,
            text: schema.messageBodies.text,
            templateId: schema.messageBodies.templateId,
            templateValues: schema.messageBodies.templateValues,
          })
          .from(schema.messageBodies)
          .where((await import("drizzle-orm")).eq(schema.messageBodies.messageId, m.id))
        return restoreBodies(tx, rows)
      })
      expect(restored[0]?.html).toBe(html)
      expect(restored[0]?.text).toBe(text)
    }
  })

  it("links but does not compact below the promotion threshold", async () => {
    const { compactContent } = await import("../src/content/compact.js")
    await seedSent(ids.e, receipt("A", "1"))
    await seedSent(ids.e, receipt("B", "2"))
    const r = await compactContent(ids.e, { db, promoteAt: 3 })
    expect(r.matched).toBe(2)
    expect(r.compacted).toBe(0)
    const rows =
      await owner`select html, template_id from core.message_bodies where tenant_id = ${ids.e} and template_id is not null`
    expect(rows).toHaveLength(2)
    expect(rows.every((x) => x.html !== null)).toBe(true)
  })

  it("stores content vectors under RLS and finds mail like a confirmed abuser's", async () => {
    const { storeContentVectors, contentNeighbours } =
      await import("../src/content/vectors.js")
    const { hashEmbedder } = await import("../src/content/embed.js")
    const e = hashEmbedder()
    const scam =
      "Your account has been selected for a special reward. Claim your prize today at our secure portal before it expires tonight."
    const [v1, v2, v3] = await e.embed([
      scam,
      scam.replace("tonight", "at midnight"),
      "Quarterly engineering newsletter: our migration to Postgres 18 and what we learned about partitioning.",
    ])
    const day = new Date().toISOString().slice(0, 10)
    await storeContentVectors(db, ids.c, e.model, [
      { day, exact: "scam-c", embedding: v1! },
    ])
    await storeContentVectors(db, ids.b, e.model, [
      { day, exact: "scam-b", embedding: v2! },
    ])
    await storeContentVectors(db, ids.clean, e.model, [
      { day, exact: "news", embedding: v3! },
    ])

    // c is held by staff (earlier test) = confirmed. b's mail reads like c's.
    const near = await contentNeighbours(db, ids.b, e.model, FREE, new Date())
    expect(near.taintedSimilar).toBe(1)
    expect(near.bestTaintedSimilarity!).toBeGreaterThan(0.8)
    const far = await contentNeighbours(db, ids.clean, e.model, FREE, new Date())
    expect(far.taintedSimilar).toBe(0)

    // ⚠ Another workspace's vectors are unreachable: with no tenant context the
    // policy RAISES (by design, see db/core.ts), and from inside another
    // workspace's context the rows simply are not there.
    // (postgres.js queries are lazy thenables, not Promises; `expect().rejects`
    // does not drive them, so the refusal is caught explicitly.)
    let refused = false
    try {
      await app`select * from core.content_vectors where tenant_id = ${ids.c}`
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
    const { withTenant } = await import("../src/db/client.js")
    const { sql: q } = await import("drizzle-orm")
    const leaked = await withTenant(db, ids.b, (tx) =>
      tx.execute(
        q`select * from core.content_vectors where tenant_id = ${ids.c}::uuid`,
      ),
    )
    expect(leaked).toHaveLength(0)
  })

  it("does not let an automatic hold taint anybody: only confirmed abuse does", async () => {
    const { contentNeighbours, storeContentVectors } =
      await import("../src/content/vectors.js")
    const { hashEmbedder } = await import("../src/content/embed.js")
    const e = hashEmbedder()
    const [v] = await e.embed([
      "Limited offer only today: claim the free gift card waiting in your account, click to verify now.",
    ])
    const day = new Date().toISOString().slice(0, 10)
    const suspect = crypto.randomUUID()
    const bystander = crypto.randomUUID()
    await seedTenant(suspect)
    await seedTenant(bystander)
    extra.push(suspect, bystander)
    await storeContentVectors(db, suspect, e.model, [
      { day, exact: "gift-s", embedding: v! },
    ])
    await storeContentVectors(db, bystander, e.model, [
      { day, exact: "gift-b", embedding: v! },
    ])

    // Held by the SCORE, awaiting review: not evidence against anyone else.
    await holdStore(db).hold({
      tenantId: suspect,
      source: "score",
      reason: "auto",
      category: "content",
      setBy: "risk-score",
    })
    expect(
      (await contentNeighbours(db, bystander, e.model, FREE, new Date()))
        .taintedSimilar,
    ).toBe(0)

    // A person confirms it: now it is.
    await labelStore(db).add({
      tenantId: suspect,
      label: "abuse",
      source: "staff",
      setBy: "mo",
    })
    expect(
      (await contentNeighbours(db, bystander, e.model, FREE, new Date()))
        .taintedSimilar,
    ).toBe(1)
  })

  it("counts an actor's velocity", async () => {
    const { actorVelocity } = await import("../src/content/vectors.js")
    const [t] =
      await owner`select owner_clerk_user_id from core.tenants where id = ${ids.a}`
    const v = await actorVelocity(db, t!.owner_clerk_user_id)
    expect(v.linkedPeople).toBeGreaterThanOrEqual(4)
    expect(v.workspaces24h).toBeGreaterThanOrEqual(4)
  })
  // ─── #222: trusted content and similarity evidence ─────────────────────────

  /** A fresh workspace with a verified domain, cleaned up with the rest. */
  async function trustTenant(domain: string) {
    const id = crypto.randomUUID()
    extra.push(id)
    await seedTenant(id, { createdAgoHours: 3 })
    await owner`insert into core.domains (tenant_id, name, status, verified_at)
                values (${id}, ${domain}, 'verified', now())`
    return id
  }

  const BOILER = (name: string) =>
    `<html><body><h2>Reset your password</h2><p>Hi ${name},</p><p>We received a request to reset ` +
    `the password for your account. Enter the code below in the app to choose a new password. ` +
    `If you did not request this, you can safely ignore this email.</p></body></html>`

  const boilerMail = (name: string): ResolvedEmail =>
    ({
      from: "noreply@x.com",
      to: "r@example.com",
      subject: "Reset your password",
      html: BOILER(name),
    }) as ResolvedEmail

  it("keeps the boilerplate list deny-all, and changes it only through audited definers", async () => {
    const { boilerplateStore } = await import("../src/risk/trusted.js")
    const { parseSubmission } = await import("../src/content/trust.js")
    const store = boilerplateStore(db)
    const skeleton = parseSubmission({ html: BOILER("{{name}}"), text: null })
    if ("error" in skeleton) throw new Error(skeleton.error)
    const id = await store.add({
      name: `test/deny-${RUN}`,
      skeleton,
      model: null,
      embedding: null,
      reason: "integration test",
      by: "risk-db",
    })
    expect((await store.list()).some((b) => b.id === id)).toBe(true)
    expect(await app`select * from core.risk_boilerplate`).toHaveLength(0)
    expect(await app`select * from core.risk_boilerplate_events`).toHaveLength(0)
    const history = await store.history(20)
    expect(history.some((h) => h.boilerplate_id === id && h.action === "add")).toBe(
      true,
    )

    let refused = false
    try {
      await store.add({
        name: `test/noreason-${RUN}`,
        skeleton,
        model: null,
        embedding: null,
        reason: " ",
        by: "risk-db",
      })
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
    expect(await store.remove(id, "done", "risk-db")).toBe(true)
    expect(await store.remove(id, "again", "risk-db")).toBe(false)
  })

  it("leaves boilerplate out of farm detection on both sides, keeps the tripwire quiet, and counts again once removed", async () => {
    const { boilerplateStore, trustSource } = await import("../src/risk/trusted.js")
    const { parseSubmission } = await import("../src/content/trust.js")
    const { farmPeers } = await import("../src/risk/facts.js")
    const store = boilerplateStore(db)
    const skeleton = parseSubmission({
      html: BOILER("{{name}}"),
      text: null,
      holes: { name: 40 },
    })
    if ("error" in skeleton) throw new Error(skeleton.error)
    const id = await store.add({
      name: `test/farm-${RUN}`,
      skeleton,
      model: null,
      embedding: null,
      reason: "integration test",
      by: "risk-db",
    })
    const f1 = await trustTenant(`one-${RUN}.com`)
    const f2 = await trustTenant(`two-${RUN}.com`)
    const redis = new FakeRedis()
    const rescored: string[][] = []
    const trust = trustSource(db, { verdict: async () => "clean", ttlMs: 0 })
    for (const [t, name] of [
      [f1, "Ada"],
      [f2, "Bob"],
    ] as const) {
      await recordContent(t, [boilerMail(name)], {
        db,
        redis: redis as never,
        threshold: 2,
        rescore: (ids) => rescored.push(ids),
        trust,
      })
    }
    const marks =
      await owner`select trusted_by from core.content_fingerprints where tenant_id in (${f1}, ${f2})`
    expect(marks).toHaveLength(2)
    expect(marks.every((m) => m.trusted_by === `boilerplate:${id}`)).toBe(true)
    expect(redis.sets.size).toBe(0)
    expect(rescored).toHaveLength(0)
    expect(await farmPeers(db, f1, FREE, new Date())).toHaveLength(0)

    // ⚠ Removing the entry takes the excuse away from the past too.
    await store.remove(id, "being abused", "risk-db")
    const peers = await farmPeers(db, f1, FREE, new Date())
    expect(peers.map((p) => p.peer)).toContain(f2)
    expect(peers.find((p) => p.peer === f2)!.bestSimilarity).toBeGreaterThan(0)
  })

  it("reviews a workspace's own template, credits exact fits, and revokes it on bounces", async () => {
    const { trustedTemplateStore, trustSource, reviewTrusted } =
      await import("../src/risk/trusted.js")
    const { analyseContent } = await import("../src/content/job.js")
    const t = await trustTenant(`shop-${RUN}.com`)
    const store = trustedTemplateStore(db)
    const html =
      `<html><body><h1>Your sign-in link</h1><p>Hi {{name}}, use the link below to sign in to ` +
      `your account. It works once and expires in fifteen minutes.</p>` +
      `<p><a href="{{url}}">Sign in</a></p><p>Shop Inc, 1 Market St</p></body></html>`
    const submitted = await store.submit(
      t,
      { name: "Sign-in link", html, text: null, holes: { name: 40, url: 120 } },
      "user:risk-db",
    )
    if (!("template" in submitted)) throw new Error(submitted.error)
    const tid = submitted.template.id
    expect(submitted.template.status).toBe("pending")
    const again = await store.submit(
      t,
      { name: "Again", html, text: null },
      "user:risk-db",
    )
    expect("code" in again && again.code).toBe("duplicate")
    // Another workspace cannot see it.
    expect(await store.get(ids.clean, tid)).toBeNull()
    const pending = (await app`select * from core.trusted_templates_pending()`) as {
      id: string
    }[]
    expect(pending.some((p) => p.id === tid)).toBe(true)

    // Pending is not trusted: nothing is credited yet.
    const trust = trustSource(db, { verdict: async () => "clean", ttlMs: 0 })
    const render = (name: string, url: string) =>
      html.replace("{{name}}", name).replace("{{url}}", url)
    await seedSent(t, render("Ada", `https://shop-${RUN}.com/l/abc`))
    expect((await analyseContent(t, { db, trust })).trusted).toBe(0)

    const approved = await store.decide(t, tid, "approve", "staff@i10", "")
    expect(approved?.status).toBe("approved")
    expect(approved?.decisionReason).toBeNull()
    expect(await store.decide(t, tid, "reject", "staff@i10", "late")).toBeNull()

    await seedSent(t, render("Bob", `https://app.shop-${RUN}.com/l/def`))
    await seedSent(t, render("Cy", `https://evil-${RUN}.top/login`))
    const credited = await analyseContent(t, {
      db,
      trust,
      creditTemplates: (counts: ReadonlyMap<string, number>) => store.credit(t, counts),
    })
    // ⚠ BOB ONLY. Ada was analysed while the template was pending and is not
    // read again (#171's `analysed_at`), so an approval credits mail from then
    // on; Cy's link is not the workspace's own, so Cy never fits.
    expect(credited.trusted).toBe(1)
    const bodies =
      await owner`select count(*)::int as n from core.message_bodies where tenant_id = ${t} and trusted_template_id = ${tid}`
    expect(bodies[0]?.n).toBe(1)
    expect((await store.get(t, tid))?.matched).toBe(1)

    // The accept path marks the same content, and facts count it.
    await recordContent(
      t,
      [
        {
          from: "a@x.com",
          to: "r@example.com",
          subject: "Sign in",
          html: render("Dee", `https://shop-${RUN}.com/l/x`),
        } as ResolvedEmail,
      ],
      { db, threshold: 99, trust },
    )
    const facts = await loadFacts(t, {
      db,
      freePlanId: FREE,
      ownerInfo: async () => null,
    })
    expect(facts.farm.trusted.template).toBe(1)

    // Under 100 sends nothing is judged; past it, 10% hard bounces revoke.
    expect(await reviewTrusted(db, store, t, new Date())).toHaveLength(0)
    await owner`
      with m as (
        insert into core.messages (tenant_id, from_address, to_addresses, subject, status, queue, sent_at)
        select ${t}, 'a@x.com', '{a@example.com}', 'Sign in', 'sent', 'transactional', now()
          from generate_series(1, 120)
        returning id, created_at, tenant_id
      ),
      b as (
        insert into core.message_bodies (message_id, created_at, tenant_id, html, trusted_template_id)
        select id, created_at, tenant_id, 'x', ${tid}::uuid from m
        returning message_id, tenant_id
      )
      insert into core.message_events (tenant_id, message_id, type, payload)
      select tenant_id, message_id, 'sent', '{}'::jsonb from b`
    await owner`
      insert into core.message_events (tenant_id, message_id, type, payload)
      select tenant_id, message_id, 'bounced', '{"bounce":{"bounceType":"Permanent"}}'::jsonb
        from core.message_bodies where tenant_id = ${t} and trusted_template_id = ${tid} and html = 'x'
       limit 12`
    const revoked = await reviewTrusted(db, store, t, new Date())
    expect(revoked).toHaveLength(1)
    expect(revoked[0]!.category).toBe("bounces")
    expect((await store.get(t, tid))?.status).toBe("revoked")
    const cleared =
      await owner`select count(*)::int as n from core.content_fingerprints where tenant_id = ${t} and trusted_by is not null`
    expect(cleared[0]?.n).toBe(0)
    const events = await store.events(t, tid)
    expect(events.map((e) => e.action)).toEqual(["submit", "approve", "revoke"])
  })

  it("revokes every approval on a staff abuse label", async () => {
    const { trustedTemplateStore, reviewTrusted } =
      await import("../src/risk/trusted.js")
    const t = await trustTenant(`abuse-${RUN}.com`)
    const store = trustedTemplateStore(db)
    const r = await store.submit(
      t,
      { name: "Receipt", html: receipt("{{name}}", "1"), text: null },
      "user:risk-db",
    )
    if (!("template" in r)) throw new Error(r.error)
    await store.decide(t, r.template.id, "approve", "staff@i10", "fine")
    await labelStore(db).add({
      tenantId: t,
      label: "abuse",
      source: "staff",
      setBy: "staff@i10",
    })
    const revoked = await reviewTrusted(db, store, t, new Date())
    expect(revoked.map((x) => x.category)).toEqual(["abuse"])
  })

  it("leaves trusted vectors out of content neighbours and reports the evidence", async () => {
    const { storeContentVectors, contentNeighbours } =
      await import("../src/content/vectors.js")
    const { hashEmbedder } = await import("../src/content/embed.js")
    const { boilerplateStore } = await import("../src/risk/trusted.js")
    const { parseSubmission } = await import("../src/content/trust.js")
    const e = hashEmbedder()
    const text =
      `A unique weekly digest ${RUN}: new features shipped, three bugs fixed, and a note on ` +
      `the upcoming maintenance window for the reporting service next Tuesday.`
    const [v] = await e.embed([text])
    const day = new Date().toISOString().slice(0, 10)
    const [x, y, z] = [
      await trustTenant(`x-${RUN}.com`),
      await trustTenant(`y-${RUN}.com`),
      await trustTenant(`z-${RUN}.com`),
    ]
    await storeContentVectors(db, x!, e.model, [
      { day, exact: `n-${RUN}`, embedding: v! },
    ])
    await storeContentVectors(db, y!, e.model, [
      { day, exact: `n-${RUN}`, embedding: v!, trustedBy: "template:t" },
    ])
    let near = await contentNeighbours(db, x!, e.model, FREE, new Date())
    expect(near.similarPeers).toBe(0)
    expect(near.neighbours).toBe(0)

    await storeContentVectors(db, z!, e.model, [
      { day, exact: `n-${RUN}`, embedding: v! },
    ])
    near = await contentNeighbours(db, x!, e.model, FREE, new Date())
    expect(near.similarPeers).toBe(1)
    expect(near.neighbours).toBe(1)
    expect(near.bestSimilarity!).toBeGreaterThan(0.99)
    expect(near.medianSimilarity!).toBeGreaterThan(0.99)

    // The nearest boilerplate entry is named, as evidence only.
    const skeleton = parseSubmission({
      html: null,
      text: `${text} {{x}}`,
      holes: { x: 5 },
    })
    if ("error" in skeleton) throw new Error(skeleton.error)
    const [bv] = await e.embed([text])
    await boilerplateStore(db).add({
      name: `test/near-${RUN}`,
      skeleton,
      model: e.model,
      embedding: bv!,
      reason: "integration test",
      by: "risk-db",
    })
    const nearest = await boilerplateStore(db).nearest(x!, e.model, day)
    expect(nearest?.name).toBe(`test/near-${RUN}`)
    expect(nearest!.similarity).toBeGreaterThan(0.99)
  })
})
