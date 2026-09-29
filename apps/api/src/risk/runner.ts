import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { htmlToText } from "./fingerprint.js"
import { act, type ActDeps } from "./act.js"
import { decide } from "./decide.js"
import { evaluate } from "./engine.js"
import { loadFacts, type OwnerInfo } from "./facts.js"
import {
  ipinfoLookup,
  layaClassify,
  rdapRegistered,
  refreshTorExits,
  webRiskLookup,
  type Fetch,
} from "./intel.js"
import type { LabelStore, ModelRecord } from "./labels.js"
import { features, predict } from "./model.js"
import { registrable } from "./rules.js"
import { bandRank, type Assessment, type Band } from "./types.js"
import type { Embedder } from "../content/embed.js"
import { processContent } from "../content/job.js"
import { restoreBodies } from "../content/restore.js"
import { purgeVectors, storeBehaviour } from "../content/vectors.js"

/**
 * Running the score (#170): one workspace, or all of them.
 *
 * ⚠ IDEMPOTENT BY CONSTRUCTION, AND THEN LOCKED ANYWAY. Every action is safe
 * to repeat - a tier already strict writes nothing, a second hold is refused
 * by the primary key, SES's policy is a state, an alert fires only on a band
 * RISE - so two runs over the same workspace converge. But two runs at the
 * same moment (the hourly job, an SES event, a farm tripwire) could each read
 * the same previous band and each write an event for the same rise. A lease
 * per workspace in Redis serialises them; the loser skips, because the winner
 * is computing the same answer from the same facts.
 *
 * ⚠ AT SCALE THE HOURLY RUN SCORES WHAT CHANGED, NOT EVERYTHING. Accept, the
 * SES webhook and identity sightings mark a workspace dirty; the hourly run
 * scores the dirty set, anything not scored in 24 hours, and anything already
 * elevated or held (whose evidence ages even when nothing new happens). A
 * quiet workspace costs one score a day however many there are.
 */
export interface RiskLockRedis {
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
    nx: "NX",
  ): Promise<unknown>
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>
  sadd(key: string, ...members: string[]): Promise<number>
  spop(key: string, count: number): Promise<string[]>
  get(key: string): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<unknown>
}

export interface RiskSwitches {
  enabled: boolean
  tiers: boolean
  holds: boolean
  sesPolicy: boolean
}

export interface RiskDeps {
  db: Database
  freePlanId: string
  ownerInfo: (clerkUserId: string) => Promise<OwnerInfo | null>
  act: ActDeps
  labels: LabelStore
  switches: RiskSwitches
  redis?: RiskLockRedis
  /**
   * Turns content into vectors (content/embed.ts). Absent: no content vectors
   * are made and the similarity facts are not consulted.
   */
  embedder?: Embedder
  /** The model name to compare vectors under, where no embedder is loaded (the API). */
  contentModel?: string
  /** Workspaces the score never touches: our own system tenant. */
  exempt?: ReadonlySet<string>
  /** The active model, loaded once per run by the caller. */
  model?: ModelRecord | null
  laya?: { url: string; apiKey?: string }
  fetch?: Fetch
  log?: {
    info?: (o: object, m: string) => void
    warn?: (o: object, m: string) => void
    error?: (o: object, m: string) => void
  }
  now?: () => Date
}

export interface ScoreResult {
  tenantId: string
  status: "scored" | "locked" | "disabled" | "exempt"
  score?: number
  band?: Band
  actions?: string[]
}

const LOCK_SECONDS = 120
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
export const DIRTY_KEY = "risk:dirty"

/** Marks workspaces for the next run. Cheap, fire-and-forget, safe to repeat. */
export async function markDirty(
  redis: Pick<RiskLockRedis, "sadd"> | undefined,
  tenantIds: string[],
) {
  if (!redis || tenantIds.length === 0) return
  await redis.sadd(DIRTY_KEY, ...tenantIds).catch(() => {})
}

export async function scoreTenant(
  tenantId: string,
  trigger: string,
  deps: RiskDeps,
): Promise<ScoreResult> {
  if (!deps.switches.enabled) return { tenantId, status: "disabled" }
  // ⚠ OUR OWN WORKSPACE IS NEVER SCORED. It carries every sign-in code and
  // notice the product sends; a hold on it would lock every customer out.
  if (deps.exempt?.has(tenantId)) return { tenantId, status: "exempt" }
  const token = randomUUID()
  const lockKey = `risk:lock:${tenantId}`
  if (deps.redis) {
    const got = await deps.redis
      .set(lockKey, token, "EX", LOCK_SECONDS, "NX")
      .catch(() => "OK")
    if (got === null) return { tenantId, status: "locked" }
  }
  try {
    return await scoreLocked(tenantId, trigger, deps)
  } finally {
    await deps.redis?.eval(RELEASE, 1, lockKey, token).catch(() => {})
  }
}

async function scoreLocked(
  tenantId: string,
  trigger: string,
  deps: RiskDeps,
): Promise<ScoreResult> {
  const now = deps.now?.() ?? new Date()
  const previous = await deps.act.assessments.current(tenantId)
  const facts = await loadFacts(tenantId, {
    db: deps.db,
    freePlanId: deps.freePlanId,
    ownerInfo: deps.ownerInfo,
    now,
    ...(deps.embedder || deps.contentModel
      ? { contentModel: deps.embedder?.model ?? deps.contentModel! }
      : {}),
  })

  // ── Content classifier: only where there is already reason to look ──
  if (
    deps.laya &&
    (bandRank(previous?.band ?? "low") >= 1 || facts.farm.peers.length > 0)
  ) {
    facts.content = await classifyContent(tenantId, deps).catch((error: unknown) => {
      deps.log?.warn?.({ err: error, tenantId }, "content classifier unavailable")
      return null
    })
  }

  // ── The model: one explained rule, only when active ──
  const feats = features(facts)
  let modelScore: number | null = null
  if (deps.model?.active) {
    modelScore = predict(deps.model.weights, feats)
    facts.model = { probability: modelScore, version: deps.model.version }
  }

  // ⚠ THE BEHAVIOUR POINT IS STORED FROM OBSERVATIONS, BEFORE ANY SCORE. It is
  // what the NEXT workspace is compared with; the neighbours this one was just
  // compared with came from the previous run's points. Nothing here reads a
  // score.
  await storeBehaviour(deps.db, tenantId, feats).catch((error: unknown) =>
    deps.log?.warn?.({ err: error, tenantId }, "could not store the behaviour vector"),
  )

  const assessment: Assessment = evaluate(facts)
  const hold = await deps.act.holds.current(tenantId)
  const { bandSince, actions } = decide({
    now,
    plan: facts.plan,
    assessment,
    previous,
    tier: { tier: facts.history.tier, source: facts.history.tierSource },
    hold: hold
      ? { reviewDueAt: hold.reviewDueAt, reviewAlertedAt: hold.reviewAlertedAt }
      : null,
    switches: deps.switches,
    previousRules: previous?.contributions.map((c) => c.rule) ?? [],
  })

  const moveFrom = previous ? { band: previous.band, score: previous.score } : null
  // ⚠ THE ROW IS WRITTEN BEFORE ACTING AND THE EVENT AFTER. The actions' own
  // writes (SES policy, alerted-at) update a row that must exist, a crash
  // mid-action still leaves the score behind, and the one event row records
  // both the move and what was done about it.
  await deps.act.assessments.save({
    tenantId,
    assessment,
    bandSince,
    modelScore,
    previous: moveFrom,
    actions: [],
    trigger,
    at: now,
    writeEvent: false,
  })
  const done = await act(tenantId, actions, deps.act, now, {
    score: assessment.score,
    band: assessment.band,
    trigger,
    top: assessment.contributions
      .slice(0, 3)
      .map((c) => `${c.rule}:${c.points}`)
      .join(" "),
  })
  await deps.act.assessments.save({
    tenantId,
    assessment,
    bandSince,
    modelScore,
    previous: moveFrom,
    actions: done,
    trigger,
    at: now,
  })

  await autoLabels(
    tenantId,
    facts,
    feats as unknown as Record<string, number>,
    assessment,
    previous,
    deps,
    now,
  )
  deps.log?.info?.(
    {
      tenantId,
      score: assessment.score,
      band: assessment.band,
      trigger,
      actions: done,
    },
    "risk scored",
  )
  return {
    tenantId,
    status: "scored",
    score: assessment.score,
    band: assessment.band,
    actions: done,
  }
}

/**
 * Labels the world gave us, recorded as they happen (see labels.ts).
 *
 * ⚠ NEVER THE SCORE'S OWN VERDICT. An AWS-managed pause is AWS's judgement,
 * and a long clean record is the customer's; a hold the score placed is
 * labelled only when a person upholds or releases it (risk-admin).
 */
async function autoLabels(
  tenantId: string,
  facts: Awaited<ReturnType<typeof loadFacts>>,
  feats: Record<string, number>,
  assessment: Assessment,
  previous: Awaited<ReturnType<ActDeps["assessments"]["current"]>>,
  deps: RiskDeps,
  now: Date,
) {
  const DAY = 86_400_000
  try {
    const awsPause = facts.ses.pauses.find(
      (p) =>
        p.origin?.toLowerCase().includes("aws") &&
        now.getTime() - p.at.getTime() < 7 * DAY,
    )
    if (
      awsPause &&
      !(await deps.labels.has(
        tenantId,
        "ses_aws_pause",
        new Date(now.getTime() - 30 * DAY),
      ))
    ) {
      await deps.labels.add({
        tenantId,
        label: "abuse",
        source: "ses_aws_pause",
        features: feats,
        setBy: "risk-score",
      })
    }
    const settledLow =
      assessment.band === "low" &&
      previous?.band === "low" &&
      now.getTime() - previous.bandSince.getTime() >= 60 * DAY
    if (
      settledLow &&
      now.getTime() - facts.createdAt.getTime() >= 90 * DAY &&
      facts.rates.day7.sends >= 250 &&
      !(await deps.labels.has(tenantId, "tenure", new Date(now.getTime() - 90 * DAY)))
    ) {
      await deps.labels.add({
        tenantId,
        label: "legit",
        source: "tenure",
        features: feats,
        setBy: "risk-score",
      })
    }
  } catch (error) {
    deps.log?.warn?.({ err: error, tenantId }, "could not record an automatic label")
  }
}

/** One recent message, classified, cached for six hours. */
async function classifyContent(tenantId: string, deps: RiskDeps) {
  const cacheKey = `risk:content:${tenantId}`
  const cached = await deps.redis?.get(cacheKey).catch(() => null)
  if (cached) {
    const c = JSON.parse(cached) as { probability: number; at: string }
    return { probability: c.probability, at: new Date(c.at) }
  }
  const rows = await withTenant(deps.db, tenantId, async (tx) => {
    const raw = (await tx.execute(sql`
      select m.subject, b.text, b.html, b.template_id, b.template_values
        from core.messages m join core.message_bodies b on b.message_id = m.id
       where m.tenant_id = ${tenantId}::uuid
         and m.created_at > now() - interval '24 hours'
       order by m.created_at desc
       limit 1
    `)) as unknown as {
      subject: string
      text: string | null
      html: string | null
      template_id: string | null
      template_values: unknown
    }[]
    // A compacted body reads like a full one (#171).
    return restoreBodies(
      tx,
      raw.map((r) => ({
        ...r,
        templateId: r.template_id,
        templateValues: r.template_values,
      })),
    )
  })
  const m = rows[0]
  if (!m || !deps.laya) return null
  const text = `${m.subject}\n\n${m.text ?? (m.html ? htmlToText(m.html) : "")}`
  const probability = await layaClassify(deps.laya, text, deps.fetch)
  if (probability === null) return null
  const at = new Date()
  await deps.redis
    ?.setex(cacheKey, 6 * 3600, JSON.stringify({ probability, at }))
    .catch(() => {})
  return { probability, at }
}

// ─── The hourly run ──────────────────────────────────────────────────────────

export interface HousekeepingDeps {
  ipinfoToken?: string
  webRiskKey?: string
  torRedis?: import("ioredis").Redis
}

export interface RunSummary {
  candidates: number
  scored: number
  locked: number
  failed: number
  bands: Record<Band, number>
  held: number
  tor: number | null
  enriched: number
  purged: number
  rdap: number
  webRisk: number
  unsafe: number
  retrained: string | null
  content: {
    scanned: number
    derived: number
    compacted: number
    bytesSaved: number
    embedded: number
  }
}

/**
 * Chooses who to score this hour.
 *
 * ⚠ THE DIRTY SET IS POPPED, NOT READ. A workspace marked while this run is
 * working lands in the set again for the next one, and nothing is scored
 * twice for one mark.
 */
export async function candidates(deps: RiskDeps, now: Date): Promise<string[]> {
  const all = (await deps.db.execute(
    sql`select tenant_id from core.risk_tenants_to_score()`,
  )) as unknown as {
    tenant_id: string
  }[]
  const live = new Set(
    all.map((r) => String(r.tenant_id)).filter((id) => !deps.exempt?.has(id)),
  )
  if (!deps.redis) return [...live]

  const dirty = new Set<string>()
  for (;;) {
    const batch = await deps.redis.spop(DIRTY_KEY, 1_000).catch(() => [] as string[])
    for (const id of batch) if (live.has(id)) dirty.add(id)
    if (batch.length < 1_000) break
  }
  // Stale or worrying ones, from each workspace's own row.
  const stale: string[] = []
  for (const id of live) {
    if (dirty.has(id)) continue
    const current = await deps.act.assessments.current(id).catch(() => null)
    if (
      !current ||
      now.getTime() - current.computedAt.getTime() > 23 * 3_600_000 ||
      bandRank(current.band) >= 1
    ) {
      stale.push(id)
    }
  }
  return [...dirty, ...stale]
}

export async function runAll(
  deps: RiskDeps & HousekeepingDeps,
  { concurrency = 4 }: { concurrency?: number } = {},
): Promise<RunSummary> {
  const now = deps.now?.() ?? new Date()
  const summary: RunSummary = {
    candidates: 0,
    scored: 0,
    locked: 0,
    failed: 0,
    bands: { low: 0, elevated: 0, high: 0, critical: 0 },
    held: 0,
    tor: null,
    enriched: 0,
    purged: 0,
    rdap: 0,
    webRisk: 0,
    unsafe: 0,
    retrained: null,
    content: { scanned: 0, derived: 0, compacted: 0, bytesSaved: 0, embedded: 0 },
  }

  // ── Housekeeping first: fresher intel means a better score this hour ──
  if (deps.torRedis) {
    summary.tor = await refreshTorExits(deps.torRedis, deps.fetch).catch(
      (error: unknown) => {
        deps.log?.warn?.({ err: error }, "could not refresh the Tor exit list")
        return null
      },
    )
  }
  if (deps.ipinfoToken)
    summary.enriched = await enrichIdentities(deps, deps.ipinfoToken)
  summary.purged = await purgeIdentities(deps, now)

  const ids = await candidates(deps, now)
  summary.candidates = ids.length

  let cursor = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, ids.length)) },
    async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]!
        try {
          summary.rdap += await refreshRdap(deps, id)
          if (deps.webRiskKey) {
            const r = await checkLinks(deps, id, deps.webRiskKey)
            summary.webRisk += r.checked
            summary.unsafe += r.unsafe
          }
          await purgeContent(deps, id, now)
          // ⚠ CONTENT BEFORE THE SCORE, so this hour's vectors are the ones it
          // compares. Its failure costs this workspace's content pass, not its score.
          try {
            const c = await processContent(id, {
              db: deps.db,
              ...(deps.embedder ? { embedder: deps.embedder } : {}),
              now,
              ...(deps.log ? { log: deps.log } : {}),
            })
            summary.content.scanned += c.scanned
            summary.content.derived += c.derived
            summary.content.compacted += c.compacted
            summary.content.bytesSaved += c.bytesSaved
            summary.content.embedded += c.embedded
            await purgeVectors(deps.db, id, now)
          } catch (error) {
            deps.log?.warn?.({ err: error, tenantId: id }, "content pass failed")
          }
          const r = await scoreTenant(id, "hourly", deps)
          if (r.status === "locked") summary.locked++
          if (r.status === "scored") {
            summary.scored++
            if (r.band) summary.bands[r.band]++
            if (r.actions?.some((a) => a.startsWith("hold:canceled"))) summary.held++
          }
        } catch (error) {
          summary.failed++
          deps.log?.error?.({ err: error, tenantId: id }, "could not score a workspace")
        }
      }
    },
  )
  await Promise.all(workers)

  summary.retrained = await maybeRetrain(deps, now)
  return summary
}

async function enrichIdentities(deps: RiskDeps, token: string): Promise<number> {
  const rows = (await deps.db.execute(
    sql`select id, ip from core.identity_unenriched(300)`,
  )) as unknown as {
    id: string
    ip: string
  }[]
  const cache = new Map<string, Awaited<ReturnType<typeof ipinfoLookup>>>()
  let n = 0
  for (const r of rows) {
    try {
      const net = cache.has(r.ip)
        ? cache.get(r.ip)!
        : await ipinfoLookup(r.ip, token, deps.fetch)
      cache.set(r.ip, net)
      // ⚠ AN UNKNOWN NETWORK IS STAMPED ASN 0, so the row leaves the queue
      // instead of being asked about every hour for a week.
      await deps.db.execute(sql`
        select core.identity_enrich(${r.id}::uuid, ${net?.asn ?? 0}, ${net?.asName ?? null}, ${net?.hosting ?? false})
      `)
      n++
    } catch (error) {
      deps.log?.warn?.({ err: error }, "network lookup failed")
    }
  }
  return n
}

async function purgeIdentities(deps: RiskDeps, now: Date): Promise<number> {
  const before = new Date(now.getTime() - 90 * 86_400_000).toISOString()
  const rows = (await deps.db.execute(
    sql`select core.identity_purge(${before}::timestamptz) as n`,
  )) as unknown as { n: number }[]
  return Number(rows[0]?.n ?? 0)
}

/**
 * Registration dates for this workspace's domains that have none yet.
 *
 * ⚠ ONE LOOKUP A SECOND, PROCESS-WIDE, because rdap.org allows ten in ten
 * seconds and the workers run in parallel. A 429 leaves the row unchecked for
 * the next run rather than recording "unknown".
 */
let rdapNext = 0
async function refreshRdap(deps: RiskDeps, tenantId: string): Promise<number> {
  const rows = (await withTenant(deps.db, tenantId, (tx) =>
    tx.execute(sql`
      select id, name from core.domains
       where tenant_id = ${tenantId}::uuid and rdap_checked_at is null
       limit 5
    `),
  )) as unknown as { id: string; name: string }[]
  let n = 0
  for (const d of rows) {
    const parent = registrable(d.name) ?? d.name
    const wait = rdapNext - Date.now()
    rdapNext = Math.max(Date.now(), rdapNext) + 1_100
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try {
      const at = await rdapRegistered(parent, deps.fetch)
      await withTenant(deps.db, tenantId, (tx) =>
        tx.execute(sql`
          update core.domains
             set registered_at = ${at ? at.toISOString() : null}::timestamptz,
                 rdap_checked_at = now()
           where id = ${d.id}::uuid
        `),
      )
      n++
    } catch (error) {
      deps.log?.warn?.(
        { err: error, domain: parent },
        "RDAP lookup failed; retrying next run",
      )
    }
  }
  return n
}

/** Web Risk verdicts for this workspace's unchecked link hosts (last 7 days). */
async function checkLinks(deps: RiskDeps, tenantId: string, key: string) {
  const rows = (await withTenant(deps.db, tenantId, (tx) =>
    tx.execute(sql`
      select distinct host from core.link_hosts
       where tenant_id = ${tenantId}::uuid and checked_at is null
         and day >= current_date - 7
       limit 100
    `),
  )) as unknown as { host: string }[]
  let checked = 0
  let unsafe = 0
  for (const { host } of rows) {
    // ⚠ A HOST'S VERDICT IS SHARED ACROSS WORKSPACES FOR A DAY, so a link
    // every customer sends (a CDN, a social network) costs one lookup, not one
    // per workspace, against the 100k-a-month free tier.
    const cacheKey = `risk:webrisk:${host}`
    let verdict = await deps.redis?.get(cacheKey).catch(() => null)
    if (!verdict) {
      try {
        const threats = await webRiskLookup(host, key, deps.fetch)
        verdict = threats.length ? threats.join(",") : "clean"
        await deps.redis?.setex(cacheKey, 86_400, verdict).catch(() => {})
      } catch (error) {
        deps.log?.warn?.({ err: error, host }, "Web Risk lookup failed")
        continue
      }
    }
    await withTenant(deps.db, tenantId, (tx) =>
      tx.execute(sql`
        update core.link_hosts set verdict = ${verdict}, checked_at = now()
         where tenant_id = ${tenantId}::uuid and host = ${host} and checked_at is null
      `),
    )
    checked++
    if (verdict !== "clean") unsafe++
  }
  return { checked, unsafe }
}

/** Fingerprints and link hosts older than 30 days (docs/decisions/risk.md). */
async function purgeContent(deps: RiskDeps, tenantId: string, now: Date) {
  const before = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
  await withTenant(deps.db, tenantId, async (tx) => {
    await tx.execute(
      sql`delete from core.content_fingerprints where tenant_id = ${tenantId}::uuid and day < ${before}::date`,
    )
    await tx.execute(
      sql`delete from core.link_hosts where tenant_id = ${tenantId}::uuid and day < ${before}::date`,
    )
  })
}

/**
 * Retrains when there are labels the newest model has not seen, at most daily.
 *
 * ⚠ A RETRAIN THAT FAILS ITS EVALUATION IS SAVED INACTIVE, and the previous
 * active model keeps working - a worse model never replaces a better one.
 */
async function maybeRetrain(deps: RiskDeps, now: Date): Promise<string | null> {
  try {
    const count = await deps.labels.count()
    if (count === 0) return null
    const latest = await deps.labels.model(false)
    if (latest && latest.evaluation.labels >= count) return null
    if (latest && now.getTime() - latest.trainedAt.getTime() < 86_400_000) return null
    const r = await deps.labels.retrain()
    return `v${r.version} ${r.active ? "active" : "inactive"}: ${r.evaluation.reason}`
  } catch (error) {
    deps.log?.warn?.({ err: error }, "model retrain failed")
    return null
  }
}
