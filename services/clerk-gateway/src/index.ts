import type { Env } from "./config.js"
import { handle } from "./gateway.js"
import { apiManaged, cached, type ManagedAccounts } from "./managed.js"

/**
 * clerk.i10.tech: every Frontend API request reaches us before it reaches
 * Clerk. See the README, and docs/decisions/sso.md 1.4.
 */

/**
 * ⚠ ONE CACHE PER ISOLATE, NOT PER REQUEST, or it would cache nothing. Keyed
 * on the two settings, so a redeploy with a new secret starts a fresh one.
 * 15 seconds, the same window the API's own gate caches "not managed" for:
 * a burst absorber for sign-in attempts, never a source of truth.
 */
let hook: { key: string; managed: ManagedAccounts } | null = null

function managedFor(env: Env): ManagedAccounts {
  const key = `${env.I10_API_URL ?? ""}\u0000${env.I10_API_SECRET ?? ""}`
  if (hook?.key !== key) {
    hook = {
      key,
      managed: cached(
        apiManaged({
          url: env.I10_API_URL,
          secret: env.I10_API_SECRET,
          fetch: (url, init) => fetch(url, init),
        }),
        { ttlMs: 15_000 },
      ),
    }
  }
  return hook.managed
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      env,
      fetch: (url, init) => fetch(url, init),
      managed: managedFor(env),
      log: (line) => console.log(line),
      now: () => Date.now(),
    })
  },
}
