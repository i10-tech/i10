import { webRiskLookup, WebRiskError, type Fetch } from "./intel.js"

/**
 * Web Risk, with a daily budget and a failure cache (#222).
 *
 * ⚠ GOOGLE'S QUOTAS ARE PER MINUTE ONLY. Nothing on their side stops a burst
 * of new hosts - a farm linking a thousand fresh domains, or a bug looping -
 * from turning into a bill past the free 100k a month. So the budget is ours:
 * a Redis counter per UTC day, `WEBRISK_DAILY_LIMIT` (default 3,000, which is
 * 90k a month), counted BEFORE each call, failed calls included. Past it,
 * lookups stop until midnight UTC and hosts stay unchecked for the next run.
 *
 * ⚠ NO REDIS, NO LOOKUPS. The budget cannot be enforced without the counter,
 * and "cannot enforce the budget" must mean "spend nothing", not "spend
 * freely".
 *
 * ⚠ FAILURES ARE CACHED, BRIEFLY. A refused quota (429) or an outage (5xx, no
 * answer) stops every lookup for `DOWN_SECONDS`, so the hourly run does not
 * hammer a quota that already said no, once per host. A 4xx about one host
 * parks that host for an hour and nothing else.
 *
 * ⚠ AN UNKNOWN VERDICT IS `null`, NEVER "clean". Every caller treats null as
 * "not checked": a link that could not be checked earns no trust.
 */
export interface WebRiskRedis {
  get(key: string): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export interface WebRiskOptions {
  /** Absent: only cached verdicts are ever returned. */
  key?: string
  dailyLimit: number
  redis?: WebRiskRedis
  fetch?: Fetch
  now?: () => Date
  log?: { warn?: (o: object, m: string) => void }
}

export interface WebRiskChecker {
  /** The cached verdict: `clean`, threat types joined by `,`, or null. Never calls out. */
  cached(host: string): Promise<string | null>
  /** The cached verdict, or a budgeted lookup; null when neither could say. */
  lookup(host: string): Promise<string | null>
  /** Lookups counted today, for the run summary. */
  spent(): Promise<number>
}

export const VERDICT_SECONDS = 86_400
export const DOWN_SECONDS = 300
export const HOST_FAIL_SECONDS = 3_600
export const DOWN_KEY = "risk:webrisk:down"
export const verdictKey = (host: string) => `risk:webrisk:${host}`
export const budgetKey = (now: Date) =>
  `risk:webrisk:budget:${now.toISOString().slice(0, 10)}`

export function webRiskChecker(opts: WebRiskOptions): WebRiskChecker {
  const redis = opts.redis
  const now = () => opts.now?.() ?? new Date()
  let warnedBudget = ""
  const get = (key: string) =>
    redis?.get(key).catch(() => null) ?? Promise.resolve(null)

  return {
    cached: (host) => get(verdictKey(host)),

    async lookup(host) {
      const cached = await get(verdictKey(host))
      if (cached) return cached
      if (!opts.key || !redis) return null
      if (await get(DOWN_KEY)) return null
      if (await get(`risk:webrisk:fail:${host}`)) return null

      const day = budgetKey(now())
      let used: number
      try {
        used = await redis.incr(day)
        if (used === 1) await redis.expire(day, 2 * 86_400)
      } catch {
        return null
      }
      if (used > opts.dailyLimit) {
        if (warnedBudget !== day) {
          warnedBudget = day
          opts.log?.warn?.(
            { limit: opts.dailyLimit },
            "Web Risk daily budget spent; lookups resume at midnight UTC",
          )
        }
        return null
      }

      try {
        const threats = await webRiskLookup(host, opts.key, opts.fetch)
        const verdict = threats.length ? threats.join(",") : "clean"
        await redis.setex(verdictKey(host), VERDICT_SECONDS, verdict).catch(() => {})
        return verdict
      } catch (error) {
        const status = error instanceof WebRiskError ? error.status : null
        if (status === null || status === 429 || status >= 500) {
          await redis
            .setex(DOWN_KEY, DOWN_SECONDS, String(status ?? "unreachable"))
            .catch(() => {})
        } else {
          await redis
            .setex(`risk:webrisk:fail:${host}`, HOST_FAIL_SECONDS, String(status))
            .catch(() => {})
        }
        opts.log?.warn?.({ err: error, host }, "Web Risk lookup failed")
        return null
      }
    },

    async spent() {
      return Number((await get(budgetKey(now()))) ?? 0)
    },
  }
}

/** A verdict as the trust matcher reads it. */
export const asVerdict = (v: string | null): "clean" | "unsafe" | "unknown" =>
  v === null ? "unknown" : v === "clean" ? "clean" : "unsafe"
