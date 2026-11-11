import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"

/**
 * The vectors (#170): content embeddings, and the questions asked of them.
 *
 * ⚠ OBSERVATIONS IN, NUMBERS OUT. Every cross-workspace question returns
 * counts and distances through a definer function (migration 0072); no
 * workspace ever reads another's vectors, and no answer depends on another
 * workspace's SCORE - only on its content and human verdicts.
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
  rows: {
    day: string
    exact: string
    embedding: number[]
    trustedBy?: string | null
  }[],
): Promise<number> {
  if (rows.length === 0) return 0
  await withTenant(db, tenantId, async (tx) => {
    for (const r of rows) {
      await tx.execute(sql`
        insert into core.content_vectors (tenant_id, day, exact, model, embedding, trusted_by)
        values (${tenantId}::uuid, ${r.day}::date, ${r.exact}, ${model}, ${literal(r.embedding)}::halfvec, ${r.trustedBy ?? null})
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

export interface ContentNeighbours {
  model: string
  similarPeers: number
  youngFreeSimilar: number
  taintedSimilar: number
  bestTaintedSimilarity: number | null
  neighbours: number
  medianSimilarity: number | null
  bestSimilarity: number | null
  /** Opaque digests (`peer:<digest>`) of the young free and the tainted neighbours. */
  youngFreePeerKeys: string[]
  taintedPeerKeys: string[]
}

/** A text[] of digests from a definer, as evidence keys. */
export const peerKeys = (v: unknown, kind: "peer" | "user"): string[] =>
  Array.isArray(v) ? v.map((d) => `${kind}:${String(d)}`).sort() : []

const numOrNull = (v: unknown) => (v == null ? null : Number(v))

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
    bestTaintedSimilarity: numOrNull(r.best_tainted_similarity),
    neighbours: Number(r.neighbours ?? 0),
    medianSimilarity: numOrNull(r.median_similarity),
    bestSimilarity: numOrNull(r.best_similarity),
    youngFreePeerKeys: peerKeys(r.young_free_keys, "peer"),
    taintedPeerKeys: peerKeys(r.tainted_keys, "peer"),
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
