/**
 * Fills a freshly migrated scratch database: the world, the mail, the
 * fixtures, then ANALYZE. Deterministic in (profile, seed, anchor).
 *
 * ⚠ IT REFUSES ANY DATABASE THAT ALREADY HAS A WORKSPACE, or that is not on
 * loopback. It is for `scratch.ts` databases only.
 */
import postgres from "postgres"
import { loadFixtures, missingFixtures } from "./fixtures.js"
import type { Profile } from "./profiles.js"
import { seedMail } from "./seed-mail.js"
import { seedWorld } from "./seed-world.js"
import { seedChaos } from "./chaos.js"

export interface SeedOptions {
  url: string
  profile: Profile
  seed: number
  /** "Now" for the data. Default: the start of the current hour, UTC. */
  anchor?: Date
  fixtures?: boolean
  chaos?: boolean
  log?: (m: string) => void
}

export interface SeedSummary {
  profile: string
  seed: number
  anchor: string
  seconds: number
  rows: Record<string, number>
  chaos?: {
    generated: number
    protected: number
    skipped: number
    seconds: number
    report: string
  }
}

export function defaultAnchor(now = new Date()): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
}

export function assertScratch(url: string): void {
  const host = new URL(url).hostname
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(`refusing to seed ${host}: scratch databases are loopback only`)
  }
}

export async function seed(o: SeedOptions): Promise<SeedSummary> {
  assertScratch(o.url)
  const log = o.log ?? (() => {})
  const anchor = o.anchor ?? defaultAnchor()
  const started = Date.now()
  const sql = postgres(o.url, { max: 10, onnotice: () => {}, connect_timeout: 10 })
  try {
    const [{ n } = { n: 0 }] = await sql<
      { n: number }[]
    >`select count(*)::int as n from core.tenants`
    if (n > 0) throw new Error(`refusing to seed: core.tenants already has ${n} rows`)
    const world = await seedWorld(sql, o.profile, o.seed, anchor, log)
    await seedMail(sql, o.profile, o.seed, world, log)
    if (o.fixtures !== false) {
      await loadFixtures(sql, anchor)
      const missing = await missingFixtures(sql)
      if (missing.length)
        throw new Error(`fixtures missing after load: ${missing.join("; ")}`)
      log("fixtures")
    }
    const chaos = o.chaos ? await seedChaos(sql, o.seed, log) : undefined
    await sql`analyze`
    log("analyze")
    return {
      profile: o.profile.name,
      seed: o.seed,
      anchor: anchor.toISOString(),
      seconds: Math.round((Date.now() - started) / 1000),
      rows: await rowCounts(sql),
      ...(chaos ? { chaos } : {}),
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Exact row counts of every non-empty table in the product schemas (partitions folded into parents). */
export async function rowCounts(sql: postgres.Sql): Promise<Record<string, number>> {
  const tables = await sql<{ t: string }[]>`
    select n.nspname || '.' || c.relname as t
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('core', 'identity', 'authd') and c.relkind in ('r', 'p') and not c.relispartition
     order by 1`
  const out: Record<string, number> = {}
  for (const { t } of tables) {
    const [row] = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${t}`,
    )
    if (row && row.n > 0) out[t] = row.n
  }
  return out
}
