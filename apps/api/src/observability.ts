import * as Sentry from "@sentry/node"

/**
 * Error reporting, and the one thing that notices a job which never ran.
 *
 * ⚠ THIS EXISTS BECAUSE A FAILURE THAT NOBODY SEES IS NOT HANDLED, IT IS
 * HIDDEN. The billing reconciler failed five consecutive runs over two and a
 * quarter hours and the only reason anyone found out is that somebody read pod
 * logs by hand. Every part of it behaved as designed: the job exited non-zero,
 * Kubernetes recorded the failure, `failedJobsHistoryLimit` kept the evidence.
 * Nothing was broken except that no one was told.
 *
 * ⚠ AND CHECK-INS CATCH THE FAILURE THAT NOTHING ELSE CAN. A job that runs and
 * fails leaves a pod behind to find. A job that never starts — a suspended
 * CronJob, a schedule someone edited, a cluster too full to place the pod —
 * leaves nothing at all, and no in-process error handler can report an absence.
 * Sentry knows the schedule, so it can tell the difference between "failed" and
 * "never arrived". That is the whole reason the schedule is declared here in
 * code rather than configured in a dashboard.
 *
 * ⚠ ERRORS ONLY, NO TRACING, AND THE COST IS MEASURED RATHER THAN ASSUMED.
 * Importing and initialising this SDK costs about 60 MB of RSS; leaving
 * `registerEsmLoaderHooks` on would make it 73 MB, because the loader hook
 * pulls in the OpenTelemetry auto-instrumentation for every library it can
 * find. Twelve of those megabytes are what turning it off buys, and the other
 * sixty are the price of `@sentry/node` at all. Worth knowing before adding a
 * fourth process to this box. Turning tracing on later is a config change here
 * and nothing else.
 */

/** What pino gives us. Narrow, so tests can pass an object literal. */
export interface Logger {
  info: (o: object, m: string) => void
  warn: (o: object, m: string) => void
  error: (o: object, m: string) => void
}

/** One process, one of these. It becomes the `service` tag on every event. */
export type Service = "api" | "worker" | "reconcile"

export interface ObservabilityOptions {
  /**
   * ⚠ OPTIONAL, AND ITS ABSENCE IS A DELIBERATE, VISIBLE STATE — the same rule
   * as AUTUMN_SECRET_KEY. Without it nothing is reported and the boot log says
   * so in a line you can grep for. A local checkout should not need a Sentry
   * account, and a production that quietly lost its DSN should not look
   * identical to one that has it.
   */
  dsn?: string
  environment: string
  service: Service
  /** The commit, so an issue points at the code that raised it. */
  release?: string
  log: Logger
}

let enabled = false

/** Whether events are actually going anywhere. Exported for the check-in path. */
export function observabilityEnabled(): boolean {
  return enabled
}

export function initObservability(opts: ObservabilityOptions): boolean {
  if (!opts.dsn) {
    opts.log.warn(
      { service: opts.service },
      "SENTRY_DSN not set — errors are logged here and reported nowhere",
    )
    enabled = false
    return false
  }

  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    // ⚠ NO `tracesSampleRate`, SO NOTHING IS SAMPLED AND NO SPANS ARE BUILT.
    // Leaving it unset is not the same as setting it to 0 in cost: unset means
    // the performance machinery never starts at all.
    registerEsmLoaderHooks: false,
    // ⚠ FALSE IS THE DEFAULT AND IT IS WRITTEN OUT ANYWAY. This is an email
    // product: the "personal information" the flag governs is the recipient
    // list. Anyone reading this file should see the answer without having to
    // know which way the SDK leans.
    sendDefaultPii: false,
    // Stack-frame locals would carry message bodies, API keys and connection
    // strings straight past the scrubber below, which only reads strings.
    includeLocalVariables: false,
    initialScope: { tags: { service: opts.service } },
    beforeSend: (event) => {
      try {
        return scrubEvent(event)
      } catch (err) {
        // ⚠ DROP THE EVENT RATHER THAN SEND IT UNSCRUBBED. A bug in the
        // scrubber costs us one report; sending the event anyway could put a
        // customer's recipient list in a third-party system, which is not a
        // thing that can be taken back. The local log still has everything.
        opts.log.error({ err }, "dropped a Sentry event the scrubber could not clean")
        return null
      }
    },
  })

  enabled = true
  opts.log.info(
    { service: opts.service, environment: opts.environment, release: opts.release },
    "reporting errors to Sentry",
  )
  return true
}

/*
 * ⚠ THE PATTERNS BELOW ARE THE PRIVACY BOUNDARY, NOT A TIDINESS PASS.
 *
 * `describeError` deliberately puts the name and message of a failure into
 * strings that get written wherever a person can read them — and in this
 * codebase those messages carry recipient addresses, the tenant's API key and
 * the Postgres URL, because that is exactly what makes them useful at three in
 * the morning. Locally that is right. Leaving the process it stops being our
 * data to spend, so every string on its way out goes through here first.
 *
 * ⚠ TENANT IDS ARE DELIBERATELY NOT REDACTED. They are opaque UUIDs that
 * identify an account rather than a person, and they are the one dimension that
 * makes an issue actionable — "which customer is this happening to" is the
 * first question anyone asks. Redacting them would leave reports nobody can act
 * on, which is the same as having none.
 */
const PATTERNS: [RegExp, string][] = [
  // Credentials in a connection string. Before the address pattern, because
  // `user:password@host` also looks like an email address and the replacement
  // should say what was removed.
  [/\b(postgres(?:ql)?|redis|rediss|amqp|mongodb):\/\/[^\s/@]+@/gi, "$1://[redacted]@"],
  // `Bearer …`, however the header was spelled.
  [/\bbearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]"],
  // Our customers' API keys, Clerk's, Polar's, and any webhook signing secret.
  // One alternation rather than four passes: they share a shape.
  [/\b(?:ak|sk|pk|whsec|rk)_[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  [/\bpolar_[a-z]+_[A-Za-z0-9]{8,}/gi, "[redacted-key]"],
  // Anything that reads as an address. Last, so the more specific rules above
  // have already claimed what they recognise.
  [/[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[redacted-email]"],
]

/** One string, cleaned. Exported because this is the part worth testing. */
export function scrub(value: string): string {
  let out = value
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Every string in the event, cleaned.
 *
 * ⚠ IT WALKS THE WHOLE OBJECT RATHER THAN A LIST OF FIELDS. A list is a
 * promise to remember every place Sentry might put a string — exception values,
 * breadcrumb messages, `extra`, request headers, the culprit line — and to
 * update it when the SDK adds one. The walk cannot fall behind.
 */
const MAX_DEPTH = 12

/** Exported for the test that proves nothing gets past the walk. */
export function scrubEvent<T>(event: T): T {
  return walk(event, 0, new WeakSet()) as T
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrub(value)
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return value

  // A Sentry event is a plain tree, but `extra` holds whatever a caller put
  // there, and that can be cyclic.
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = walk(value[i], depth + 1, seen)
    return value
  }

  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    record[key] = walk(record[key], depth + 1, seen)
  }
  return record
}

/**
 * Hands the buffered events to the network before the process is allowed to
 * die.
 *
 * ⚠ WITHOUT THIS THE SHORT-LIVED JOBS REPORT NOTHING, AND THEY ARE THE ONES
 * THIS WAS BUILT FOR. `captureException` queues; the transport sends on a
 * timer. A CronJob that captures an error and returns immediately exits with
 * the event still in the buffer, so the failure that started all of this would
 * still be invisible — only now with a Sentry integration to make it look
 * covered.
 */
export async function flushObservability(timeoutMs = 4000): Promise<void> {
  if (!enabled) return
  await Sentry.flush(timeoutMs)
}

export interface MonitorOptions {
  /** Must match the monitor in Sentry. Stable — renaming it orphans history. */
  slug: string
  /** Crontab, and it must be the CronJob's own schedule. */
  schedule: string
  /** Minutes late before a missing run is called missed. */
  checkinMarginMinutes?: number
  /** Minutes running before a run is called timed out. */
  maxRuntimeMinutes?: number
  log: Logger
}

/**
 * Runs a scheduled job, telling Sentry when it started and how it ended.
 *
 * ⚠ THE VERDICT COMES FROM `process.exitCode`, NOT FROM WHETHER `run` THREW,
 * and that is the point rather than a shortcut. The reconciler reports a failed
 * repair by setting an exit code and returning normally — a run where every
 * tenant failed is not an exception, it is a report. Reading the exit code is
 * the only way the check-in and the pod's own status cannot disagree, and
 * "green in Sentry, red in kubectl" is precisely the confusion this is meant to
 * end.
 */
export async function withMonitor<T>(
  opts: MonitorOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled) return run()

  const startedAt = Date.now()
  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: opts.slug, status: "in_progress" },
    {
      schedule: { type: "crontab", value: opts.schedule },
      checkinMargin: opts.checkinMarginMinutes,
      maxRuntime: opts.maxRuntimeMinutes,
      // ⚠ UTC, BECAUSE THE CLUSTER IS. A CronJob schedule with no timezone runs
      // on the kubelet's clock, and saying anything else here would have Sentry
      // expecting runs at hours they never happen.
      timezone: "Etc/UTC",
    },
  )

  const finish = (status: "ok" | "error") => {
    Sentry.captureCheckIn({
      monitorSlug: opts.slug,
      status,
      checkInId,
      duration: (Date.now() - startedAt) / 1000,
    })
  }

  try {
    const result = await run()
    finish(process.exitCode ? "error" : "ok")
    return result
  } catch (error) {
    finish("error")
    Sentry.captureException(error)
    throw error
  } finally {
    // ⚠ IN `finally`, SO THE RETHROW ABOVE STILL WAITS FOR IT. A throw that
    // skipped the flush would lose the very event describing it.
    await flushObservability().catch((err: unknown) => {
      opts.log.warn({ err }, "could not flush Sentry before exit")
    })
  }
}

/** Reports an error we are about to exit on. `index.ts` and `worker.ts` boot paths. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return
  Sentry.captureException(error, context ? { extra: context } : undefined)
}
