/**
 * Re-checks whether verified domains are still their holders', then exits.
 *
 * ⚠ VERIFICATION WAS ONE-SHOT AND DOMAINS OUTLIVE IT. A workspace that proved
 * `example.com` once kept the verified badge for ever — through the
 * registration lapsing, through somebody else buying it, through every record
 * being deleted. Nothing asked again, so "verified" meant "was true once",
 * which is not what anything downstream reads it as.
 *
 * ⚠ A CronJob RATHER THAN AN INTERVAL IN THE WORKER, for the reason given in
 * reconcile.ts and message-sweep.yaml: the worker Deployment scales on queue
 * depth, so an interval inside it would run once per replica — every replica
 * making the same DNS queries about the same customers.
 *
 * ⚠ AND IT IS THE CAUTIOUS HALF OF A PAIR. `domainStore.verify` demotes a
 * holder the moment somebody else PROVES the name, because that is positive
 * evidence the domain has moved. This has no challenger and no evidence except
 * an absence, so it only starts a clock — `core.domains.proof_missing_since` —
 * and a domain has to fail every check for a week before it is stood down.
 *
 * ⚠ IT EXITS NON-ZERO WHEN NOTHING COULD BE REACHED, which is the one failure
 * the summary cannot otherwise show. A pass where every lookup timed out writes
 * nothing, touches nobody and looks exactly like a quiet night — so a broken
 * resolver, a missing egress rule or a DNS outage would be invisible for as
 * long as it lasted.
 */
import pino from "pino"
import { assertRlsSubject, createDb } from "./db/client.js"
import { recheckDomains } from "./domains/recheck.js"
import { nodeTxtLookup } from "./domains/ownership.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-domain-recheck" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "domain-recheck",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-domain-recheck",
    // ⚠ THIS MUST BE THE SCHEDULE IN
    // infra/k8s/i10/workloads/domain-recheck.yaml. Sentry decides a run is
    // missing by comparing the clock to this string, so a manifest edited
    // without editing here leaves the job working and the alerting wrong.
    schedule: "17 3 * * *",
    checkinMarginMinutes: 30,
    log,
  },
  async () => {
    const { sql, db } = createDb(env.DATABASE_URL)

    // The same check the API, the worker, the sweep and the reconciler make.
    // This job reaches across every tenant through narrow SECURITY DEFINER
    // functions rather than by holding a role that can see everything, so the
    // role still has to be the one row level security applies to.
    try {
      await assertRlsSubject(sql)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      // An exit code rather than `process.exit`, so the check-in and its flush
      // still run — the same reason reconcile.ts does it this way.
      process.exitCode = 1
      return
    }

    try {
      const summary = await recheckDomains({ db, txt: nodeTxtLookup(), log })
      log.info(summary, "domain re-check complete")

      /*
       * ⚠ EVERY LOOKUP FAILING IS OUR PROBLEM, NOT THE CUSTOMERS'. A pass that
       * could not ask anything writes nothing and stands nobody down, which is
       * indistinguishable in the data from a pass where everything was fine.
       * The exit code is the only place that difference can be said.
       */
      if (summary.checked > 0 && summary.unreachable === summary.checked) {
        log.error(summary, "every lookup failed; the resolver or its egress is broken")
        captureError(new Error("domain re-check reached no nameserver"), {
          phase: "recheck",
        })
        process.exitCode = 1
      }
    } catch (error) {
      log.error({ err: error }, "domain re-check failed")
      captureError(error, { phase: "recheck" })
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
