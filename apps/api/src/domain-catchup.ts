/**
 * Asks SES about the domains still waiting on it, then exits.
 *
 * ⚠ IT EXISTS BECAUSE NOTHING ASKED TWICE. `recheck.ts` re-proves domains that
 * are ALREADY verified — `core.domains_due_recheck` selects on
 * `status = 'verified'` — so a domain that has not got there yet was read
 * exactly once, by whoever pressed Verify, and then never again. SES announces
 * a verification to nobody, so a domain it had verified sat `pending` in our
 * table indefinitely: a customer sent real mail, SES delivered it, and our
 * dashboard said the domain was not ready.
 *
 * ⚠ AND IT IS THE PRECONDITION FOR REFUSING ANYTHING. `send/accept.ts` gates on
 * `verified_at`, which is only honest while something keeps that column
 * current. Without this job the gate turns a cosmetic wrongness into a customer
 * who cannot send from a domain that works.
 *
 * ⚠ A SEPARATE CronJob RATHER THAN A BRANCH INSIDE `recheck.ts`, on the same
 * reasoning that split the sweep from the reconciler: they run on different
 * clocks. Re-proving ownership is a daily question about domains that are
 * fine; this is a per-minute question about somebody sitting in front of the
 * console waiting for a badge to turn green.
 *
 * ⚠ EVERY MINUTE, AND THE COST OF THAT IS POD CHURN RATHER THAN SES CALLS. What
 * limits how often any ONE domain is asked about is `staleMs` inside the sweep,
 * not the schedule — so tightening this from five minutes to one cut the worst
 * case somebody waits by five and left the per-domain call rate unchanged. What
 * it does buy is 1,440 pods a day instead of 288, each of which usually does one
 * indexed read and exits.
 *
 * ⚠ AND ITS OWN Sentry MONITOR, because the failure is invisible in the data.
 * A pass that asks nothing and a pass that cannot reach SES both write nothing
 * and stand nobody up — the check-in is the only place that difference exists.
 */
import pino from "pino"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { assertRlsSubject, createDb } from "./db/client.js"
import { catchUpWithProvider } from "./domains/catch-up.js"
import { offlineIdentity, sesIdentity } from "./domains/identity.js"
import { powerDnsZones } from "./domains/powerdns.js"
import { domainStore } from "./domains/store.js"
import { postgresMeter } from "./metering/service.js"
import { secretBox } from "./webhooks/signing.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-domain-catchup" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "domain-catchup",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-domain-catchup",
    // ⚠ THIS MUST BE THE SCHEDULE IN
    // infra/k8s/i10/workloads/domain-catchup.yaml. Sentry decides a run is
    // missing by comparing the clock to this string, so a manifest edited
    // without editing here leaves the job working and the alerting wrong.
    schedule: "*/1 * * * *",
    /*
     * ⚠ FIFTEEN MISSED RUNS, NOT ONE, BECAUSE THE JOB FIRES EVERY MINUTE. A
     * single skipped slot on a minute cadence says nothing — a node was busy,
     * a pull was slow — and alerting on it would train everybody to ignore the
     * monitor. Fifteen minutes with no successful pass is a real outage.
     */
    checkinMarginMinutes: 15,
    log,
  },
  async () => {
    const { sql, db } = createDb(env.DATABASE_URL)

    /*
     * ⚠ THE SAME CHECK EVERY OTHER ENTRY POINT MAKES. This job reaches across
     * tenants through one narrow SECURITY DEFINER function and writes through
     * `withTenant` like everything else, so the role still has to be the one
     * row level security applies to.
     */
    try {
      await assertRlsSubject(sql, log)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      // An exit code rather than `process.exit`, so the check-in and its flush
      // still run — the same reason reconcile.ts does it this way.
      process.exitCode = 1
      return
    }

    /*
     * ⚠ NO SEALING KEY MEANS NO STORE, AND THE JOB SAYS SO RATHER THAN
     * PRETENDING TO HAVE RUN. `domainStore` needs the box that holds DKIM
     * private keys; a deployment without one has no domains for this to catch
     * up on, and a silent success would make the check-in claim otherwise.
     */
    const secrets = env.WEBHOOK_SECRET_KEY ? secretBox(env.WEBHOOK_SECRET_KEY) : null
    if (!secrets) {
      log.warn({}, "no WEBHOOK_SECRET_KEY — nothing to catch up on")
      await sql.end({ timeout: 5 })
      return
    }

    try {
      const summary = await catchUpWithProvider({
        db,
        domains: domainStore({
          db,
          // ⚠ THE SAME GATE THE API USES. With SES off there is no provider to
          // ask and `offlineIdentity` answers `pending` for everything, which
          // is honest: nothing has confirmed anything.
          identity: env.SES_ENABLED
            ? sesIdentity(new SESv2Client({ region: env.AWS_REGION }), {
                log,
                region: env.AWS_REGION,
              })
            : offlineIdentity(),
          capacity: postgresMeter(db),
          region: env.AWS_REGION,
          ownDomains: env.MAIL_DOMAINS,
          dns: {
            spfInclude: env.MAIL_SPF_INCLUDE,
            bounceHost: env.MAIL_BOUNCE_HOST,
            nameservers: env.MAIL_NAMESERVERS,
          },
          zones: powerDnsZones(db),
          log,
          secrets,
        }),
        log,
      })

      log.info(summary, "domain catch-up complete")

      /*
       * ⚠ EVERY ASK FAILING IS OUR PROBLEM, NOT THE CUSTOMERS'. A pass where
       * every SES call threw writes nothing and verifies nobody, which is
       * indistinguishable in the data from a quiet pass with nothing to do.
       * The exit code is the only place that difference can be said.
       */
      if (summary.checked > 0 && summary.failed === summary.checked) {
        log.error(summary, "every provider call failed")
        captureError(new Error("domain catch-up reached no provider"), {
          phase: "catch-up",
        })
        process.exitCode = 1
      }
    } catch (error) {
      log.error({ err: error }, "domain catch-up failed")
      captureError(error, { phase: "catch-up" })
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
