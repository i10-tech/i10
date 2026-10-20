import type { Env } from "./config.js"
import { handle } from "./gateway.js"
import { NOT_MANAGED } from "./managed.js"

/**
 * clerk.i10.tech: every Frontend API request reaches us before it reaches
 * Clerk. See the README, and docs/decisions/sso.md 1.4.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      env,
      fetch: (url, init) => fetch(url, init),
      // TODO(#337): the API-backed lookup, wrapped in `cached()`.
      managed: NOT_MANAGED,
      log: (line) => console.log(line),
      now: () => Date.now(),
    })
  },
}
