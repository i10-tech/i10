import type { Fetch } from "../intel.js"
import type { ProviderHealth } from "../provider-health.js"
import { contentJudge, type ContentJudge, type JudgeRedis } from "./judge.js"
import {
  systemOneJudge,
  workersAiJudge,
  type JudgeProvider,
  type JudgeProviderKind,
} from "./providers.js"

/**
 * The content judge from configuration (env.ts validates the settings).
 * Nothing configured: no judge, no calls, no facts and no points.
 */
export const JUDGE_PROVIDERS = ["workers-ai", "systemone"] as const

/** What each provider runs when its model settings are left unset. */
export const JUDGE_DEFAULTS: Readonly<
  Record<JudgeProviderKind, { model: string; second: string | null }>
> = {
  "workers-ai": { model: "@cf/cloudflare/clef-flash", second: "@cf/cloudflare/clef" },
  systemone: { model: "jev-1", second: null },
}

/** `RISK_JUDGE_SECOND_MODEL=none` turns the second opinion off. */
export const NO_SECOND_MODEL = "none"

/** A Workers AI model id: `@cf/<vendor>/<model>`. */
export const WORKERS_AI_MODEL = /^@cf\/[a-z0-9-]+\/[a-z0-9.-]+$/

export interface JudgeSettings {
  RISK_JUDGE_PROVIDER?: JudgeProviderKind | undefined
  RISK_JUDGE_MODEL?: string | undefined
  RISK_JUDGE_SECOND_MODEL?: string | undefined
  RISK_JUDGE_CF_ACCOUNT_ID?: string | undefined
  RISK_JUDGE_CF_API_TOKEN?: string | undefined
  RISK_JUDGE_URL?: string | undefined
  RISK_JUDGE_API_KEY?: string | undefined
  RISK_JUDGE_DAILY_LIMIT: number
  RISK_JUDGE_TENANT_DAILY_LIMIT: number
  RISK_JUDGE_SECOND_DAILY_LIMIT: number
}

export function judgeModels(
  env: JudgeSettings,
): { model: string; second: string | null } | null {
  const kind = env.RISK_JUDGE_PROVIDER
  if (!kind) return null
  const second = env.RISK_JUDGE_SECOND_MODEL ?? JUDGE_DEFAULTS[kind].second
  return {
    model: env.RISK_JUDGE_MODEL ?? JUDGE_DEFAULTS[kind].model,
    second: second === NO_SECOND_MODEL ? null : second,
  }
}

export function buildJudge(
  env: JudgeSettings,
  deps: {
    redis?: JudgeRedis
    health?: ProviderHealth
    fetch?: Fetch
    log?: { warn?: (o: object, m: string) => void }
  } = {},
): ContentJudge | undefined {
  const models = judgeModels(env)
  if (!models) return undefined
  const provider = (model: string): JudgeProvider =>
    env.RISK_JUDGE_PROVIDER === "workers-ai"
      ? workersAiJudge({
          accountId: env.RISK_JUDGE_CF_ACCOUNT_ID!,
          token: env.RISK_JUDGE_CF_API_TOKEN!,
          model,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        })
      : systemOneJudge({
          url: env.RISK_JUDGE_URL!,
          ...(env.RISK_JUDGE_API_KEY ? { apiKey: env.RISK_JUDGE_API_KEY } : {}),
          model,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        })
  return contentJudge({
    primary: provider(models.model),
    ...(models.second ? { second: provider(models.second) } : {}),
    limits: {
      daily: env.RISK_JUDGE_DAILY_LIMIT,
      tenantDaily: env.RISK_JUDGE_TENANT_DAILY_LIMIT,
      secondDaily: env.RISK_JUDGE_SECOND_DAILY_LIMIT,
    },
    ...(deps.redis ? { redis: deps.redis } : {}),
    ...(deps.health ? { health: deps.health } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
}

/** What is wrong with the judge settings, for env.ts; empty when they are coherent. */
export function judgeSettingsProblems(
  env: JudgeSettings,
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = []
  const kind = env.RISK_JUDGE_PROVIDER
  const set = (k: keyof JudgeSettings) => env[k] !== undefined
  const cloudflare = ["RISK_JUDGE_CF_ACCOUNT_ID", "RISK_JUDGE_CF_API_TOKEN"] as const
  const systemone = ["RISK_JUDGE_URL", "RISK_JUDGE_API_KEY"] as const
  if (!kind) {
    for (const k of [
      ...cloudflare,
      ...systemone,
      "RISK_JUDGE_MODEL",
      "RISK_JUDGE_SECOND_MODEL",
    ] as const)
      if (set(k))
        out.push({
          path: k,
          message:
            "is set but RISK_JUDGE_PROVIDER is not, so it would look configured and judge nothing.",
        })
    return out
  }
  const mine = kind === "workers-ai" ? cloudflare : systemone
  const theirs = kind === "workers-ai" ? systemone : cloudflare
  for (const k of theirs)
    if (set(k))
      out.push({ path: k, message: `belongs to the other provider, not ${kind}.` })
  const required = kind === "workers-ai" ? mine : (["RISK_JUDGE_URL"] as const)
  for (const k of required)
    if (!set(k))
      out.push({ path: k, message: `is required when RISK_JUDGE_PROVIDER is ${kind}.` })
  if (kind === "workers-ai") {
    const models = judgeModels(env)!
    for (const [path, m] of [
      ["RISK_JUDGE_MODEL", models.model],
      ["RISK_JUDGE_SECOND_MODEL", models.second],
    ] as const)
      if (m !== null && !WORKERS_AI_MODEL.test(m))
        out.push({
          path,
          message: `"${m}" is not a Workers AI model id (@cf/<vendor>/<model>).`,
        })
  }
  return out
}
