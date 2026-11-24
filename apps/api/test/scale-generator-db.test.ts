import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { missingFixtures } from "../scripts/scale/fixtures.js"
import { PROFILES } from "../scripts/scale/profiles.js"
import { directUrl, reset, type Scratch } from "../scripts/scale/scratch.js"
import { seed } from "../scripts/scale/seed.js"
import { exportStats, scrubFrom } from "../scripts/scale/stats.js"
import { leaks } from "../scripts/scale/scrub.js"

/**
 * The generator's invariants against a real, migrated Postgres 18. Needs a
 * scratch made by `bun scripts/scale/cli.ts up --scratch dev` (it resets the
 * database from that scratch's migrated template, so never point it at anything
 * else), and pg_dump 18 on PATH for the scrub test:
 *
 *   DB_SCALE_TEST_PORT=55511 bun test test/scale-generator-db.test.ts
 */
// eslint-disable-next-line turbo/no-undeclared-env-vars -- a test-only switch, like the other *-db tests'
const PORT = process.env.DB_SCALE_TEST_PORT
const suite = PORT ? describe : describe.skip
const scratch: Scratch = { name: "dev", port: Number(PORT), poolerPort: null }
const ANCHOR = new Date("2026-11-20T12:00:00Z")

/**
 * Tables compared through a query instead of their raw rows, because the
 * database, not the generator, picks part of each row. The hourly usage rollup
 * spreads an hour over slots chosen by the writing backend's pid, so only the
 * per-hour sum is the seed's.
 */
const COMPARED_AS: Record<string, string> = {
  "core.meter_usage_hourly": `select tenant_id, feature_id, shard, hour, sum(used) as used
      from core.meter_usage_hourly group by 1, 2, 3, 4`,
}

/**
 * A content hash of every table, columns filled by volatile defaults left out
 * (`now()`, `uuidv7()`, the clock-seeded credential epoch, the writing
 * transaction's id) along with identity columns: those differ by design,
 * everything the generator chose must not.
 */
async function fingerprint(sql: postgres.Sql): Promise<Record<string, string>> {
  const cols = await sql<{ t: string; c: string }[]>`
    select n.nspname || '.' || c.relname as t, a.attname as c
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where n.nspname in ('core', 'identity', 'authd') and c.relkind in ('r', 'p') and not c.relispartition
       and a.attnum > 0 and not a.attisdropped and a.attidentity = ''
       and coalesce(pg_get_expr(d.adbin, d.adrelid), '') !~ '(now|uuidv7|gen_random_uuid|clock_timestamp|nextval|pg_current_xact_id)\\('
     order by 1, a.attnum`
  const byTable = new Map<string, string[]>()
  for (const { t, c } of cols) byTable.set(t, [...(byTable.get(t) ?? []), `"${c}"`])
  const out: Record<string, string> = {}
  for (const [t, cs] of byTable) {
    const rows = COMPARED_AS[t]
      ? `select r::text as x from (${COMPARED_AS[t]}) r`
      : `select row(${cs.join(", ")})::text as x from ${t}`
    const [r] = await sql.unsafe<{ h: string | null }[]>(
      `select md5(string_agg(x, E'\\n' order by x)) as h from (${rows}) s`,
    )
    if (r?.h) out[t] = r.h
  }
  return out
}

suite("the scale generator (small profile)", () => {
  let sql: postgres.Sql
  let first: Record<string, string>

  beforeAll(async () => {
    await reset(scratch)
    await seed({
      url: directUrl(scratch),
      profile: PROFILES.small,
      seed: 7,
      anchor: ANCHOR,
      chaos: false,
    })
    sql = postgres(directUrl(scratch), { max: 2, onnotice: () => {} })
    first = await fingerprint(sql)
  }, 120_000)

  afterAll(async () => {
    await sql?.end()
  })

  it("chaos off is byte-for-byte the same seed as the default", async () => {
    await sql.end()
    await reset(scratch)
    await seed({
      url: directUrl(scratch),
      profile: PROFILES.small,
      seed: 7,
      anchor: ANCHOR,
    })
    sql = postgres(directUrl(scratch), { max: 2, onnotice: () => {} })
    expect(await fingerprint(sql)).toEqual(first)
    expect(Object.keys(first).length).toBeGreaterThan(30)
  }, 120_000)

  it("refuses a database that already has workspaces", async () => {
    const outcome = await seed({
      url: directUrl(scratch),
      profile: PROFILES.small,
      seed: 7,
      anchor: ANCHOR,
    }).then(
      () => "seeded",
      (err: Error) => err.message,
    )
    expect(outcome).toContain("refusing to seed")
  })

  it("every fixture is in place", async () => {
    expect(await missingFixtures(sql)).toEqual([])
  })

  it("covers every lifecycle state", async () => {
    const states = async (q: string) =>
      (await sql.unsafe<{ s: string }[]>(q)).map((r) => r.s).sort()
    expect(await states(`select distinct status::text s from core.tenants`)).toEqual([
      "active",
      "deleted",
      "suspended",
    ])
    expect(await states(`select distinct status::text s from core.domains`)).toEqual([
      "failed",
      "not_started",
      "pending",
      "temporary_failure",
      "verified",
    ])
    expect(
      await states(`select distinct status::text s from core.webhook_deliveries`),
    ).toEqual(["delivered", "failed", "pending"])
    expect(
      (await states(`select distinct status::text s from core.messages`)).length,
    ).toBeGreaterThanOrEqual(4)
    const [gates] = await sql`
      select count(*) filter (where suspended_at is not null)::int s, count(*) filter (where payment_hold_at is not null)::int h,
             count(*) filter (where deleting_at is not null)::int d, count(*) filter (where not active)::int i,
             count(*) filter (where tenant_id is null)::int own from authd.accounts`
    for (const v of Object.values(gates!)) expect(Number(v)).toBeGreaterThan(0)
    const [sso] =
      await sql`select (select count(*) from authd.required_domains)::int r, (select count(*) from authd.required_exempt)::int e, (select count(*) from authd.managed_accounts)::int m`
    for (const v of Object.values(sso!)) expect(Number(v)).toBeGreaterThan(0)
  })

  it("is skewed: one huge workspace and a long tail", async () => {
    const [r] = await sql`
      with c as (select tenant_id, count(*) n from core.messages group by 1)
      select max(n)::int as top, percentile_disc(0.5) within group (order by n)::int as median from c`
    expect(r!.top).toBeGreaterThan(r!.median * 10)
  })

  it("has the variety that breaks naive comparisons", async () => {
    const [r] = await sql`
      select (select count(*) from core.tenants where name ~ '[֐-ۿ]')::int as rtl,
             (select count(*) from core.messages where subject ~ '[☀-➿]|[\uD83C-\uDBFF]' or subject like '%🎉%')::int as emoji,
             (select count(*) from core.tenants where name <> normalize(name, NFC))::int as combining,
             (select count(*) from core.contacts where email <> lower(email))::int as mixed_case,
             (select count(*) from core.messages where length(subject) > 200)::int as long_subject,
             (select count(*) from core.domains d where exists (select 1 from core.domains e where e.name = d.name and e.tenant_id <> d.tenant_id))::int as claimed_twice`
    for (const [k, v] of Object.entries(r!))
      expect([k, Number(v) > 0]).toEqual([k, true])
  })

  it("keeps the invariants the product relies on", async () => {
    const [r] = await sql`
      select (select count(*) from authd.accounts where email <> lower(email))::int as upper_mailboxes,
             (select count(*) from core.messages m join core.domains d on d.id = m.domain_id where d.tenant_id <> m.tenant_id)::int as foreign_domain,
             (select count(*) from core.domains group by name, status having status = 'verified' and count(*) > 1 limit 1)::int as twice_verified`
    expect(r!.upper_mailboxes).toBe(0)
    expect(r!.foreign_domain).toBe(0)
    expect(r!.twice_verified ?? 0).toBe(0)
  })

  it("its statistics scrub without leaking a value", async () => {
    const dump = await exportStats(directUrl(scratch))
    expect(dump).toContain("pg_restore_attribute_stats")
    const { result, kinds } = await scrubFrom(sql, dump)
    const [account] = await sql<
      { email: string }[]
    >`select email from authd.accounts order by email limit 1`
    expect(dump).toContain(account!.email.split("@")[1]!)
    expect(result.originals.length).toBeGreaterThan(100)
    expect(leaks(result, kinds)).toEqual([])
  }, 60_000)
})
