import { describe, expect, it } from "bun:test"
import { intervalToMs, loadEnv } from "../src/env.js"

/** The minimum a process needs before the interesting checks are reachable. */
const base: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
  REDIS_URL: "redis://localhost:6379",
  CLERK_WEBHOOK_SECRET: "whsec_test",
  CLERK_SECRET_KEY: "sk_test_abc",
  MAIL_DOMAINS: "i10.tech",
  SES_CONFIGURATION_SET: "i10-events",
}

describe("reading a Postgres interval", () => {
  it("reads the forms the defaults use", () => {
    expect(intervalToMs("5 minutes")).toBe(300_000)
    expect(intervalToMs("30 minutes")).toBe(1_800_000)
    expect(intervalToMs("1 hour")).toBe(3_600_000)
    expect(intervalToMs("90s")).toBe(90_000)
    expect(intervalToMs("2 min 30 sec")).toBe(150_000)
    expect(intervalToMs("00:05:00")).toBe(300_000)
  })

  // ⚠ NULL RATHER THAN A GUESS. Postgres accepts more than this understands,
  // and a parser that returned a plausible number for `P1DT2H` would make the
  // check below fail on correct configuration — which is worse than not
  // checking, because it stops a deploy that was fine.
  it("declines what it does not fully understand", () => {
    expect(intervalToMs("P1DT2H")).toBeNull()
    expect(intervalToMs("1 mon")).toBeNull()
    expect(intervalToMs("a while")).toBeNull()
    expect(intervalToMs("5 minutes ago")).toBeNull()
  })
})

describe("the claim must outlive the lease", () => {
  it("accepts the defaults", () => {
    const env = loadEnv(base)

    expect(env.WORKER_CLAIM_STALE_AFTER).toBe("5 minutes")
    expect(env.WORKER_JOB_TIMEOUT_MS).toBe(120_000)
  })

  // ⚠ THE MISCONFIGURATION THIS EXISTS FOR. Postgres releasing a row before
  // Redis releases the job means two workers can both win the compare-and-swap,
  // and the duplicate send stops being exceptional. The two are set
  // independently in Doppler and nothing else would report the mistake.
  it("refuses a claim shorter than the lease", () => {
    expect(() => loadEnv({ ...base, WORKER_CLAIM_STALE_AFTER: "1 minute" })).toThrow(
      /must be longer than WORKER_JOB_TIMEOUT_MS/,
    )
  })

  it("refuses them being equal", () => {
    expect(() =>
      loadEnv({
        ...base,
        WORKER_CLAIM_STALE_AFTER: "30 seconds",
        WORKER_JOB_TIMEOUT_MS: "30000",
      }),
    ).toThrow(/must be longer/)
  })

  it("leaves an interval it cannot read unenforced rather than rejected", () => {
    const env = loadEnv({ ...base, WORKER_CLAIM_STALE_AFTER: "1 mon" })

    expect(env.WORKER_CLAIM_STALE_AFTER).toBe("1 mon")
  })
})

/**
 * ⚠ THE FAILURE THIS PREVENTS LEAVES NOTHING BEHIND. An unset
 * SENTRY_ENVIRONMENT does not error, does not warn and does not lose an event —
 * it files production's errors under "development", where every dashboard and
 * alert that filters by environment quietly skips them. The only symptom is a
 * Sentry project that looks calm.
 */
describe("production must name its environment", () => {
  it("refuses the development fallback when NODE_ENV is production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production" })).toThrow(
      /SENTRY_ENVIRONMENT/,
    )
  })

  // ⚠ Staging and production run THE SAME IMAGE, so NODE_ENV cannot tell them
  // apart and deriving the value would tag staging's errors as production's.
  // An explicit statement is the only thing that distinguishes them.
  it("accepts any explicit environment, staging included", () => {
    for (const environment of ["production", "staging"]) {
      const env = loadEnv({
        ...base,
        NODE_ENV: "production",
        SENTRY_ENVIRONMENT: environment,
      })
      expect(env.SENTRY_ENVIRONMENT).toBe(environment)
    }
  })

  // ⚠ And it stays silent everywhere else — a developer's machine and CI both
  // want the fallback, and a check that fired there would be turned off.
  it("leaves development and test alone", () => {
    expect(loadEnv(base).SENTRY_ENVIRONMENT).toBe("development")
    expect(loadEnv({ ...base, NODE_ENV: "test" }).SENTRY_ENVIRONMENT).toBe(
      "development",
    )
  })
})

/**
 * ⚠ THE DEFAULT PORT IS A FACT ABOUT OUR SERVER, NOT A CONVENTION, AND IT WAS
 * WRONG. Stalwart's listeners are `smtp` on 25 and `submissions` on 465 —
 * checked on the running server 2026-09-17 — and nothing answers on 587. This
 * defaulted to 587 for as long as the direct route existed, so a deployment that
 * set the host, user and password and trusted the default would have had every
 * direct send refused at the socket: `deferred`, in the queue, behind an
 * ECONNREFUSED nobody reads.
 *
 * ⚠ AND 465 IS NOT A COMPROMISE. It is implicit TLS from the first byte; 587 is
 * cleartext until STARTTLS succeeds. RFC 8314 §3 prefers the former precisely
 * because there is no plaintext phase to strip. `submissionConfig` derives the
 * TLS mode from this number, so the port is the only thing that has to be right.
 */
describe("the submission port", () => {
  it("defaults to 465, the listener that exists", () => {
    expect(loadEnv(base).STALWART_SUBMISSION_PORT).toBe(465)
  })

  it("is still overridable", () => {
    expect(
      loadEnv({ ...base, STALWART_SUBMISSION_PORT: "2525" }).STALWART_SUBMISSION_PORT,
    ).toBe(2525)
  })
})
