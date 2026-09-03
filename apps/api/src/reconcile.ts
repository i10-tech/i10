/**
 * Reconciles i10's entitlements against Polar, then exits.
 *
 * ⚠ A CronJob RATHER THAN AN INTERVAL INSIDE THE WORKER, and the reason is that
 * it must run EXACTLY once per pass. The worker Deployment scales on queue
 * depth, so an interval inside it would run once per replica — three replicas
 * would issue three sets of repairs against the same rows, and every one of
 * them would call Autumn. Kubernetes already owns "run this once, on a
 * schedule", with `concurrencyPolicy: Forbid` to say what happens when a run
 * overruns. Same image, a different command, exactly as migrate.js is.
 *
 * ⚠ AND IT EXITS NON-ZERO WHEN A TENANT COULD NOT BE REPAIRED. A CronJob whose
 * pod always succeeds is a CronJob nobody ever looks at; the failure count is
 * the only signal that entitlements are drifting, and it is the thing an alert
 * can be hung off once the observability piece lands.
 */
import pino from "pino"
import { subscriptionOps } from "./billing/db.js"
import { subscriptionGrants } from "./billing/grants.js"
import { polarClient } from "./billing/polar.js"
import { reconcileSubscriptions } from "./billing/reconcile.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { autumnClient } from "./send/autumn.js"

const log = pino({ name: "i10-reconcile" })
const env = loadEnv()

if (!env.POLAR_ACCESS_TOKEN || !env.AUTUMN_SECRET_KEY) {
  // ⚠ NOT AN ERROR. A deployment with no billing configured has nothing to
  // reconcile, and failing here would put a red CronJob on a cluster that is
  // behaving exactly as configured.
  log.warn(
    { polar: Boolean(env.POLAR_ACCESS_TOKEN), autumn: Boolean(env.AUTUMN_SECRET_KEY) },
    "billing is not fully configured — nothing to reconcile",
  )
  process.exit(0)
}

const { sql, db } = createDb(env.DATABASE_URL)

// The same check the API and the worker make, for the same reason: connecting
// as a role that bypasses row level security is invisible and removes the
// tenant boundary. This job writes entitlements, so it matters here too.
try {
  await assertRlsSubject(sql)
} catch (error) {
  log.fatal({ err: error }, "refusing to start")
  await sql.end({ timeout: 5 })
  process.exit(1)
}

const subscriptions = subscriptionOps(db)

try {
  const report = await reconcileSubscriptions({
    polar: polarClient({
      accessToken: env.POLAR_ACCESS_TOKEN,
      server: env.POLAR_SERVER,
      // ⚠ LONGER THAN THE CHECKOUT BUDGET. Nobody is waiting on this, and the
      // list call pages through every subscription in the organisation.
      timeoutMs: 30_000,
    }),
    subscriptions,
    grants: subscriptionGrants({
      subscriptions,
      entitlements: autumnClient({
        baseUrl: env.AUTUMN_URL,
        secretKey: env.AUTUMN_SECRET_KEY,
        featureId: env.AUTUMN_FEATURE_ID,
        freePlanId: env.AUTUMN_FREE_PLAN_ID,
        timeoutMs: env.AUTUMN_TIMEOUT_MS,
        log,
      }),
      log,
    }),
    options: {
      planForProduct: (productId: string) =>
        Object.entries(env.POLAR_PRODUCTS).find(([, id]) => id === productId)?.[0],
      freePlanId: env.AUTUMN_FREE_PLAN_ID,
    },
    log,
  })

  log.info(report, "subscription reconciliation complete")

  if (report.failed.length > 0 || report.orphaned.length > 0) process.exitCode = 1
} catch (error) {
  log.error({ err: error }, "subscription reconciliation failed")
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
