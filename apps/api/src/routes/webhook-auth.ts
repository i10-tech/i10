import type { MiddlewareHandler } from "hono"
import { requireApiKey } from "../middleware/auth.js"
import { refuseRestrictedKeys } from "./shared.js"

/**
 * The middleware every customer webhook route runs: a key, and not a
 * domain-restricted one (#312).
 *
 * ⚠ REFUSED RATHER THAN CONFINED TO THE KEY'S DOMAINS. An endpoint, its
 * deliveries, its poll stream, its stats and its health history all span every
 * domain the workspace owns, so a key scoped to `a.com` reading any of them sees
 * `b.com`'s mail, and creating an unfiltered endpoint would hand it every event
 * from then on. Confining would need a check on every read path that names an
 * endpoint; refusing needs this one list. A listener confined to its key's
 * domains is planned as its own endpoint kind (docs/decisions/webhook-listener.md).
 *
 * ⚠ ONE CONSTANT FOR EVERY ROUTE, NOT A GUARD ADDED ROUTE BY ROUTE. A guard
 * repeated twenty times is a guard missing from the next route somebody adds;
 * test/webhook-restricted-keys.test.ts walks every documented webhook route.
 */
export const webhookKey: [MiddlewareHandler, MiddlewareHandler] = [
  requireApiKey,
  refuseRestrictedKeys(
    "This key is restricted to a domain, and webhooks carry events for every " +
      "domain in the workspace. Use an unrestricted key.",
  ),
]
