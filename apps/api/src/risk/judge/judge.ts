import { watched, type ProviderHealth } from "../provider-health.js"
import type { JudgeEmail } from "./contract.js"
import {
  JudgeError,
  type Answers,
  type Judgement,
  type JudgeProvider,
  type Usage,
} from "./providers.js"
import { needsSecondOpinion, type SecondStatus } from "./verdict.js"

/**
 * The content judge with its budgets: what the content job calls once per
 * distinct content (content/judging.ts).
 *
 * ⚠ THREE DAILY BUDGETS, COUNTED IN REDIS BEFORE EACH CALL, FAILED CALLS
 * INCLUDED, like Web Risk's (webrisk.ts): one per workspace, one for every
 * workspace together, and a smaller one for the second model. A spent
 * workspace budget is information (`capped`); a spent global one only defers.
 *
 * ⚠ NO REDIS, NO CALLS. A budget that cannot be counted must mean "spend
 * nothing", not "spend freely".
 *
 * ⚠ AN OUTAGE PARKS THE MODEL FOR `DOWN_SECONDS`, so one hourly run does not
 * send every workspace's content into a service that already said no. Every
 * call that was made is reported to `health`, so a dead judge alerts.
 */
export interface JudgeRedis {
  get(key: string): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export interface JudgeLimits {
  /** Judgements per UTC day, every workspace together. */
  daily: number
  /** Judgements per workspace per UTC day. */
  tenantDaily: number
  /** Second opinions per UTC day, every workspace together. */
  secondDaily: number
}

export interface SecondOpinion {
  status: SecondStatus
  model: string | null
  answers: Answers | null
  truncated: boolean | null
  usage: Usage | null
}

export interface StoredJudgement extends Judgement {
  model: string
  second: SecondOpinion
}

export type JudgeOutcome =
  | { status: "judged"; judgement: StoredJudgement }
  /** This workspace's daily budget is spent. */
  | { status: "capped" }
  /** Nothing was asked: Redis absent or failing, the global budget spent, the model parked, or the call failed. */
  | { status: "deferred"; reason: "no_redis" | "budget" | "down" | "failed" }

export interface ContentJudge {
  model: string
  secondModel: string | null
  judge(tenantId: string, email: JudgeEmail): Promise<JudgeOutcome>
}

export interface ContentJudgeOptions {
  primary: JudgeProvider
  second?: JudgeProvider
  limits: JudgeLimits
  redis?: JudgeRedis
  health?: ProviderHealth
  now?: () => Date
  log?: { warn?: (o: object, m: string) => void }
}

export const DOWN_SECONDS = 300
const day = (now: Date) => now.toISOString().slice(0, 10)
export const judgeKeys = {
  budget: (now: Date) => `risk:judge:budget:${day(now)}`,
  tenant: (tenantId: string, now: Date) => `risk:judge:budget:${tenantId}:${day(now)}`,
  second: (now: Date) => `risk:judge:second:${day(now)}`,
  down: (model: string) => `risk:judge:down:${model}`,
}
export const healthName = (model: string) => `judge:${model}`

export function contentJudge(opts: ContentJudgeOptions): ContentJudge {
  const { redis, primary, second } = opts
  const now = () => opts.now?.() ?? new Date()
  const warned = new Set<string>()

  /** Counts one call against a budget. `error`: Redis could not count it. */
  async function spend(key: string, limit: number): Promise<"ok" | "spent" | "error"> {
    try {
      const used = await redis!.incr(key)
      if (used === 1) await redis!.expire(key, 2 * 86_400)
      if (used <= limit) return "ok"
    } catch {
      return "error"
    }
    if (!warned.has(key)) {
      warned.add(key)
      opts.log?.warn?.({ key, limit }, "content judge budget spent until midnight UTC")
    }
    return "spent"
  }

  const isDown = async (model: string) =>
    (await redis!.get(judgeKeys.down(model)).catch(() => null)) !== null

  /** One call, reported; a failure that says the service is down parks the model. */
  async function ask(provider: JudgeProvider, email: JudgeEmail) {
    try {
      return await watched(opts.health, healthName(provider.model), () =>
        provider.judge(email),
      )
    } catch (error) {
      const status = error instanceof JudgeError ? error.status : null
      if (status === null || status === 429 || status >= 500)
        await redis!
          .setex(
            judgeKeys.down(provider.model),
            DOWN_SECONDS,
            String(status ?? "unreachable"),
          )
          .catch(() => {})
      opts.log?.warn?.(
        { err: error, model: provider.model },
        "content judge call failed",
      )
      return null
    }
  }

  async function secondOpinion(
    email: JudgeEmail,
    first: Judgement,
  ): Promise<SecondOpinion> {
    const none = { answers: null, truncated: null, usage: null }
    if (!needsSecondOpinion(first.answers))
      return { status: "not_needed", model: null, ...none }
    if (!second) return { status: "not_configured", model: null, ...none }
    const model = second.model
    if (await isDown(model)) return { status: "unavailable", model, ...none }
    if ((await spend(judgeKeys.second(now()), opts.limits.secondDaily)) !== "ok")
      return { status: "over_budget", model, ...none }
    const answer = await ask(second, email)
    return answer
      ? { status: "answered", model, ...answer }
      : { status: "unavailable", model, ...none }
  }

  return {
    model: primary.model,
    secondModel: second?.model ?? null,
    async judge(tenantId, email) {
      if (!redis) return { status: "deferred", reason: "no_redis" }
      if (await isDown(primary.model)) return { status: "deferred", reason: "down" }
      const mine = await spend(
        judgeKeys.tenant(tenantId, now()),
        opts.limits.tenantDaily,
      )
      if (mine === "error") return { status: "deferred", reason: "no_redis" }
      if (mine === "spent") return { status: "capped" }
      if ((await spend(judgeKeys.budget(now()), opts.limits.daily)) !== "ok")
        return { status: "deferred", reason: "budget" }
      const first = await ask(primary, email)
      if (!first) return { status: "deferred", reason: "failed" }
      return {
        status: "judged",
        judgement: {
          model: primary.model,
          ...first,
          second: await secondOpinion(email, first),
        },
      }
    },
  }
}
