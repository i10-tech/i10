/**
 * Brings Stalwart's `Domain` objects in line with `core.mailbox_domains()`, then
 * exits.
 *
 * ⚠ IT EXISTS BECAUSE NOTHING ELSE CREATES THEM. Stalwart 1.0 answers `550
 * Relay not allowed` and fails every IMAP login for a domain it does not hold,
 * and only `i10.tech` is declared in plan.ndjson - so a customer domain that
 * starts hosting mailboxes has no working mail until a person adds it by hand.
 * The removal path disables a domain at once (see `onRemoving` in index.ts);
 * this is the half that creates, and the catch for any removal that failed.
 *
 * ⚠ EVERY 15 MINUTES. A verified domain waits this long for its first mailbox to
 * be able to receive. It is a handful of registry calls, so the cadence is cheap.
 *
 * ⚠ AND IT REPORTS BEFORE IT WRITES. `MAIL_DOMAINS_RECONCILE_APPLY` defaults off,
 * so the first runs log the plan and change nothing. It only ever touches
 * domains carrying our marker and only ever disables - see `stalwart-domains.ts`.
 */
import pino from "pino"
import { sql as query } from "drizzle-orm"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { createStalwartCaller } from "./mail/stalwart.js"
import { reconcileDomains } from "./mail/stalwart-domains.js"
import { captureError, initObservability, withMonitor } from "./observability.js"

const log = pino({ name: "i10-mail-domains-reconcile" })
const env = loadEnv()

initObservability({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT,
  service: "mail-domains-reconcile",
  release: process.env.GIT_SHA,
  log,
})

await withMonitor(
  {
    slug: "i10-mail-domains-reconcile",
    // ⚠ THIS MUST BE THE SCHEDULE IN
    // infra/k8s/i10/workloads/mail-domains-reconcile.yaml. Sentry decides a run
    // is missing by comparing the clock to this string.
    schedule: "*/15 * * * *",
    // Four missed slots, not one: a single skipped run on this cadence says
    // nothing, and alerting on it would train everybody to ignore the monitor.
    checkinMarginMinutes: 60,
    log,
  },
  async () => {
    // ⚠ A MISSING URL OR TOKEN IS A FAILED RUN, NOT A QUIET SUCCESS. A check-in
    // that says "ok" for a job that could not reach Stalwart hides exactly the
    // state this job exists to catch.
    if (!env.STALWART_URL || !env.STALWART_API_TOKEN) {
      const error = new Error("STALWART_URL and STALWART_API_TOKEN are required")
      log.fatal({ err: error }, "refusing to start")
      captureError(error, { phase: "boot" })
      process.exitCode = 1
      return
    }

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
      // ⚠ THROUGH THE FUNCTION, NEVER THE TABLE: `i10_api` is subject to row
      // level security and would see no tenant's domains. This is the same list
      // the mailbox routes and the projection treat as "may receive mail".
      const rows = (await db.execute(
        query`select name from core.mailbox_domains()`,
      )) as unknown as { name: string }[]
      const desired = new Set(rows.map((r) => String(r.name).toLowerCase()))

      const result = await reconcileDomains(
        createStalwartCaller({
          baseUrl: env.STALWART_URL,
          token: env.STALWART_API_TOKEN,
        }),
        desired,
        {
          apply: env.MAIL_DOMAINS_RECONCILE_APPLY,
          adopt: env.MAIL_DOMAINS_RECONCILE_ADOPT,
          // ⚠ OUR OWN DOMAINS, NEVER TOUCHED, whatever the marker says.
          protect: env.MAIL_DOMAINS,
        },
      )

      const { untouched, ...changes } = result
      log.info(
        {
          ...changes,
          untouched: untouched.length,
          applying: env.MAIL_DOMAINS_RECONCILE_APPLY,
        },
        env.MAIL_DOMAINS_RECONCILE_APPLY
          ? "mail domain reconcile complete"
          : "mail domain reconcile complete - reporting only, set MAIL_DOMAINS_RECONCILE_APPLY to act",
      )

      // ⚠ A DOMAIN WE WANT THAT SOMEBODY ELSE CREATED IS WORTH SAYING OUT LOUD.
      // It is left alone unless adoption is on, and until then its mail works
      // only because of whatever that person set up.
      if (result.adopt.length > 0 && !env.MAIL_DOMAINS_RECONCILE_ADOPT) {
        log.warn(
          { domains: result.adopt },
          "Stalwart holds wanted domains this job did not create and leaves alone",
        )
      }

      if (result.failed.length > 0) {
        log.error({ failed: result.failed }, "some Stalwart domain changes failed")
        captureError(new Error("mail domain reconcile could not apply everything"), {
          phase: "mail-domains",
        })
        process.exitCode = 1
      }
    } catch (error) {
      log.error({ err: error }, "mail domain reconcile failed")
      captureError(error, { phase: "mail-domains" })
      process.exitCode = 1
    } finally {
      await sql.end({ timeout: 5 })
    }
  },
)
