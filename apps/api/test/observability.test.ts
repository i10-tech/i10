import { beforeEach, describe, expect, it, vi } from "vitest"

// ⚠ MOCKED SO THE CHECK-IN TESTS BELOW CAN ASSERT WHAT WOULD BE SENT WITHOUT
// sending it. `initObservability` is what flips the module's `enabled` flag, so
// a real `init` here would mean every later test in the process holds a live
// client pointed at a fake DSN.
// `vi.hoisted` because `vi.mock` is lifted above every const in this file, so
// the doubles have to exist before it runs. Typed, so `mock.calls` below is a
// real tuple rather than `[]` — the assertions are the point of the file.
const { captureCheckIn, captureException, flush } = vi.hoisted(() => ({
  captureCheckIn: vi.fn<(checkIn: { status: string }, config?: unknown) => string>(
    () => "check-in-id",
  ),
  captureException: vi.fn<(error: unknown) => string>(() => "event-id"),
  flush: vi.fn<(timeoutMs?: number) => Promise<boolean>>(() => Promise.resolve(true)),
}))

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureCheckIn,
  captureException,
  flush,
}))

const { initObservability, scrub, scrubEvent, withMonitor } =
  await import("../src/observability.js")

const log = { info: () => {}, warn: () => {}, error: () => {} }

describe("scrubbing what leaves the process", () => {
  it("redacts an address wherever it appears in the sentence", () => {
    expect(scrub("could not deliver to ada@lovelace.example: mailbox full")).toBe(
      "could not deliver to [redacted-email]: mailbox full",
    )
  })

  it("redacts every key shape this codebase issues or holds", () => {
    expect(scrub("key ak_05a189dc5787c2ba0fd073eea808c957 was rejected")).toBe(
      "key [redacted-key] was rejected",
    )
    expect(scrub("clerk said no to sk_test_abcdefgh12345678")).toContain(
      "[redacted-key]",
    )
    expect(scrub("signature whsec_9fbc21aa77e0 did not verify")).toContain(
      "[redacted-key]",
    )
    expect(scrub("polar_oat_ZmFrZXRva2VuMTIz expired")).toBe("[redacted-key] expired")
  })

  it("takes the credentials out of a connection string", () => {
    expect(
      scrub("connect ECONNREFUSED postgres://i10_api:hunter2@db.internal:5432/i10"),
    ).toBe("connect ECONNREFUSED postgres://[redacted]@db.internal:5432/i10")
  })

  it("redacts a bearer token however the header was spelled", () => {
    expect(scrub("sent authorization: Bearer eyJhbGciOi.J9-x_y")).toBe(
      "sent authorization: Bearer [redacted]",
    )
  })

  // ⚠ THE ONE THING DELIBERATELY LEFT IN. A tenant id names an account, not a
  // person, and it is the first question anyone asks of an issue. Redacting it
  // would leave reports nobody can act on.
  it("leaves tenant ids alone", () => {
    const real =
      "autumn billing.attach failed with 409 for 01a066ee-d259-766c-a455-3284142e6d28 -> free"
    expect(scrub(real)).toBe(real)
  })

  // ⚠ REGRESSION TEST FOR A REAL LOSS OF SIGNAL. The first pattern's local part
  // allowed `/`, and its domain allowed a bare number — so a pnpm store path
  // read as an address and every dependency frame in a stack trace came back as
  // `[redacted-email]`. Nothing leaked; the report simply stopped saying which
  // library had failed, which is the only thing it was for.
  it("leaves a pnpm store path in a stack frame readable", () => {
    const frame =
      "/app/node_modules/.pnpm/groupmq@1.2.3_ioredis@5.8.2_/node_modules/groupmq/dist/index.js:1876:8"
    expect(scrub(frame)).toBe(frame)
  })

  it("still redacts an address that sits next to a version number", () => {
    expect(scrub("ioredis@5.8.2 failed for ada@lovelace.example")).toBe(
      "ioredis@5.8.2 failed for [redacted-email]",
    )
  })

  it("reaches strings at every depth of an event, not a list of fields", () => {
    const event = {
      message: "send failed for ada@lovelace.example",
      exception: {
        values: [{ value: "key ak_05a189dc5787c2ba0fd073eea808c957 rejected" }],
      },
      breadcrumbs: [{ message: "POST /emails to grace@hopper.example" }],
      extra: { nested: { deep: ["mailto:alan@turing.example"] } },
    }

    const cleaned = scrubEvent(event)

    expect(JSON.stringify(cleaned)).not.toMatch(/@\w+\.example/)
    expect(cleaned.exception.values[0]!.value).toBe("key [redacted-key] rejected")
    expect(cleaned.extra.nested.deep[0]).toBe("mailto:[redacted-email]")
  })

  it("survives an object that points at itself", () => {
    const cyclic: Record<string, unknown> = { message: "to ada@lovelace.example" }
    cyclic.self = cyclic
    expect(() => scrubEvent(cyclic)).not.toThrow()
    expect(cyclic.message).toBe("to [redacted-email]")
  })
})

describe("check-ins for a scheduled job", () => {
  beforeEach(() => {
    captureCheckIn.mockClear()
    captureException.mockClear()
    flush.mockClear()
    process.exitCode = undefined
  })

  it("does nothing at all without a DSN, and still runs the job", async () => {
    initObservability({ environment: "test", service: "reconcile", log })
    const run = vi.fn(async () => "done")

    await expect(
      withMonitor({ slug: "s", schedule: "*/30 * * * *", log }, run),
    ).resolves.toBe("done")
    expect(run).toHaveBeenCalled()
    expect(captureCheckIn).not.toHaveBeenCalled()
  })

  it("declares the schedule so Sentry can notice a run that never happened", async () => {
    initObservability({
      dsn: "https://k@o0.ingest.de.sentry.io/1",
      environment: "test",
      service: "reconcile",
      log,
    })

    await withMonitor(
      { slug: "i10-billing-reconcile", schedule: "*/30 * * * *", log },
      async () => {},
    )

    expect(captureCheckIn.mock.calls[0]?.[1]).toMatchObject({
      schedule: { type: "crontab", value: "*/30 * * * *" },
      timezone: "Etc/UTC",
    })
  })

  // ⚠ REGRESSION TEST FOR A REAL OUTAGE OF THIS FEATURE. The first version sent
  // `in_progress` and then a verdict. On the first production run the verdict
  // never arrived — the pod lived two seconds — and the monitor sat
  // `in_progress` until `max_runtime` turned a successful run into a timeout
  // alert. One self-contained envelope has no second packet to lose.
  it("sends exactly one check-in, with no in_progress to be left hanging", async () => {
    initObservability({
      dsn: "https://k@o0.ingest.de.sentry.io/1",
      environment: "test",
      service: "reconcile",
      log,
    })

    await withMonitor({ slug: "s", schedule: "* * * * *", log }, async () => {})

    expect(captureCheckIn).toHaveBeenCalledTimes(1)
    expect(captureCheckIn.mock.calls[0]?.[0].status).toBe("ok")
  })

  // ⚠ THE WHOLE POINT OF READING THE EXIT CODE. The reconciler reports a run
  // where every tenant failed by setting an exit code and returning normally —
  // no exception is thrown. A check-in that only watched for throws would call
  // that run a success while kubectl showed it red.
  it("calls a run that set a failing exit code an error, though nothing threw", async () => {
    initObservability({
      dsn: "https://k@o0.ingest.de.sentry.io/1",
      environment: "test",
      service: "reconcile",
      log,
    })

    await withMonitor({ slug: "s", schedule: "* * * * *", log }, async () => {
      process.exitCode = 1
    })

    expect(captureCheckIn.mock.calls.at(-1)?.[0]).toMatchObject({ status: "error" })
  })

  it("calls a clean run ok", async () => {
    initObservability({
      dsn: "https://k@o0.ingest.de.sentry.io/1",
      environment: "test",
      service: "reconcile",
      log,
    })

    await withMonitor({ slug: "s", schedule: "* * * * *", log }, async () => {})

    expect(captureCheckIn.mock.calls.at(-1)?.[0]).toMatchObject({ status: "ok" })
  })

  // A short-lived job that exits before the transport runs reports nothing, so
  // the flush is the difference between an integration and the look of one.
  it("reports and flushes when the job throws, then rethrows", async () => {
    initObservability({
      dsn: "https://k@o0.ingest.de.sentry.io/1",
      environment: "test",
      service: "reconcile",
      log,
    })
    const boom = new Error("polar is down")

    await expect(
      withMonitor({ slug: "s", schedule: "* * * * *", log }, async () => {
        throw boom
      }),
    ).rejects.toThrow("polar is down")

    expect(captureCheckIn.mock.calls.at(-1)?.[0]).toMatchObject({ status: "error" })
    expect(captureException).toHaveBeenCalledWith(boom)
    expect(flush).toHaveBeenCalled()
  })
})
