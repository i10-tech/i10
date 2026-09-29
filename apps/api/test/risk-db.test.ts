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
    const { processContent } = await import("../src/content/job.js")
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

    const first = await processContent(ids.clean, { db, promoteAt: 3 })
    expect(first.derived).toBeGreaterThan(0)
    expect(first.matched).toBe(5)
    expect(first.compacted).toBe(5)
    expect(first.bytesSaved).toBeGreaterThan(0)

    const [tmpl] =
      await owner`select messages from core.content_templates where tenant_id = ${ids.clean}`
    expect(tmpl?.messages).toBe(5)
    const again = await processContent(ids.clean, { db, promoteAt: 3 })
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
    const { processContent } = await import("../src/content/job.js")
    await seedSent(ids.e, receipt("A", "1"))
    await seedSent(ids.e, receipt("B", "2"))
    const r = await processContent(ids.e, { db, promoteAt: 3 })
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
      features: {},
      setBy: "mo",
    })
    expect(
      (await contentNeighbours(db, bystander, e.model, FREE, new Date()))
        .taintedSimilar,
    ).toBe(1)
  })

  it("finds labelled behavioural neighbours and counts an actor's velocity", async () => {
    const { storeBehaviour, behaviourNeighbours, actorVelocity } =
      await import("../src/content/vectors.js")
    const { features } = await import("../src/risk/model.js")
    const { loadFacts } = await import("../src/risk/facts.js")
    for (const id of [ids.a, ids.b, ids.c, ids.d, ids.clean]) {
      const f = await loadFacts(id, {
        db,
        freePlanId: FREE,
        ownerInfo: async () => null,
      })
      await storeBehaviour(db, id, features(f))
    }
    const labels = labelStore(db)
    for (const id of [ids.a, ids.c, ids.d]) {
      await labels.add({
        tenantId: id,
        label: "abuse",
        source: "staff",
        features: {},
        setBy: "mo",
      })
    }
    await labels.add({
      tenantId: ids.clean,
      label: "legit",
      source: "staff",
      features: {},
      setBy: "mo",
    })
    const n = await behaviourNeighbours(db, ids.b, 10)
    expect(n.labelled).toBe(4)
    expect(n.abuse).toBe(3)

    const [t] =
      await owner`select owner_clerk_user_id from core.tenants where id = ${ids.a}`
    const v = await actorVelocity(db, t!.owner_clerk_user_id)
    expect(v.linkedPeople).toBeGreaterThanOrEqual(4)
    expect(v.workspaces24h).toBeGreaterThanOrEqual(4)
  })
})
