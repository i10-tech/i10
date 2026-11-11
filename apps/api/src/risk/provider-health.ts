/**
 * Whether each outside source is answering, so a dead one is never silent
 * again (#222).
 *
 * ⚠ THIS EXISTS BECAUSE WEB RISK ANSWERED 403 FOR A MONTH. Billing was off on
 * the Google project, every verdict was "unknown", the strongest rule was dead
 * and nothing said so: each provider already fails soft, which is right for
 * scoring and wrong for noticing. Providers report every outbound call here.
 *
 * ⚠ CONSECUTIVE FAILURES THAT SPAN TIME, NOT A SINGLE BAD RUN. A provider is
 * down when it has failed `minFailures` times in a row and the first of them is
 * at least `minSpanMs` old: a burst inside one hourly run (a farm of fresh
 * hosts against an outage that lasts a minute) is one blip, not an incident.
 * One success clears the count. Then it alerts once, and again at most once a
 * `realertSeconds` while the provider stays down, and logs when it comes back.
 *
 * ⚠ ONLY CALLS THAT WERE MADE COUNT. A provider that is not configured, has no
 * key, found its budget spent or is parked behind a failure cache made no call:
 * it reports nothing, so it is never "failing". Redis down means no record
 * (and no alert), never a thrown error on the scoring path.
 */
export interface HealthRedis {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
    nx: "NX",
  ): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
  setex(key: string, seconds: number, value: string): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
}

export type Alert = (
  message: string,
  level: "warning" | "error",
  context: Record<string, unknown>,
) => void

export interface ProviderHealth {
  /** A call was answered, whatever the answer was. */
  success(provider: string): Promise<void>
  /** A call failed in a way that says the provider, not the host, is the problem. */
  failure(provider: string, reason: string): Promise<void>
}

export interface HealthOptions {
  redis?: HealthRedis
  alert?: Alert
  log?: { info?: (o: object, m: string) => void; warn?: (o: object, m: string) => void }
  now?: () => Date
  minFailures?: number
  minSpanMs?: number
  realertSeconds?: number
}

export const MIN_FAILURES = 5
export const MIN_SPAN_MS = 30 * 60_000
export const REALERT_SECONDS = 86_400
/** A provider quiet for a week is forgotten: its old failures say nothing now. */
const STATE_SECONDS = 7 * 86_400
/** A healthy process looks at the shared failure count at most this often. */
const RECOVERY_CHECK_MS = 60_000

export const healthKeys = (provider: string) => ({
  fails: `risk:health:${provider}:fails`,
  since: `risk:health:${provider}:since`,
  alerted: `risk:health:${provider}:alerted`,
})

export function providerHealth(opts: HealthOptions): ProviderHealth {
  const { redis, alert, log } = opts
  const now = () => opts.now?.() ?? new Date()
  const minFailures = opts.minFailures ?? MIN_FAILURES
  const minSpanMs = opts.minSpanMs ?? MIN_SPAN_MS
  const realert = opts.realertSeconds ?? REALERT_SECONDS
  /** When this process last found a provider healthy in Redis; absent after a failure it saw. */
  const checkedHealthy = new Map<string, number>()

  return {
    async failure(provider, reason) {
      checkedHealthy.delete(provider)
      if (!redis) return
      const k = healthKeys(provider)
      try {
        const failures = await redis.incr(k.fails)
        await redis.expire(k.fails, STATE_SECONDS)
        if (failures === 1)
          await redis.setex(k.since, STATE_SECONDS, now().toISOString())
        else await redis.expire(k.since, STATE_SECONDS)
        const since = Date.parse((await redis.get(k.since)) ?? "")
        if (failures < minFailures || !(now().getTime() - since >= minSpanMs)) return
        const first = await redis.set(
          k.alerted,
          now().toISOString(),
          "EX",
          realert,
          "NX",
        )
        if (!first) return
        alert?.(`Link check provider "${provider}" has been failing`, "error", {
          provider,
          failures,
          since: new Date(since).toISOString(),
          reason,
        })
        log?.warn?.({ provider, failures, reason }, "link check provider is down")
      } catch (error) {
        log?.warn?.({ err: error, provider }, "could not record a provider failure")
      }
    },

    async success(provider) {
      if (!redis) return
      const at = now().getTime()
      const last = checkedHealthy.get(provider)
      if (last !== undefined && at - last < RECOVERY_CHECK_MS) return
      checkedHealthy.set(provider, at)
      const k = healthKeys(provider)
      try {
        if (!(await redis.get(k.fails))) return
        const alerted = await redis.get(k.alerted)
        await redis.del(k.fails, k.since, k.alerted)
        if (alerted) log?.info?.({ provider }, "link check provider recovered")
      } catch (error) {
        log?.warn?.({ err: error, provider }, "could not record a provider recovery")
      }
    },
  }
}

/**
 * Runs one outbound call and reports it. A throw is a failure and is rethrown;
 * `null` is the provider declining to answer, which is a failure too.
 */
export async function watched<T>(
  health: ProviderHealth | undefined,
  provider: string,
  ask: () => Promise<T | null>,
): Promise<T | null> {
  let answer: T | null
  try {
    answer = await ask()
  } catch (error) {
    await health?.failure(provider, String(error))
    throw error
  }
  if (answer === null) await health?.failure(provider, "no answer")
  else await health?.success(provider)
  return answer
}
