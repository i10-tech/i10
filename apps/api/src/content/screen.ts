import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import type { ContentItem } from "../risk/content.js"
import { NEAR_DUPLICATE_BANDS, sharedBands } from "../risk/fingerprint.js"
import type { ContentJudge, JudgeOutcome } from "../risk/judge/judge.js"
import type { JudgementStore } from "../risk/judge/store.js"
import type { TrustSource } from "../risk/trusted.js"
import { bandRank, type Band } from "../risk/types.js"
import {
  countDay,
  distinctContents,
  judgeCandidate,
  stampJudged,
  type DistinctContent,
  type JudgeCandidate,
  type JudgeSource,
  type SeenRedis,
} from "./judging.js"

/**
 * Judging before the first send (docs/decisions/risk.md, "Judging before the
 * first send"): the worker's step between the claim and the held check.
 *
 * ⚠ ONLY UNTRUSTED WORKSPACES, ONLY NEW CONTENT. The hourly pass judges
 * everything eventually; this exists so a new account's first phishing run is
 * judged before it leaves rather than an hour after. A workspace that is old,
 * low and unremarkable, or that staff cleared, is never held up by it.
 *
 * ⚠ NEAR-DUPLICATES ARE ONE CONTENT. The exact fingerprint does not fold
 * names, so "Hi Anna" and "Hi Ben" differ; judged one by one, a single
 * personalised batch would spend the whole day's free Workers AI allowance.
 * Contents sharing `NEAR_DUPLICATE_BANDS` bands are one group, judged once by
 * its first member, and a content near a judgement this workspace already has
 * is not judged again.
 *
 * ⚠ FAILS OPEN. A spent budget, a parked model, the deadline or any error
 * sends the batch anyway, unstamped, so the hourly pass still judges it.
 *
 * ⚠ IT CANNOT STOP MAIL WHILE THE JUDGE RULES ARE IN SHADOW (risk/rules.ts):
 * the re-score records what the judge found and moves nothing. It is in place
 * so that the day they leave shadow, the first send is already covered.
 */
export type ScreenOutcome =
  | {
      kind: "skipped"
      why: "judge_off" | "switch_off" | "trusted_workspace" | "exempt" | "nothing_new"
    }
  /** `left`: groups past the cap, sent unjudged for the hourly pass. */
  | { kind: "judged"; groups: number; left: number; rescored: boolean }
  /** `judged`: groups judged before it stopped; `rescored` whether that re-scored. */
  | {
      kind: "unscreened"
      why: "budget" | "deadline" | "provider_down" | "error"
      judged: number
      rescored: boolean
    }

export interface ScreenSettings {
  /** `RISK_SCREEN_BEFORE_SEND`. */
  enabled: boolean
  /** `RISK_SCREEN_UNTRUSTED_DAYS`: a workspace younger than this is untrusted. */
  untrustedDays: number
  /** `RISK_SCREEN_MAX_GROUPS`: groups judged per batch. */
  maxGroups: number
  /** `RISK_SCREEN_DEADLINE_MS`: the whole screen, judging and re-score. */
  deadlineMs: number
}

/** What decides whether a workspace is screened. */
export interface Standing {
  createdAt: Date
  /** The current band; null before the first score. */
  band: Band | null
  /** Until when staff's release or pin holds the score's hand. */
  pausedUntil: Date | null
}

/** A claimed message: the mail as it is sent, and its body's key. */
export interface ScreenMessage extends JudgeSource {
  id: string
  createdAt: Date
}

export interface ScreenDeps {
  /** Absent: no judge is configured. */
  judge?: ContentJudge
  judgements: JudgementStore
  settings: ScreenSettings
  /** The risk engine's master switch, `RISK_ENABLED`. */
  riskEnabled: boolean
  /** Our own system tenant, which the engine never scores. */
  exempt?: ReadonlySet<string>
  /** Cached-verdict trust (the five-minute pass's): it never spends a link budget. */
  trust?: TrustSource
  seenRedis?: SeenRedis
  standing(tenantId: string): Promise<Standing | null>
  /** Stamps bodies `judged_at`. */
  stamp(tenantId: string, bodies: readonly BodyRef[]): Promise<void>
  /** Records the batch's fingerprints, so the re-score's facts can see them. */
  record(tenantId: string, items: readonly ContentItem[]): Promise<void>
  /** Re-scores the workspace now; true when it scored. */
  rescore(tenantId: string): Promise<boolean>
  now?: () => Date
  log?: { warn?: (o: object, m: string) => void }
}

export interface BodyRef {
  messageId: string
  /** Postgres's text for the partition key. */
  createdAt: string
}

/** How far back a stored judgement still covers a near-duplicate. */
export const NEAR_WINDOW_DAYS = 7
const DAY = 86_400_000

/**
 * ⚠ THE ONE DEFINITION OF "UNTRUSTED": young, or elevated or worse, and not
 * cleared by staff. A staff release or pin pauses the score's hand
 * (`auto_actions_paused_until`, risk/decide.ts), so a re-score could not act
 * on what this finds anyway, and a workspace a person vouched for is not held
 * up by it.
 */
export function untrusted(s: Standing, now: Date, untrustedDays: number): boolean {
  if (s.pausedUntil && now < s.pausedUntil) return false
  const young = now.getTime() - s.createdAt.getTime() < untrustedDays * DAY
  const worrying = s.band !== null && bandRank(s.band) >= bandRank("elevated")
  return young || worrying
}

interface Group {
  representative: DistinctContent
  members: DistinctContent[]
}

/**
 * Contents into groups of near-duplicates, in order: each joins the first group
 * whose representative it shares `NEAR_DUPLICATE_BANDS` bands with.
 */
export function groupNear(contents: readonly DistinctContent[]): Group[] {
  const groups: Group[] = []
  for (const c of contents) {
    const home = groups.find(
      (g) => sharedBands(g.representative.bands, c.bands) >= NEAR_DUPLICATE_BANDS,
    )
    if (home) home.members.push(c)
    else groups.push({ representative: c, members: [c] })
  }
  return groups
}

const TIMED_OUT = Symbol("timed out")

const failureOf = (
  o: Exclude<JudgeOutcome, { status: "judged" }>,
): "budget" | "provider_down" =>
  o.status === "capped" || o.reason === "budget" || o.reason === "no_redis"
    ? "budget"
    : "provider_down"

export async function screenBatch(
  tenantId: string,
  messages: readonly ScreenMessage[],
  deps: ScreenDeps,
): Promise<ScreenOutcome> {
  const { judge, settings } = deps
  if (!judge) return { kind: "skipped", why: "judge_off" }
  if (!settings.enabled || !deps.riskEnabled)
    return { kind: "skipped", why: "switch_off" }
  if (deps.exempt?.has(tenantId)) return { kind: "skipped", why: "exempt" }
  const now = deps.now?.() ?? new Date()
  // The wall clock, not `now`: the deadline is time spent here, not business time.
  const ends = Date.now() + settings.deadlineMs

  /** `p`, or TIMED_OUT once the screen's deadline passes. */
  const inTime = async <T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ends - Date.now()))
    })
    try {
      return await Promise.race([p, late])
    } finally {
      clearTimeout(timer)
    }
  }

  const standing = await deps.standing(tenantId)
  if (!standing || !untrusted(standing, now, settings.untrustedDays))
    return { kind: "skipped", why: "trusted_workspace" }

  const trust = deps.trust
    ? await deps.trust.forTenant(tenantId).catch(() => null)
    : null
  const bodies: (JudgeCandidate & BodyRef)[] = []
  for (const m of messages)
    bodies.push({
      ...(await judgeCandidate(m, trust)),
      messageId: m.id,
      createdAt: m.createdAt.toISOString(),
    })

  // ── What is already resolved: too short, trusted, judged exactly or nearly ──
  const distinct = distinctContents(bodies)
  const untrustedContents = [...distinct.values()].filter((d) => d.trustedBy === null)
  const exacts = untrustedContents.map((d) => d.exact)
  const have = await deps.judgements.judged(tenantId, judge.key, exacts)
  const fresh = untrustedContents.filter((d) => !have.has(d.exact))
  const near = await deps.judgements.near(
    tenantId,
    judge.key,
    [...new Set(fresh.flatMap((d) => d.bands))],
    new Date(now.getTime() - NEAR_WINDOW_DAYS * DAY),
  )
  const groups = groupNear(fresh).filter(
    (g) =>
      !g.members.some((m) =>
        near.some((j) => sharedBands(j.bands, m.bands) >= NEAR_DUPLICATE_BANDS),
      ),
  )

  // ⚠ ONLY CONTENT RESOLVED BY ITS OWN EXACT FINGERPRINT IS STAMPED. A near
  // match may skip the wait, but a stamped body is never judged again, and a
  // close copy of judged mail with its link swapped must still reach the
  // hourly pass.
  const resolved = new Set<string>([
    ...[...distinct.values()].filter((d) => d.trustedBy !== null).map((d) => d.exact),
    ...have,
  ])
  const stampResolved = () =>
    deps.stamp(
      tenantId,
      bodies.filter((b) => !b.print || resolved.has(b.print.exact)),
    )
  if (groups.length === 0) {
    await stampResolved()
    return { kind: "skipped", why: "nothing_new" }
  }

  // ── Judge, one representative per group, sequentially, within the deadline ──
  let judged = 0
  let stopped: Extract<ScreenOutcome, { kind: "unscreened" }>["why"] | null = null
  const capped: string[] = []
  for (const g of groups.slice(0, settings.maxGroups)) {
    const rep = g.representative
    const asked = judge.judge(tenantId, rep.email)
    const outcome = await inTime(asked)
    if (outcome === TIMED_OUT) {
      stopped = "deadline"
      // The call is paid for: a late answer is kept, and the hourly pass reads it.
      void asked
        .then((o) =>
          o.status === "judged"
            ? deps.judgements.save(tenantId, rep.exact, o.judgement, now, rep.bands)
            : false,
        )
        .catch(() => {})
      break
    }
    if (outcome.status !== "judged") {
      stopped = failureOf(outcome)
      if (outcome.status === "capped") capped.push(rep.exact)
      break
    }
    await deps.judgements.save(tenantId, rep.exact, outcome.judgement, now, rep.bands)
    judged++
    resolved.add(rep.exact)
  }

  await countDay(deps, tenantId, now, { seen: exacts, judged, capped })
  await stampResolved()

  // ── Re-score on what was found, so the held check that follows sees it ──
  // ⚠ FINGERPRINTS FIRST: the facts read judged content through them, and the
  // five-minute pass may not have recorded this batch yet.
  let rescored = false
  if (judged > 0) {
    try {
      const r = await inTime(
        deps
          .record(tenantId, messages.map(contentItem))
          .then(() => deps.rescore(tenantId)),
      )
      rescored = r === true
      if (r === TIMED_OUT) stopped ??= "deadline"
    } catch (error) {
      deps.log?.warn?.({ err: error, tenantId }, "pre-send re-score failed")
      stopped ??= "error"
    }
  }

  // The one log line per batch is handleBatch's, from this outcome.
  if (stopped) return { kind: "unscreened", why: stopped, judged, rescored }
  return {
    kind: "judged",
    groups: judged,
    left: groups.length - judged,
    rescored,
  }
}

const contentItem = (m: ScreenMessage): ContentItem => ({
  subject: m.subject,
  html: m.html,
  text: m.text,
  messageId: m.id,
  createdAt: m.createdAt.toISOString(),
})

/** The screen's database half: a workspace's standing and the `judged_at` stamp. */
export function screenStore(db: Database): Pick<ScreenDeps, "standing" | "stamp"> {
  return {
    async standing(tenantId) {
      const [row] = (await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`
          select t.created_at, a.band, a.auto_actions_paused_until
            from core.tenants t
            left join core.risk_assessments a on a.tenant_id = t.id
           where t.id = ${tenantId}::uuid
        `),
      )) as unknown as {
        created_at: string | Date
        band: Band | null
        auto_actions_paused_until: string | Date | null
      }[]
      if (!row) return null
      return {
        createdAt: new Date(row.created_at),
        band: row.band,
        pausedUntil: row.auto_actions_paused_until
          ? new Date(row.auto_actions_paused_until)
          : null,
      }
    },
    stamp: (tenantId, bodies) => stampJudged(db, tenantId, bodies),
  }
}
