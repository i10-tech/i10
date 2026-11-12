import { sql } from "drizzle-orm"
import type { Database } from "../../db/client.js"
import type { JudgedContent } from "../types.js"
import type { StoredJudgement } from "./judge.js"
import type { Answers } from "./providers.js"
import { summariseJudged, type SecondStatus } from "./verdict.js"

/**
 * The judgements and the judge's daily counts, through the definers of
 * migration 0157: both tables are deny-all (db/core.ts says why).
 */
export interface JudgementRow {
  exact: string
  model: string
  answers: Answers
  truncated: boolean
  inputTokens: number | null
  outputTokens: number | null
  secondStatus: SecondStatus
  secondModel: string | null
  secondAnswers: Answers | null
  secondTruncated: boolean | null
  judgedAt: Date
}

export interface DayCounts {
  seen: number
  judged: number
  capped: number
}

export interface JudgementStore {
  /** Which of `exacts` already have a judgement under `model`. */
  judged(
    tenantId: string,
    model: string,
    exacts: readonly string[],
  ): Promise<Set<string>>
  /** Stores one; false when another pass stored it first. */
  save(tenantId: string, exact: string, j: StoredJudgement, at: Date): Promise<boolean>
  addDay(tenantId: string, day: string, counts: DayCounts): Promise<void>
  /** The facts: content sent in the 7 days before `now` that `model` judged. */
  facts(tenantId: string, model: string, now: Date): Promise<JudgedContent>
  list(tenantId: string, limit: number): Promise<JudgementRow[]>
  /** Deletes judgements made before `before`; returns how many. */
  purge(before: Date): Promise<number>
}

const WINDOW_DAYS = 7
const json = (v: unknown) => (v === null ? null : JSON.stringify(v))

export function judgementStore(db: Database): JudgementStore {
  const rows = async (q: ReturnType<typeof sql>) =>
    (await db.execute(q)) as unknown as Record<string, unknown>[]

  return {
    async judged(tenantId, model, exacts) {
      if (exacts.length === 0) return new Set()
      const found = await rows(sql`
        select exact from core.risk_content_judged_exacts(
          ${tenantId}::uuid, ${model}, ${`{${exacts.join(",")}}`}::text[]
        )
      `)
      return new Set(found.map((r) => String(r.exact)))
    },

    async save(tenantId, exact, j, at) {
      const s = j.second
      const [r] = await rows(sql`
        select core.risk_content_judgement_save(
          ${tenantId}::uuid, ${exact}, ${j.model}, ${JSON.stringify(j.answers)}::jsonb,
          ${j.truncated}, ${j.usage?.inputTokens ?? null}::int, ${j.usage?.outputTokens ?? null}::int,
          ${s.status}::core.risk_judge_second, ${s.model}, ${json(s.answers)}::jsonb,
          ${s.truncated}::boolean, ${s.usage?.inputTokens ?? null}::int,
          ${s.usage?.outputTokens ?? null}::int, ${at.toISOString()}::timestamptz
        ) as saved
      `)
      return r?.saved === true
    },

    async addDay(tenantId, day, c) {
      if (c.seen === 0 && c.judged === 0 && c.capped === 0) return
      await db.execute(sql`
        select core.risk_content_judge_days_add(
          ${tenantId}::uuid, ${day}::date, ${c.seen}, ${c.judged}, ${c.capped}
        )
      `)
    },

    async facts(tenantId, model, now) {
      const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10)
      const [judged, [days]] = await Promise.all([
        rows(
          sql`select * from core.risk_content_judged(${tenantId}::uuid, ${model}, ${since}::date)`,
        ),
        rows(
          sql`select * from core.risk_content_judge_days_sum(${tenantId}::uuid, ${since}::date)`,
        ),
      ])
      return summariseJudged(
        model,
        judged.map((r) => ({
          exact: String(r.exact),
          answers: r.answers as Answers,
          secondAnswers:
            r.second_status === "answered" ? (r.second_answers as Answers) : null,
          truncated: r.truncated === true,
          messages: Number(r.messages ?? 0),
        })),
        {
          seen: Number(days?.seen ?? 0),
          judged: Number(days?.judged ?? 0),
          capped: Number(days?.capped ?? 0),
        },
      )
    },

    async list(tenantId, limit) {
      const found = await rows(
        sql`select * from core.risk_content_judgements_list(${tenantId}::uuid, ${limit})`,
      )
      return found.map((r) => ({
        exact: String(r.exact),
        model: String(r.model),
        answers: r.answers as Answers,
        truncated: r.truncated === true,
        inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
        outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
        secondStatus: r.second_status as SecondStatus,
        secondModel: (r.second_model as string | null) ?? null,
        secondAnswers: (r.second_answers as Answers | null) ?? null,
        secondTruncated: (r.second_truncated as boolean | null) ?? null,
        judgedAt: new Date(r.judged_at as string),
      }))
    },

    async purge(before) {
      const [r] = await rows(
        sql`select core.risk_content_judgements_purge(${before.toISOString()}::timestamptz) as n`,
      )
      return Number(r?.n ?? 0)
    },
  }
}
