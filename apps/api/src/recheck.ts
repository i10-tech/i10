/**
 * Re-checks whether verified domains are still their holders', then exits.
 *
 * ⚠ VERIFICATION WAS ONE-SHOT AND DOMAINS OUTLIVE IT. A workspace that proved
 * `example.com` once kept the verified badge for ever - through the
 * registration lapsing, through somebody else buying it, through every record
 * being deleted. Nothing asked again, so "verified" meant "was true once",
 * which is not what anything downstream reads it as.
 *
 * ⚠ A CronJob RATHER THAN AN INTERVAL IN THE WORKER, for the reason given in
 * reconcile.ts and message-sweep.yaml: the worker Deployment scales on queue
 * depth, so an interval inside it would run once per replica - every replica
 * making the same DNS queries about the same customers.
 *
 * ⚠ AND IT IS THE CAUTIOUS HALF OF A PAIR. `domainStore.verify` demotes a
 * holder the moment somebody else PROVES the name, because that is positive
 * evidence the domain has moved. This has no challenger and no evidence except
 * an absence, so it only starts a clock - `core.domains.proof_missing_since` -
 * and a domain has to fail every check for a week before it is stood down.
 *
 * ⚠ IT EXITS NON-ZERO WHEN NOTHING COULD BE REACHED, which is the one failure
 * the summary cannot otherwise show. A pass where every lookup timed out writes
 * nothing, touches nobody and looks exactly like a quiet night - so a broken
 * resolver, a missing egress rule or a DNS outage would be invisible for as
 * long as it lasted.
 */
import pino from "pino"
import { SESv2Client } from "@aws-sdk/client-sesv2"
import { assertRlsSubject, createDb } from "./db/client.js"
import { sesIdentity } from "./domains/identity.js"
import { configurationSetsFor } from "./send/configuration-sets.js"
import { recheckDomains } from "./domains/recheck.js"
import { ensureSesTenant } from "./domains/ses-tenant.js"
import { nodeTxtLookup } from "./domains/ownership.js"
import { readDelegation } from "./domains/referral.js"
import { loadEnv } from "./env.js"
import {
  captureError,
  captureMessage,
  initObservability,
  withMonitor,
} from "./observability.js"
import { createClerkClient } from "@clerk/backend"
import { systemSenderFor } from "./auth-email/system.js"
import { createQueueClient } from "./cache/redis.js"
import { postgresMetering } from "./metering/service.js"
import { createSendQueue } from "./queue/send-queue.js"
import { resilient } from "./send/metering.js"
import { ownerNotice } from "./ses-status/notice.js"
import { pollTenantStatuses, sesTenantStatusReader } from "./ses-status/poll.js"
import { reputationService } from "./ses-status/reputation.js"
import { pollReputation, sesReputationReader } from "./ses-status/reputation-poll.js"
import { reputationStore } from "./ses-status/reputation-store.js"
import { sesStatusService } from "./ses-status/service.js"
import { sesStatusStore } from "./ses-status/store.js"

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
      await assertRlsSubject(sql, log)
    } catch (error) {
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      await sql.end({ timeout: 5 })
      // An exit code rather than `process.exit`, so the check-in and its flush
      // still run - the same reason reconcile.ts does it this way.
      process.exitCode = 1
      return
    }

    try {
      // ⚠ THE SAME GATE THE API USES: with SES off there is no tenant to join,
      // so the step is simply absent rather than pointed at an offline stub.
      const identity = env.SES_ENABLED
        ? sesIdentity(new SESv2Client({ region: env.AWS_REGION }), {
            log,
            region: env.AWS_REGION,
            accountId: env.AWS_ACCOUNT_ID,
            configurationSets: configurationSetsFor(env.SES_CONFIGURATION_SET),
          })
        : null

      const summary = await recheckDomains({
        db,
        probes: { txt: nodeTxtLookup(), delegation: readDelegation },
        nameservers: env.MAIL_NAMESERVERS,
        log,
        tenancy: identity
          ? (tenantId, domainId) =>
              ensureSesTenant({ db, identity, log }, tenantId, domainId)
          : undefined,
      })
      log.info(summary, "domain re-check complete")

      // ⚠ SAID OUT LOUD, NOT ONLY RETRIED. A domain that cannot be attached
      // keeps sending without tenant isolation, and a sweep that quietly tried
      // again every night would hide a broken IAM policy for as long as it
      // lasted - which is how the identity-delete gap survived for weeks.
      if (summary.tenantsFailed > 0) {
        captureError(
          new Error(
            `${summary.tenantsFailed} domain(s) could not join their SES tenant`,
          ),
          { phase: "recheck-tenancy" },
        )
      }

      if (env.SES_ENABLED) await pollSesStatuses(db, sql)

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

/**
 * The daily re-read of every SES tenant's sending status (#157) and
 * reputation (#158).
 *
 * ⚠ HERE BECAUSE THIS JOB ALREADY RUNS ONCE A DAY ACROSS EVERY WORKSPACE, and
 * the poll is the net under the EventBridge events - see ses-status/poll.ts. A
 * change it finds is recorded, enforced and emailed exactly as an event would
 * be, which is why it builds the same sender the API does.
 *
 * ⚠ ITS FAILURE DOES NOT FAIL THE DOMAIN RE-CHECK. The domains above were
 * checked and written already; a Redis or SES hiccup here is reported and
 * retried tomorrow.
 */
async function pollSesStatuses(
  db: ReturnType<typeof createDb>["db"],
  sql: ReturnType<typeof createDb>["sql"],
) {
  const redis = createQueueClient(env.REDIS_URL)
  redis.on("error", (err: Error) => log.error({ err }, "send queue unavailable"))
  try {
    const queue = (cls: "transactional" | "bulk") =>
      createSendQueue({
        redis,
        class: cls,
        jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
        maxAttempts: env.WORKER_MAX_ATTEMPTS,
      })
    const sender = await systemSenderFor({
      sql,
      db,
      queues: { transactional: queue("transactional"), bulk: queue("bulk") },
      metering: resilient(
        postgresMetering({
          db,
          featureId: env.METERING_FEATURE_ID,
          freePlanId: env.METERING_FREE_PLAN_ID,
          log,
        }),
        log,
      ),
      from: env.AUTH_EMAIL_FROM,
      tenantSlug: env.AUTH_EMAIL_TENANT_SLUG,
      log,
    })
    const consoleUrl = env.CONSOLE_ORIGINS[0]
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
    const store = sesStatusStore(db)
    const ses = new SESv2Client({ region: env.AWS_REGION })
    const notice =
      sender && consoleUrl ? ownerNotice({ db, clerk, sender, consoleUrl }) : undefined

    const summary = await pollTenantStatuses({
      reader: sesTenantStatusReader(ses),
      store,
      service: sesStatusService({
        store,
        ...(notice ? { notice } : {}),
        log,
        alert: captureError,
      }),
      log,
    })
    log.info(summary, "SES tenant status poll complete")
    if (summary.failed > 0) {
      captureError(
        new Error(`${summary.failed} SES tenant status(es) could not be read`),
        {
          phase: "recheck-ses-status",
        },
      )
    }

    /*
     * ⚠ REPUTATION AFTER STATUS, AND ITS OWN FAILURE COUNT (#158). A missing
     * IAM grant for `ListRecommendations` must not stop the status poll that
     * enforces pauses - so it runs second and reports separately.
     */
    const reputation = reputationStore(db)
    const found = await pollReputation({
      reader: sesReputationReader(ses),
      store: reputation,
      service: reputationService({
        store: reputation,
        ...(notice ? { notice } : {}),
        log,
        alert: (message, level, context) => captureMessage(message, level, context),
      }),
      log,
    })
    log.info(found, "SES reputation poll complete")
    if (found.failed > 0) {
      captureError(
        new Error(`${found.failed} SES tenant reputation(s) could not be read`),
        { phase: "recheck-ses-reputation" },
      )
    }
  } catch (error) {
    log.error({ err: error }, "SES tenant status poll failed")
    captureError(error, { phase: "recheck-ses-status" })
  } finally {
    await redis.quit().catch(() => {})
  }
}
