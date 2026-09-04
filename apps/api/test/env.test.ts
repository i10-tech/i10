import { describe, expect, it } from "vitest"
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
