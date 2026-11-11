import type { Fetch } from "./intel.js"
import { linkChecker, type LinkChecker, type LinkProvider } from "./link-check.js"
import { dnsProviders, type DohTransport } from "./link-dns.js"
import type { LinkProviderChoice } from "./link-verdict.js"
import type { ProviderHealth } from "./provider-health.js"
import {
  webRiskChecker,
  webRiskProvider,
  type WebRiskChecker,
  type WebRiskRedis,
} from "./webrisk.js"

/**
 * Which link checkers run (#222): `RISK_LINK_PROVIDERS` names them, this builds
 * them.
 *
 * ⚠ LISTED IS NOT ENOUGH FOR WEB RISK. It also needs `WEBRISK_API_KEY`; listed
 * without one it is left out, loudly, rather than failing every lookup. And a
 * provider that is not built is never reported to the health record, so it is
 * never "failing".
 */
export interface LinkConfig {
  providers: readonly LinkProviderChoice[]
  webRiskKey?: string
  webRiskDailyLimit: number
  dnsDailyLimit: number
  redis?: WebRiskRedis
  health?: ProviderHealth
  fetch?: Fetch
  transport?: DohTransport
  now?: () => Date
  log?: { warn?: (o: object, m: string) => void }
}

export interface Links {
  checker: LinkChecker
  /** Web Risk's own checker, for its budget in the run summary; absent when it does not run. */
  webRisk: WebRiskChecker | undefined
  /** The provider names that run, in the order asked. */
  names: string[]
}

export function buildLinks(config: LinkConfig): Links {
  const providers: LinkProvider[] = []
  let webRisk: WebRiskChecker | undefined
  for (const choice of config.providers) {
    if (choice === "dns") {
      providers.push(
        ...dnsProviders({
          dailyLimit: config.dnsDailyLimit,
          ...(config.redis ? { redis: config.redis } : {}),
          ...(config.transport ? { transport: config.transport } : {}),
          ...(config.health ? { health: config.health } : {}),
          ...(config.now ? { now: config.now } : {}),
          ...(config.log ? { log: config.log } : {}),
        }),
      )
    } else if (!config.webRiskKey) {
      config.log?.warn?.(
        {},
        "Web Risk is listed in RISK_LINK_PROVIDERS but WEBRISK_API_KEY is not set; not used",
      )
    } else {
      webRisk = webRiskChecker({
        key: config.webRiskKey,
        dailyLimit: config.webRiskDailyLimit,
        ...(config.redis ? { redis: config.redis } : {}),
        ...(config.fetch ? { fetch: config.fetch } : {}),
        ...(config.health ? { health: config.health } : {}),
        ...(config.now ? { now: config.now } : {}),
        ...(config.log ? { log: config.log } : {}),
      })
      providers.push(webRiskProvider(webRisk))
    }
  }
  return {
    checker: linkChecker(providers),
    webRisk,
    names: providers.map((p) => p.name),
  }
}
