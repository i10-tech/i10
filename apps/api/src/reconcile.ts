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
 * the only signal that entitlements are drifting. `withMonitor` below reads
 * that exit code and reports it as the check-in's verdict, so the pod's status
 * and Sentry's cannot disagree.
 *
 * ⚠ AND THE CHECK-IN IS WHAT NOTICES A RUN THAT NEVER HAPPENED. Everything
 * else here reports a run that went wrong. A suspended CronJob, an edited
 * schedule, or a node too full to place the pod produces no pod, no log line
 * and no exit code — Sentry knows the schedule, so an absence is the one
 * failure it can see that nothing in this file can.
 *
 * ⚠ THREE LEGS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING:
 *
 *   1. SES ↔ i10       did everything we marked sent actually go?  (correctness)
 *   2. i10 ↔ Autumn    did we bill for everything we sent?         (books)
 *   3. Polar ↔ Autumn  is every customer on the plan they paid for? (entitlements)
 *
 * The first repairs INTO `core.messages` and the second reads it, so a message
 * SES sent that we recorded late is an ordinary `sent` row by the time the
 * second leg counts — rather than waiting a whole cycle to be billed. The third
 * is independent of both and runs last because it is the one that talks to
 * Polar.
 *
 * ⚠ THE FIRST TWO WERE WRITTEN, TESTED AND NEVER CALLED. `send/reconcile.ts`
 * and `send/reconcile-ses.ts` were imported by their own tests and by nothing
 * else, so every promise made elsewhere about a reconciler closing a gap — the
 * swallowed `recordSent` in handle-batch.ts most of all — was a promise about a
 * job that did not run. `send/reconcile-run.ts` binds them; this calls it.
 *
 * ⚠ AND A LEG THAT FAILS DOES NOT STOP THE ONES AFTER IT. They repair three
 * different things and share no state beyond the order above, so an Autumn
 * outage must not also stop the SES leg from writing down mail that went.
 */
import pino from "pino"
import { subscriptionOps } from "./billing/db.js"
import { subscriptionGrants } from "./billing/grants.js"
import { polarClient } from "./billing/polar.js"
import { reconcileSubscriptions } from "./billing/reconcile.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"
import { autumnClient } from "./send/autumn.js"
import { needsAttention, reconcileSes, reconcileUsage } from "./send/reconcile-run.js"

const log = pino({ name: "i10-reconcile" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "reconcile",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-billing-reconcile",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/billing-reconcile.yaml.
    // Sentry decides a run is missing by comparing the clock to this string, so
    // a manifest edited without editing here does not break the job — it makes
    // the alert wrong, in whichever direction is least useful.
    schedule: "*/30 * * * *",
    // A run that has not checked in five minutes after its slot is missing, not
    // slow: `activeDeadlineSeconds` on the Job is 300, so by then Kubernetes has
    // already given up on it and there is nothing left to wait for.
    checkinMarginMinutes: 5,
    log,
  },
  async () => {
    if (!env.POLAR_ACCESS_TOKEN || !env.AUTUMN_SECRET_KEY) {
      // ⚠ NOT AN ERROR, AND IT STILL CHECKS IN. A deployment with no billing
      // configured has nothing to reconcile, and failing here would put a red
      // CronJob on a cluster that is behaving exactly as configured. Returning
      // rather than exiting is what lets the check-in report `ok` — an early
      // `process.exit` would look to Sentry exactly like a run that never
      // happened, and alert every half hour on a correct deployment.
      log.warn(
        {
          polar: Boolean(env.POLAR_ACCESS_TOKEN),
          autumn: Boolean(env.AUTUMN_SECRET_KEY),
        },
        "billing is not fully configured — nothing to reconcile",
      )
      return
    }

    const { sql, db } = createDb(env.DATABASE_URL)

    // The same check the API and the worker make, for the same reason:
    // connecting as a role that bypasses row level security is invisible and
    // removes the tenant boundary. This job writes entitlements, so it matters
    // here too.
    try {
      await assertRlsSubject(sql)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error)
      await sql.end({ timeout: 5 })
      // ⚠ AN EXIT CODE RATHER THAN `process.exit`, so the check-in and its
      // flush still run. Exiting here would drop the report describing the one
      // misconfiguration in this service that produces no wrong answer.
      process.exitCode = 1
      return
    }

    const entitlements = autumnClient({
      baseUrl: env.AUTUMN_URL,
      secretKey: env.AUTUMN_SECRET_KEY,
      featureId: env.AUTUMN_FEATURE_ID,
      freePlanId: env.AUTUMN_FREE_PLAN_ID,
      timeoutMs: env.AUTUMN_TIMEOUT_MS,
      log,
    })

    // ⚠ A WINDOW, NOT "EVERYTHING SINCE THE LAST RUN". Both legs are idempotent
    // and both skip anything inside `EVENT_GRACE`, so overlapping windows cost
    // a repeated read and nothing else — while a high-water mark would need
    // storing, would be wrong after a restore, and would silently skip whatever
    // it was wrong about.
    const to = new Date()
    const from = new Date(to.getTime() - env.RECONCILE_LOOKBACK_DAYS * 86_400_000)

    // ── 1. SES ↔ i10 ────────────────────────────────────────────────────────
    try {
      const ses = await reconcileSes(db, from, log)
      log.info(
        {
          repaired: ses.unbilled.length,
          unconfirmed: ses.unconfirmed.length,
          orphaned: ses.orphaned.length,
        },
        "ses reconciliation complete",
      )

      // ⚠ `unbilled` ALONE IS ROUTINE AND MUST NOT PAGE. The at-least-once
      // design guarantees a trickle of them and the repair is the system
      // working; alerting on it would train everyone to ignore this job. The
      // other two are not routine — see `needsAttention`.
      if (needsAttention(ses)) {
        process.exitCode = 1
        captureError(
          new Error(
            `ses reconciliation found ${ses.orphaned.length} orphaned event(s) ` +
              `and ${ses.unconfirmed.length} message(s) billed but unconfirmed`,
          ),
          { orphaned: ses.orphaned, unconfirmed: ses.unconfirmed.slice(0, 20) },
        )
      }
    } catch (error) {
      log.error({ err: error }, "ses reconciliation failed")
      captureError(error)
      process.exitCode = 1
    }

    // ── 2. i10 ↔ Autumn ─────────────────────────────────────────────────────
    try {
      const usage = await reconcileUsage(db, entitlements, from, to, log)
      log.info(
        {
          deficits: usage.deficits.length,
          surpluses: usage.surpluses.length,
          toppedUp: usage.toppedUp,
          alreadyKnown: usage.alreadyKnown,
          failed: usage.failed,
        },
        "usage reconciliation complete",
      )

      // ⚠ A SURPLUS IS THE ALARMING DIRECTION. A deficit is the hot path
      // dropping usage exactly as it is designed to, and this leg closing it.
      // A surplus means Autumn counted something we did not send, which is a
      // customer being over-charged and has no automatic fix that would not
      // also destroy the evidence.
      if (usage.surpluses.length > 0 || usage.failed > 0) {
        process.exitCode = 1
        captureError(
          new Error(
            `usage reconciliation found ${usage.surpluses.length} surplus bucket(s) ` +
              `and could not finish ${usage.failed}`,
          ),
          { surpluses: usage.surpluses.slice(0, 20) },
        )
      }
    } catch (error) {
      log.error({ err: error }, "usage reconciliation failed")
      captureError(error)
      process.exitCode = 1
    }

    // ── 3. Polar ↔ Autumn ───────────────────────────────────────────────────
    const subscriptions = subscriptionOps(db)

    try {
      const report = await reconcileSubscriptions({
        polar: polarClient({
          accessToken: env.POLAR_ACCESS_TOKEN,
          server: env.POLAR_SERVER,
          // ⚠ LONGER THAN THE CHECKOUT BUDGET. Nobody is waiting on this, and
          // the list call pages through every subscription in the organisation.
          timeoutMs: 30_000,
        }),
        subscriptions,
        // The same client the usage leg reads through. Two would be two sets of
        // timeouts and two connection pools against one service, for nothing.
        grants: subscriptionGrants({ subscriptions, entitlements, log }),
        options: {
          planForProduct: (productId: string) =>
            Object.entries(env.POLAR_PRODUCTS).find(([, id]) => id === productId)?.[0],
          freePlanId: env.AUTUMN_FREE_PLAN_ID,
        },
        log,
      })

      log.info(report, "subscription reconciliation complete")

      if (report.failed.length > 0 || report.orphaned.length > 0) {
        process.exitCode = 1
        // ⚠ REPORTED AS AN EXCEPTION AS WELL AS A FAILED CHECK-IN, because the
        // check-in carries a verdict and nothing else. This is the line that
        // says WHICH tenants and why — the thing that turned two hours of
        // reading pod logs into a thirty-second diagnosis.
        captureError(
          new Error(
            `reconciliation left ${report.failed.length} tenant(s) unrepaired ` +
              `and ${report.orphaned.length} row(s) orphaned`,
          ),
          { failed: report.failed, orphaned: report.orphaned },
        )
      }
    } catch (error) {
      log.error({ err: error }, "subscription reconciliation failed")
      captureError(error)
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
