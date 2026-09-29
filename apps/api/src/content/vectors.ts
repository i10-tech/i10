import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { BEHAVIOUR_FEATURES, type Features } from "../risk/model.js"

/**
 * The vectors (#170): content embeddings and behaviour points, and the
 * questions asked of them.
 *
 * ⚠ OBSERVATIONS IN, NUMBERS OUT. Every cross-workspace question returns
 * counts and distances through a definer function (migration 0072); no
 * workspace ever reads another's vectors, and no answer depends on another
 * workspace's SCORE - only on its content, its behaviour and human verdicts.
 */

/** How close two contents must be to count as "the same mail", per embedder. */
export const SIMILAR: Readonly<Record<string, number>> = {
  "minilm-l6-v2-q8": 0.85,
  "hash-v1": 0.8,
}
export const similarityFor = (model: string) => SIMILAR[model] ?? 0.9

const literal = (v: readonly number[]) =>
  `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`

export async function storeContentVectors(
  db: Database,
  tenantId: string,
  model: string,
  rows: { day: string; exact: string; embedding: number[] }[],
): Promise<number> {
  if (rows.length === 0) return 0
  await withTenant(db, tenantId, async (tx) => {
    for (const r of rows) {
      await tx.execute(sql`
        insert into core.content_vectors (tenant_id, day, exact, model, embedding)
        values (${tenantId}::uuid, ${r.day}::date, ${r.exact}, ${model}, ${literal(r.embedding)}::halfvec)
        on conflict do nothing
      `)
    }
  })
  return rows.length
}

/** Which of these fingerprints already have a vector from this model. */
export async function embeddedAlready(
  db: Database,
  tenantId: string,
  model: string,
  exacts: string[],
): Promise<Set<string>> {
  if (exacts.length === 0) return new Set()
  const rows = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select exact from core.content_vectors
       where tenant_id = ${tenantId}::uuid and model = ${model}
         and exact = any(${`{${exacts.join(",")}}`}::text[])
    `),
  )) as unknown as { exact: string }[]
  return new Set(rows.map((r) => r.exact))
}

/**
 * How each behaviour feature is scaled before distances are taken.
 *
 * ⚠ FIXED SCALES, NOT FITTED ONES. Rates live around 0.01 and log-counts
 * around 5; unscaled, distance would be decided by whichever feature happens
 * to be largest. A scale is roughly "the size of a difference that matters".
 * Fixed, so a vector stored today is comparable with one stored next month.
 */
const SCALE: Partial<Record<(typeof BEHAVIOUR_FEATURES)[number], number>> = {
  age_days_log: 2,
  hard_bounce_7d: 0.05,
  complaint_7d: 0.1,
  soft_bounce_7d: 0.1,
  hard_bounce_24h: 0.05,
  sends_7d_log: 3,
  early_bounce: 0.05,
  unsubscribe_7d: 0.02,
  quota_days_7d: 2,
  api_error_rate: 0.3,
  key_countries: 2,
  domain_age_log: 3,
}

export function behaviourVector(features: Features): number[] {
  return BEHAVIOUR_FEATURES.map((name) => {
    const v = features[name] / (SCALE[name] ?? 1)
    return Math.max(-5, Math.min(5, Number.isFinite(v) ? v : 0))
  })
}

export async function storeBehaviour(
  db: Database,
  tenantId: string,
  features: Features,
) {
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      insert into core.behaviour_vectors (tenant_id, embedding, updated_at)
      values (${tenantId}::uuid, ${literal(behaviourVector(features))}::vector, now())
      on conflict (tenant_id) do update set embedding = excluded.embedding, updated_at = now()
    `),
  )
}

export interface ContentNeighbours {
  model: string
  similarPeers: number
  youngFreeSimilar: number
  taintedSimilar: number
  bestTaintedSimilarity: number | null
}

export async function contentNeighbours(
  db: Database,
  tenantId: string,
  model: string,
  freePlanId: string,
  now: Date,
): Promise<ContentNeighbours> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  const rows = (await db.execute(sql`
    select * from core.content_neighbors(${tenantId}::uuid, ${model}, ${since}::date, ${similarityFor(model)}::real, ${freePlanId})
  `)) as unknown as Record<string, unknown>[]
  const r = rows[0] ?? {}
  return {
    model,
    similarPeers: Number(r.similar_peers ?? 0),
    youngFreeSimilar: Number(r.young_free_similar ?? 0),
    taintedSimilar: Number(r.tainted_similar ?? 0),
    bestTaintedSimilarity:
      r.best_tainted_similarity == null ? null : Number(r.best_tainted_similarity),
  }
}

export interface BehaviourNeighbours {
  labelled: number
  abuse: number
  legit: number
  meanAbuseDistance: number | null
  nearestDistance: number | null
}

export async function behaviourNeighbours(
  db: Database,
  tenantId: string,
  k = 10,
): Promise<BehaviourNeighbours> {
  const rows = (await db.execute(
    sql`select * from core.behaviour_neighbors(${tenantId}::uuid, ${k})`,
  )) as unknown as Record<string, unknown>[]
  const r = rows[0] ?? {}
  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    labelled: Number(r.labelled ?? 0),
    abuse: Number(r.abuse ?? 0),
    legit: Number(r.legit ?? 0),
    meanAbuseDistance: num(r.mean_abuse_distance),
    nearestDistance: num(r.nearest_distance),
  }
}

export interface ActorVelocity {
  linkedPeople: number
  workspaces24h: number
  workspaces7d: number
  linkedWorkspaces: number
  linkedTainted: number
  domains24h: number
  keys24h: number
}

export async function actorVelocity(
  db: Database,
  owner: string,
): Promise<ActorVelocity> {
  const rows = (await db.execute(
    sql`select * from core.actor_velocity(${owner})`,
  )) as unknown as Record<string, unknown>[]
  const r = rows[0] ?? {}
  return {
    linkedPeople: Number(r.linked_people ?? 1),
    workspaces24h: Number(r.workspaces_24h ?? 0),
    workspaces7d: Number(r.workspaces_7d ?? 0),
    linkedWorkspaces: Number(r.linked_workspaces ?? 0),
    linkedTainted: Number(r.linked_tainted ?? 0),
    domains24h: Number(r.domains_24h ?? 0),
    keys24h: Number(r.keys_24h ?? 0),
  }
}

/** Content vectors older than the fingerprints' 30 days. */
export async function purgeVectors(db: Database, tenantId: string, now: Date) {
  const before = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
  await withTenant(db, tenantId, (tx) =>
    tx.execute(
      sql`delete from core.content_vectors where tenant_id = ${tenantId}::uuid and day < ${before}::date`,
    ),
  )
}
