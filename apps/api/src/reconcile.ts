/**
 * Reconciles i10's entitlements against Polar, then exits.
 *
 * ⚠ A CronJob RATHER THAN AN INTERVAL INSIDE THE WORKER, and the reason is that
 * it must run EXACTLY once per pass. The worker Deployment scales on queue
 * depth, so an interval inside it would run once per replica — three replicas
 * would issue three sets of repairs against the same rows, and every one of
 * them would write the same ledger. Kubernetes already owns "run this once, on a
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
 * ⚠ FOUR LEGS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING:
 *
 *   1. SES ↔ i10       did everything we marked sent actually go?  (correctness)
 *   2. i10 ↔ meter     did we bill for everything we sent?         (books)
 *   3. tenants ↔ Polar does every tenant exist as a customer?      (existence)
 *   4. Polar ↔ i10     is every customer on the plan they paid for? (entitlements)
 *
 * The first repairs INTO `core.messages` and the second reads it, so a message
 * SES sent that we recorded late is an ordinary `sent` row by the time the
 * second leg counts — rather than waiting a whole cycle to be billed.
 *
 * The third is deliberately AFTER the second and not folded into it: the usage
 * reconciler cannot see a tenant the meter has never heard of, because both
 * sides read zero for it and agree. That is the whole reason it is a separate
 * question, and it compares the entire tenant list rather than only tenants
 * that sent something — a tenant that has not sent yet is exactly the one worth
 * finding before it does.
 *
 * ⚠ THE FIRST TWO WERE WRITTEN, TESTED AND NEVER CALLED. `send/reconcile.ts`
 * and `send/reconcile-ses.ts` were imported by their own tests and by nothing
 * else, so every promise made elsewhere about a reconciler closing a gap — the
 * swallowed `recordSent` in handle-batch.ts most of all — was a promise about a
 * job that did not run. `send/reconcile-run.ts` binds them; this calls it.
 *
 * ⚠ AND A LEG THAT FAILS DOES NOT STOP THE ONES AFTER IT. They repair three
 * different things and share no state beyond the order above, so a Polar outage
 * must not also stop the SES leg from writing down mail that went.
 */
import pino from "pino"
import { subscriptionOps } from "./billing/db.js"
import { subscriptionGrants } from "./billing/grants.js"
import { polarClient } from "./billing/polar.js"
import { reconcileSubscriptions } from "./billing/reconcile.js"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"
import { postgresEntitlements, postgresLedger } from "./metering/service.js"
import { flushUsage } from "./metering/ingest.js"
import { sampleStorage } from "./mail/storage.js"
import { stalwartStorage } from "./mail/stalwart.js"
import {
  needsAttention,
  reconcileSes,
  reconcileTenantCustomers,
  reconcileUsage,
  reportRouteSplit,
} from "./send/reconcile-run.js"

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
    // ⚠ THE METER IS NO LONGER PART OF THIS CONDITION, BECAUSE IT IS NO LONGER
    // A SERVICE THAT CAN BE ABSENT. Usage lives in our own database, so the
    // usage and tenant legs run on any deployment that has one; only the Polar
    // leg needs a credential.
    if (!env.POLAR_ACCESS_TOKEN) {
      // ⚠ NOT AN ERROR, AND IT STILL CHECKS IN. A deployment with no billing
      // configured has nothing to reconcile, and failing here would put a red
      // CronJob on a cluster that is behaving exactly as configured. Returning
      // rather than exiting is what lets the check-in report `ok` — an early
      // `process.exit` would look to Sentry exactly like a run that never
      // happened, and alert every half hour on a correct deployment.
      log.warn(
        { polar: Boolean(env.POLAR_ACCESS_TOKEN) },
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

    // ⚠ THE LEDGER, NOT A BILLING CLIENT. It exposes the aggregate, the
    // idempotent top-up and the customer list, and nothing that could grant a
    // plan — see `UsageLedger` and `CustomerDirectory` in send/reconcile.ts.
    // The timeout that used to live here is gone with the HTTP call it bounded.
    const entitlements = postgresLedger({ db, featureId: env.METERING_FEATURE_ID })

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

    // ── 2. i10 ↔ meter ─────────────────────────────────────────────────────
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
      // A surplus means the meter counted something we did not send, which is a
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

      // ⚠ THE SAME WINDOW, A DIFFERENT QUESTION. The leg above asks whether we
      // billed for everything we sent — one price, both routes, no route
      // predicate anywhere in it. This asks which MTA carried it, which is what
      // decides how much SES we are buying and how much of our own IP
      // reputation we are spending. `sent_route` has been written on every row
      // since 0033 and read by nothing until now.
      //
      // ⚠ INSIDE THE USAGE LEG'S `try`, SO ITS OWN FAILURE CANNOT REACH THE
      // OTHER LEGS — and it deliberately does NOT set `process.exitCode`. A
      // readout that could fail a job which repairs entitlements would be the
      // tail wagging the dog.
      try {
        const split = await reportRouteSplit(db, from, to)
        log.info({ ...split, from, to }, "route split")

        // ⚠ `unknown` IS A FAULT, NOT A CATEGORY. Every `sent` row has carried a
        // route since 0033, so one without means a write path skipped it. Loud
        // here rather than folded into `ses`, where it would add up to a
        // plausible number and never be found.
        if (split.unknown > 0) {
          log.error(
            { unknown: split.unknown, total: split.total },
            "sent messages with no recorded route",
          )
          captureError(new Error(`${split.unknown} sent message(s) have no sent_route`))
        }
      } catch (error) {
        log.error({ err: error }, "route split readout failed")
        captureError(error)
      }
    } catch (error) {
      log.error({ err: error }, "usage reconciliation failed")
      captureError(error)
      process.exitCode = 1
    }

    // ── storage sample ──────────────────────────────────────────────────────
    //
    // ⚠ IT RUNS HERE RATHER THAN ON ITS OWN SCHEDULE BECAUSE IT IS THE SAME KIND
    // OF WORK: a number that lives somewhere else, pulled on a cadence, with
    // nobody waiting on it. Thirty minutes is far finer than a storage limit
    // needs — the figure moves in megabytes over hours.
    if (env.STALWART_URL && env.STALWART_API_TOKEN) {
      try {
        const report = await sampleStorage({
          db,
          mail: stalwartStorage({
            baseUrl: env.STALWART_URL,
            token: env.STALWART_API_TOKEN,
          }),
          log,
        })

        // ⚠ FAILURES ARE LOGGED AND NOT FATAL. A mailbox we could not read
        // leaves that tenant's previous total standing, which is stale and
        // honest; the run itself has nothing to repair.
        log.info(report, "storage sample complete")
      } catch (error) {
        log.error({ err: error }, "storage sample failed")
        captureError(error)
        process.exitCode = 1
      }
    } else {
      log.warn(
        { stalwart: Boolean(env.STALWART_URL) },
        "storage not sampled — STALWART_URL or STALWART_API_TOKEN is unset",
      )
    }

    // ── 3. usage → polar ────────────────────────────────────────────────────
    //
    // ⚠ AFTER THE LEDGER IS RECONCILED, NOT BEFORE. Leg 2 tops up units the
    // send path dropped; shipping first would leave those units un-ingested
    // until the next pass, which for a run that straddles a period boundary
    // means they are invoiced a month late.
    try {
      let pass = 0
      let shipped = 0
      let duplicates = 0
      // ⚠ BOUNDED, BECAUSE THIS SHARES A CRONJOB WITH A DEADLINE. A backlog
      // larger than this drains over subsequent runs rather than making one run
      // exceed `activeDeadlineSeconds` and be killed mid-flush.
      for (; pass < 20; pass += 1) {
        const report = await flushUsage({
          db,
          polar: polarClient({
            accessToken: env.POLAR_ACCESS_TOKEN,
            server: env.POLAR_SERVER,
            timeoutMs: 30_000,
          }),
          featureId: env.METERING_FEATURE_ID,
          eventName: env.METERING_EVENT_NAME,
          log,
        })
        shipped += report.shipped
        duplicates += report.duplicates
        if (!report.batchWasFull) break
      }

      log.info({ shipped, duplicates, passes: pass + 1 }, "usage ingest complete")
    } catch (error) {
      // ⚠ NOT FATAL, AND NOT LOST. Every un-shipped row still has
      // `ingested_at IS NULL`, so the next run finds exactly the same work.
      log.error({ err: error }, "usage ingest failed")
      captureError(error)
      process.exitCode = 1
    }

    // ── 3. tenants ↔ Polar ─────────────────────────────────────────────────
    try {
      const tenants = await reconcileTenantCustomers(
        db,
        entitlements,
        log,
        env.METERING_FREE_PLAN_ID,
      )
      log.info(
        {
          checked: tenants.checked,
          missing: tenants.missing.length,
          unverified: tenants.unverified.length,
        },
        "tenant/customer reconciliation complete",
      )

      // ⚠ A PAYING TENANT MISSING FROM POLAR IS ALWAYS WORTH WAKING SOMEBODY
      // FOR, however few. It is not a number drifting — it is a customer we
      // believe is paying whom the payment rail has never heard of, so every
      // usage event for them fails silently and no invoice will ever be raised.
      //
      // ⚠ AND IT COUNTS ONLY PAYING TENANTS NOW. Free tenants legitimately have
      // no Polar customer — one is created lazily by the checkout — so
      // including them made this fire on healthy state from the first signup
      // onwards. See `payingTenantsStatement`.
      if (tenants.missing.length > 0) {
        process.exitCode = 1
        captureError(
          new Error(
            `${tenants.missing.length} paying tenant(s) have no customer in Polar; ` +
              "their usage has never been recorded and they will never be invoiced",
          ),
          { missing: tenants.missing.slice(0, 20) },
        )
      }

      // Not a finding and not a failure: Polar could not answer, and the next
      // run asks again. Logged so a run of them is visible without being an
      // alert.
      if (tenants.unverified.length > 0) {
        log.warn(
          { unverified: tenants.unverified.map((t) => t.tenantId) },
          "could not confirm some tenants against Polar",
        )
      }
    } catch (error) {
      log.error({ err: error }, "tenant/customer reconciliation failed")
      captureError(error)
      process.exitCode = 1
    }

    // ── 4. Polar ↔ i10 ───────────────────────────────────────────────────
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
        // ⚠ A DIFFERENT OBJECT FROM THE LEDGER THE USAGE LEG READS, AND
        // DELIBERATELY SO. This one can move a customer between plans; that one
        // can only count. They were one client while both were Autumn over
        // HTTP, and splitting them is what makes "only the grant path grants a
        // plan" a fact about the wiring rather than a rule to remember.
        grants: subscriptionGrants({
          subscriptions,
          entitlements: postgresEntitlements({
            db,
            freePlanId: env.METERING_FREE_PLAN_ID,
          }),
          log,
        }),
        options: {
          planForProduct: (productId: string) =>
            Object.entries(env.POLAR_PRODUCTS).find(([, id]) => id === productId)?.[0],
          freePlanId: env.METERING_FREE_PLAN_ID,
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

      /*
       * ⚠ ITS OWN ALERT, BECAUSE IT IS ITS OWN PROBLEM AND IT IS THE ONE THIS
       * JOB CANNOT FIX. Everything else above is a repair that either worked or
       * will be retried in half an hour; a subscription with no
       * `customer.external_id` is money taken from somebody this pipeline
       * cannot identify, and every run from now until a human edits that
       * customer in Polar will discard it again. It has to be findable from
       * outside the pod logs, and it has to name the subscription so the fix is
       * a two-field edit rather than a search.
       */
      /*
       * ⚠ ITS OWN ALERT, AND ITS OWN PROBLEM, FOR THE SAME REASON `stranded`
       * HAS ONE. Until this existed these landed in `failed`, where they were
       * indistinguishable from a transient repair that the next run would fix —
       * except that no run would ever fix them, so the job failed every thirty
       * minutes and carried the whole Argo Application to Degraded with it.
       *
       * ⚠ AND IT REPORTS TWO THINGS AT ONCE. Polar is holding a live
       * subscription for a workspace that no longer exists, AND the deletion
       * path that is supposed to revoke immediately did not. The second is the
       * one worth chasing: this list is the evidence for it.
       *
       * ⚠ IT STILL EXITS NON-ZERO, WHICH MEANS THE JOB STAYS RED UNTIL SOMEBODY
       * ACTS. That is deliberate and it is the same call `stranded` makes:
       * money is involved, nothing here can resolve it, and a green run would
       * say the reconciliation agreed with Polar when it did not.
       */
      if (report.unknownTenant.length > 0) {
        process.exitCode = 1
        captureError(
          new Error(
            `${report.unknownTenant.length} Polar subscription(s) name a tenant id ` +
              "this database does not hold — usually a re-signup whose Polar customer " +
              "kept its old external_id. DO NOT revoke without checking: the customer " +
              "is probably live on a new workspace.",
          ),
          { unknownTenant: report.unknownTenant.slice(0, 20) },
        )
      }

      if (report.stranded.length > 0) {
        process.exitCode = 1
        captureError(
          new Error(
            `${report.stranded.length} Polar subscription(s) cannot be ` +
              "attributed to a tenant; nobody will ever be granted these plans",
          ),
          { stranded: report.stranded.slice(0, 20) },
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
