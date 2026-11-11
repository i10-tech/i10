import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import type { Evaluated } from "./engine.js"
import type {
  Band,
  ClearedContribution,
  Contribution,
  Facts,
  ShadowContribution,
} from "./types.js"

/**
 * The facts a score was computed from, kept so a rule change can be replayed
 * against them (replay.ts). See docs/decisions/risk.md, "Snapshots, replay and
 * shadow rules".
 *
 * ⚠ CADENCE: A SNAPSHOT WHENEVER THE EVENT LOG WRITES AN EVENT, AND OTHERWISE
 * THE FIRST SCORE OF EACH UTC DAY. An event (first assessment, band change,
 * EVENT_SWING points, an action) is what an appeal asks about, so its facts are
 * always kept; a quiet workspace costs one row a day, not twenty-four. The
 * definer `risk_fact_snapshot_save` enforces it.
 */
export const SNAPSHOT_RETENTION_DAYS = 180

/** `Facts` as JSON: every `Date` becomes `{ "$date": iso }`, and nothing else changes. */
export type SerialisedFacts = Json
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

const DATE = "$date"

export function serialiseFacts(facts: Facts): SerialisedFacts {
  return encode(facts)
}

function encode(v: unknown): Json {
  if (v instanceof Date) return { [DATE]: v.toISOString() }
  if (Array.isArray(v)) return v.map(encode)
  if (v !== null && typeof v === "object") {
    const out: { [key: string]: Json } = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x)
    return out
  }
  return v as Json
}

/**
 * Facts back from a snapshot.
 *
 * ⚠ THE SHAPE IS NOT CHECKED, ON PURPOSE. A snapshot taken under an older
 * ruleset may lack a field a newer rule reads; that rule then throws inside
 * `evaluate`, which reports it as a rule failure and scores the rest. Refusing
 * the whole snapshot would hide how many old snapshots a new rule can read.
 */
export function reviveFacts(json: unknown): Facts {
  return decode(json) as Facts
}

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode)
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1 && keys[0] === DATE && typeof o[DATE] === "string")
      return new Date(o[DATE])
    return Object.fromEntries(keys.map((k) => [k, decode(o[k])]))
  }
  return v
}

export interface FactSnapshot {
  id: string
  tenantId: string
  takenAt: Date
  rulesetVersion: number
  trigger: string
  score: number
  band: Band
  contributions: Contribution[]
  shadow: ShadowContribution[]
  cleared: ClearedContribution[]
  /** Serialised: pass through `reviveFacts`. */
  facts: unknown
}

/** What can run a statement: the database, or a transaction already open on it. */
type Executor = Pick<Database, "execute">

export interface SnapshotStore {
  /**
   * Writes one unless `force` is false and the workspace has one today (UTC).
   * Returns its id, or null when it declined. `through` runs it inside a
   * caller's transaction.
   */
  record(input: {
    tenantId: string
    at: Date
    trigger: string
    evaluated: Pick<
      Evaluated,
      "score" | "band" | "rulesetVersion" | "contributions" | "shadow" | "cleared"
    >
    facts: Facts
    force: boolean
    through?: Executor
  }): Promise<string | null>
  /** One page, oldest first; pass the last row back as `after` for the next. */
  list(input: {
    since: Date
    until: Date
    tenantId?: string
    after?: Pick<FactSnapshot, "takenAt" | "id">
    limit: number
  }): Promise<FactSnapshot[]>
  /** Deletes snapshots taken before `before`; returns how many. */
  purge(before: Date): Promise<number>
}

export function snapshotStore(db: Database): SnapshotStore {
  return {
    async record({ tenantId, at, trigger, evaluated: e, facts, force, through = db }) {
      const rows = (await through.execute(sql`
        select core.risk_fact_snapshot_save(
          ${tenantId}::uuid, ${at.toISOString()}::timestamptz, ${e.rulesetVersion},
          ${trigger}, ${e.score}, ${e.band}::core.risk_band,
          ${JSON.stringify(e.contributions)}::jsonb, ${JSON.stringify(e.shadow)}::jsonb,
          ${JSON.stringify(e.cleared)}::jsonb,
          ${JSON.stringify(serialiseFacts(facts))}::jsonb, ${force}
        ) as id
      `)) as unknown as { id: string | null }[]
      return rows[0]?.id ? String(rows[0].id) : null
    },

    async list({ since, until, tenantId, after, limit }) {
      const rows = (await db.execute(sql`
        select * from core.risk_fact_snapshots_list(
          ${since.toISOString()}::timestamptz, ${until.toISOString()}::timestamptz,
          ${tenantId ?? null}::uuid, ${after ? after.takenAt.toISOString() : null}::timestamptz,
          ${after?.id ?? null}::uuid, ${limit}
        )
      `)) as unknown as Record<string, unknown>[]
      return rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        takenAt: new Date(r.taken_at as string),
        rulesetVersion: Number(r.ruleset_version),
        trigger: String(r.trigger),
        score: Number(r.score),
        band: r.band as Band,
        contributions: r.contributions as Contribution[],
        shadow: r.shadow as ShadowContribution[],
        cleared: r.cleared as ClearedContribution[],
        facts: r.facts,
      }))
    },

    async purge(before) {
      const rows = (await db.execute(
        sql`select core.risk_fact_snapshots_purge(${before.toISOString()}::timestamptz) as n`,
      )) as unknown as { n: number }[]
      return Number(rows[0]?.n ?? 0)
    },
  }
}
