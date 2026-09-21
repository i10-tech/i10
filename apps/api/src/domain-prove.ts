/**
 * Tries again to prove the domains nobody has proved yet, then exits.
 *
 * ⚠ IT EXISTS BECAUSE REGISTRATION HAD EXACTLY ONE ATTEMPT. `verify` is the
 * only thing in the system that may create an SES identity — correctly, since
 * SES keys identities on the domain name inside one AWS account — and it is
 * reachable only from two HTTP routes. The console fires it once, about a
 * second after writing the records. DNS is usually not serving yet at that
 * instant, and on the manual path the customer publishes hours later, so that
 * single attempt missed and nothing ever made another. The domain sat
 * `not_started` until a human happened to press Verify again.
 *
 * ⚠ AND THE OTHER TWO SWEEPS COULD NOT HELP, BY CONSTRUCTION.
 * `domain-catchup.ts` asks SES about identities that already exist and its
 * selector filters `status <> 'not_started'`; `recheck.ts` re-proves domains
 * that are already verified. The state every domain is created in had no
 * background reader at all. This is it.
 *
 * ⚠ A SEPARATE CronJob RATHER THAN A BRANCH INSIDE `domain-catchup.ts`, on the
 * reasoning that already split catch-up from recheck: they do different work at
 * different cost. Catch-up makes one cheap `GetEmailIdentity` per row; this
 * runs a full ownership proof — several bounded DNS lookups against somebody
 * else's nameservers, plus a zone write for a delegated domain — so it wants
 * its own batch size, its own staleness window and its own failure signal.
 *
 * ⚠ AND ITS OWN Sentry MONITOR, because the failure is invisible in the data. A
 * pass that proved nothing because nobody's DNS was ready and a pass that could
 * not resolve anything at all both write nothing and stand nobody up. The
 * check-in is the only place that difference exists.
 */
import pino from "pino"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { assertRlsSubject, createDb } from "./db/client.js"
import { offlineIdentity, sesIdentity } from "./domains/identity.js"
import { powerDnsZones } from "./domains/powerdns.js"
import { proveWaitingDomains } from "./domains/prove.js"
import { domainStore } from "./domains/store.js"
import { postgresMeter } from "./metering/service.js"
import { secretBox } from "./webhooks/signing.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-domain-prove" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "domain-prove",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-domain-prove",
    // ⚠ THIS MUST BE THE SCHEDULE IN infra/k8s/i10/workloads/domain-prove.yaml.
    // Sentry decides a run is missing by comparing the clock to this string, so
    // a manifest edited without editing here leaves the job working and the
    // alerting wrong.
    schedule: "*/1 * * * *",
    /*
     * ⚠ FIFTEEN MISSED RUNS, NOT ONE, on the same reasoning as catch-up: a
     * single skipped slot on a minute cadence says nothing, and alerting on it
     * would train everybody to ignore the monitor.
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
      await assertRlsSubject(sql)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      process.exitCode = 1
      return
    }

    /*
     * ⚠ NO SEALING KEY MEANS NO STORE. Proving a domain ends in
     * `CreateEmailIdentity` with the DKIM private key this box holds, so a
     * deployment without one cannot finish the job this exists to do, and a
     * silent success would make the check-in claim otherwise.
     */
    const secrets = env.WEBHOOK_SECRET_KEY ? secretBox(env.WEBHOOK_SECRET_KEY) : null
    if (!secrets) {
      log.warn({}, "no WEBHOOK_SECRET_KEY — nothing to prove")
      await sql.end({ timeout: 5 })
      return
    }

    try {
      const summary = await proveWaitingDomains({
        db,
        domains: domainStore({
          db,
          // ⚠ THE SAME GATE THE API USES. With SES off, `offlineIdentity`
          // answers `pending` and registers nothing — so this job still proves
          // ownership and publishes zones, and simply has no provider to tell.
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
          /*
           * ⚠ THE ZONES MATTER MORE HERE THAN ANYWHERE ELSE. A delegated domain
           * cannot be proved until the zone we serve for it exists, and
           * publishing it is part of what `verify` does. Without this the sweep
           * would report `unproven` for ever about domains whose DNS is
           * perfect.
           */
          zones: powerDnsZones(db),
          log,
          secrets,
        }),
        log,
      })

      log.info(summary, "domain proof sweep complete")

      /*
       * ⚠ EVERY ATTEMPT THROWING IS OUR PROBLEM, NOT THE CUSTOMERS'. A pass
       * where every proof threw writes nothing and registers nobody, which is
       * indistinguishable in the data from a quiet pass where nobody's records
       * were up yet. `unproven` is the healthy answer and is deliberately NOT
       * counted here; only `failed` is.
       */
      if (summary.checked > 0 && summary.failed === summary.checked) {
        log.error(summary, "every proof attempt failed")
        captureError(new Error("domain proof sweep proved nothing"), {
          phase: "prove",
        })
        process.exitCode = 1
      }
    } catch (error) {
      log.error({ err: error }, "domain proof sweep failed")
      captureError(error, { phase: "prove" })
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
