/**
 * Finds what we are still holding for domains that no longer exist, then exits.
 *
 * ⚠ IT EXISTS BECAUSE THE TIDY IS ALLOWED TO FAIL AND NOTHING COUNTED THE
 * FAILURES. `remove` deletes the row first and then cleans up the SES identity
 * and the three zones, swallowing errors in both — the right trade, because the
 * domain really is deleted and a 500 the customer cannot act on is worse. It is
 * not the right trade against a failure that happens EVERY time, and that is
 * what was happening: `ses:DeleteEmailIdentity` was missing from the IAM policy,
 * so every identity delete returned AccessDenied and left a live, billable,
 * still-sendable identity behind.
 *
 * ⚠ AND THE ZONE HALF HAD ITS OWN VERSION OF THE SAME BUG. `holdsZones` read a
 * missing `core.delegations` row as "not mine", which is true of every delegated
 * domain created before claims existed — in this deployment, all of them.
 *
 * ⚠ DAILY, NOT PER-MINUTE. Catch-up and prove answer "is somebody's domain
 * ready yet" for a person watching a badge. This answers "what did we leak",
 * which nobody is waiting on and which cannot get meaningfully worse in an
 * afternoon. It also lists an entire SES account, which is not a thing to do
 * sixty times an hour.
 *
 * ⚠ AND IT REPORTS BEFORE IT REMOVES. `DOMAIN_ORPHANS_REMOVE` defaults off, so
 * the first runs write down exactly what they would delete and delete nothing.
 * See the note on the flag: this is the only job here whose mistakes cannot be
 * undone.
 */
import pino from "pino"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { assertRlsSubject, createDb } from "./db/client.js"
import { offlineIdentity, sesIdentity } from "./domains/identity.js"
import { sweepOrphans } from "./domains/orphans.js"
import { powerDnsZones } from "./domains/powerdns.js"
import { loadEnv } from "./env.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-domain-orphans" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "domain-orphans",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-domain-orphans",
    // ⚠ THIS MUST BE THE SCHEDULE IN
    // infra/k8s/i10/workloads/domain-orphans.yaml. Sentry decides a run is
    // missing by comparing the clock to this string.
    schedule: "41 4 * * *",
    /*
     * ⚠ GENEROUS, BECAUSE THE JOB IS DAILY. One missed slot on a daily cadence
     * is a real gap but not an emergency, and the thing it watches for cannot
     * get worse quickly.
     */
    checkinMarginMinutes: 120,
    log,
  },
  async () => {
    const { sql, db } = createDb(env.DATABASE_URL)

    try {
      await assertRlsSubject(sql, log)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      process.exitCode = 1
      return
    }

    try {
      const summary = await sweepOrphans({
        db,
        identity: env.SES_ENABLED
          ? sesIdentity(new SESv2Client({ region: env.AWS_REGION }), {
              log,
              region: env.AWS_REGION,
            })
          : offlineIdentity(),
        zones: powerDnsZones(db),
        // ⚠ OUR OWN SENDING DOMAINS, NEVER TOUCHED. See the note in orphans.ts:
        // being wrong about these stops our own mail, receipts and password
        // resets included.
        ownDomains: env.MAIL_DOMAINS,
        remove: env.DOMAIN_ORPHANS_REMOVE,
        log,
      })

      log.info(
        { ...summary, removing: env.DOMAIN_ORPHANS_REMOVE },
        env.DOMAIN_ORPHANS_REMOVE
          ? "orphan sweep complete"
          : "orphan sweep complete — reporting only, set DOMAIN_ORPHANS_REMOVE to act",
      )

      /*
       * ⚠ A FOREIGN IDENTITY IS WORTH SAYING OUT LOUD EVEN THOUGH IT IS LEFT
       * ALONE. It means an identity exists in the account that this product did
       * not create and does not know about — somebody working around the
       * product, or a leftover from before it. Neither is actionable by the
       * sweep and both are worth a human knowing.
       */
      if (summary.identitiesForeign > 0) {
        log.warn(
          { count: summary.identitiesForeign },
          "SES holds identities this database does not know about and we did not create",
        )
      }

      if (summary.failed > 0) {
        log.error(summary, "some orphans could not be removed")
        captureError(new Error("orphan sweep could not remove everything"), {
          phase: "orphans",
        })
        process.exitCode = 1
      }
    } catch (error) {
      log.error({ err: error }, "orphan sweep failed")
      captureError(error, { phase: "orphans" })
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
