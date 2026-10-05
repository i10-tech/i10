import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { verifySignature } from "../../src/webhooks/signing.js"
import { enabled, LAB, startLab, until, type Lab } from "./harness.js"

/**
 * The webhook conformance lab (#273). Every scenario the Svix lab ran on
 * 2026-10-05, asserted against our engine.
 *
 * ⚠ `test.failing` IS THE BASELINE, NOT A SHRUG. Bun inverts it: the suite
 * stays green while the behaviour is still wrong and turns red the day a fix
 * makes it pass, which is the prompt to flip it to `test`. Each one names the
 * issue under #272 that fixes it. `test.todo` is for features that have no
 * API yet, so there is nothing to call.
 *
 * Slow scenarios (a worker killed mid-delivery waits out the job lease) run
 * only with WEBHOOKS_LAB_SLOW=1.
 */

// A retry budget here is about nine seconds; Bun's default is five.
setDefaultTimeout(30_000)

const suite = enabled ? describe : describe.skip
const slow = process.env.WEBHOOKS_LAB_SLOW === "1" ? test : test.skip

let lab: Lab

suite("webhook conformance lab", () => {
  beforeAll(async () => {
    lab = await startLab()
  })
  afterAll(async () => {
    await lab.stop()
  })

  describe("delivery", () => {
    test("arrives quickly, signed with the three Standard Webhooks headers", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/basic")
      const sent = Date.now()
      const [id] = await lab.emit(t, { to: "x@y.z", k: 1 })
      const got = await until(() => lab.receiver.of("basic")[0], 5_000, 5)
      expect(got).toBeDefined()
      expect(got!.at - sent).toBeLessThan(1_000)
      expect(got!.headers["webhook-id"]).toBe(id)
      expect(
        verifySignature(
          ep.secret,
          got!.headers["webhook-id"]!,
          got!.body,
          got!.headers["webhook-signature"]!,
          got!.headers["webhook-timestamp"]!,
        ),
      ).toBe(true)
      expect(JSON.parse(got!.body)).toMatchObject({
        type: "email.delivered",
        data: { k: 1 },
      })
    })

    test("an endpoint receives only the event types it subscribed to", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "ok/only-bounced", { events: ["email.bounced"] })
      await lab.emit(t, { k: "sent" }, { type: "email.sent" })
      await lab.emit(t, { k: "bounced" }, { type: "email.bounced" })
      await until(() => lab.receiver.of("only-bounced").length >= 1, 3_000)
      await Bun.sleep(300)
      expect(lab.receiver.of("only-bounced").map((r) => r.data.k)).toEqual(["bounced"])
    })
  })

  describe("retries", () => {
    test("a flaky endpoint is retried until it succeeds, then left alone", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "flaky/flaky?n=2")
      await lab.emit(t, { k: 1 })
      const done = await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        10_000,
      )
      expect(done).toBe(true)
      await Bun.sleep(1_000)
      expect(lab.receiver.of("flaky")).toHaveLength(3)
    })

    test("a failing endpoint uses the whole budget and the row records it", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "fail/fail")
      await lab.emit(t, { k: 1 })
      const row = await until(async () => {
        const [d] = await lab.deliveries(ep.id)
        return d?.status === "failed" ? d : undefined
      }, 20_000)
      expect(row).toMatchObject({ status: "failed", attempts: LAB.maxAttempts })
      expect(lab.receiver.of("fail")).toHaveLength(LAB.maxAttempts)
    })

    test("a redirect is not followed", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "redirect/redir")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("redir").length >= 2, 5_000)
      expect(lab.receiver.of("redir-redirected")).toHaveLength(0)
    })

    test("a hanging endpoint is cut off at the timeout", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "hang/hang-timeout")
      await lab.emit(t, { k: 1 })
      const row = await until(async () => {
        const [d] = await lab.deliveries(ep.id)
        return d && d.attempts >= 1 ? d : undefined
      }, LAB.timeoutMs + 3_000)
      expect(row?.last_error).toBeTruthy()
    })

    // #276: Retry-After is not read today; the next attempt follows our own
    // backoff (250ms here) whatever the endpoint asked for.
    test.failing("Retry-After is honoured", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "ratelimit/rl?s=3")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("rl").length >= 2, 6_000)
      const [a, b] = lab.receiver.of("rl")
      expect(b!.at - a!.at).toBeGreaterThanOrEqual(2_900)
    })

    // #276: a 429 gets no penalty beyond the normal backoff. Measured: a 429
    // and a 500 for the same event are retried at the same moments.
    test.failing("a 429 is retried later than an ordinary failure", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "fail/plain500")
      await lab.endpoint(t, "ratelimit/rl-nohdr?s=0")
      await lab.emit(t, { k: 1 })
      await until(
        () =>
          lab.receiver.of("plain500").length >= 2 &&
          lab.receiver.of("rl-nohdr").length >= 2,
        5_000,
      )
      const gap = (tag: string) => {
        const [a, b] = lab.receiver.of(tag)
        return b!.at - a!.at
      }
      expect(gap("rl-nohdr")).toBeGreaterThan(gap("plain500") * 2)
    })
  })

  describe("ordering", () => {
    test("events reach an endpoint in the order they happened", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "jitter/order")
      const base = Date.now()
      // Recorded, then queued together newest first, so the order they arrive
      // in can only come from when they happened.
      for (let k = 0; k < 20; k++) {
        await lab.emit(t, { k }, { occurredAt: new Date(base + k), enqueue: false })
      }
      await lab.enqueuePending(ep.id)
      await until(() => lab.receiver.of("order").length >= 20, 10_000)
      expect(lab.receiver.of("order").map((r) => r.data.k)).toEqual(
        Array.from({ length: 20 }, (_, k) => k),
      )
    })

    // #277: strict FIFO holds every later event behind a failing head for the
    // head's whole retry budget. Decision 1 bounds that stall.
    test.failing(
      "a failing head does not hold the endpoint for its whole retry budget",
      async () => {
        const t = await lab.workspace()
        const ep = await lab.endpoint(t, "failk/head?k=0")
        const base = Date.now()
        for (let k = 0; k < 5; k++) {
          await lab.emit(t, { k }, { occurredAt: new Date(base + k), enqueue: false })
        }
        await lab.enqueuePending(ep.id)
        // The head's budget is ~9s here. The others must not wait for it.
        const rest = await until(
          () => lab.receiver.of("head").filter((r) => r.data.k !== 0).length >= 4,
          3_000,
        )
        expect(rest).toBe(true)
      },
    )
  })

  describe("fairness", () => {
    // #278: concurrency is a shared pool of 8. Ten hanging endpoints from one
    // workspace take every slot, and another workspace waits out the timeout.
    test.failing("a quiet workspace is not delayed by a noisy one", async () => {
      const noisy = await lab.workspace()
      for (let i = 0; i < 10; i++) {
        await lab.endpoint(noisy, `hang/noisy-${i}`)
      }
      for (let i = 0; i < 5; i++) await lab.emit(noisy, { k: i })
      await until(() => lab.receiver.hanging() >= LAB.concurrency, 3_000)

      const quiet = await lab.workspace()
      await lab.endpoint(quiet, "ok/quiet")
      const sent = Date.now()
      await lab.emit(quiet, { k: "quiet" })
      const got = await until(() => lab.receiver.of("quiet")[0], 10_000, 10)
      expect(got!.at - sent).toBeLessThan(500)
    })

    test.todo("a per-endpoint throttle is enforced (#278)", () => {})
  })

  describe("SSRF", () => {
    // ⚠ EVERY ONE OF THESE IS REFUSED BEFORE A SOCKET OPENS. The receiver is on
    // 127.0.0.1 and only that address is allow-listed, so nothing below can
    // reach it - and the private ranges they name are not ours to probe.
    test.each([
      ["private.lab.test", "10.0.0.1"],
      ["metadata.lab.test", "169.254.169.254"],
      ["cgnat.lab.test", "100.64.0.1"],
      ["v6-loopback.lab.test", "::1"],
      ["mapped.lab.test", "::ffff:10.0.0.1"],
      ["rebind.lab.test", "a mixed public and private answer"],
      ["127.0.0.2", "another loopback address"],
      ["[::1]", "an IPv6 loopback literal"],
    ])("refuses %s (%s)", async (host) => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, `ok/ssrf-${host}`, { host })
      await lab.emit(t, { k: 1 })
      const row = await until(async () => {
        const [d] = await lab.deliveries(ep.id)
        return d && d.attempts >= 1 ? d : undefined
      }, 3_000)
      expect(row?.last_error).toMatch(/not a public address|could not be resolved/)
      expect(lab.receiver.of(`ssrf-${host}`)).toHaveLength(0)
    })
  })

  describe("signing", () => {
    test("during a grace period both the old and the new secret verify", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/rotate")
      const r = await lab.store.rotateSecret(t, ep.id, {
        action: "expire",
        expiresInSeconds: 600,
      })
      if (r.status !== "rotated") throw new Error(r.status)
      await lab.emit(t, { k: 1 })
      const got = await until(() => lab.receiver.of("rotate")[0], 5_000)
      for (const secret of [ep.secret, r.endpoint.secret!]) {
        expect(
          verifySignature(
            secret,
            got!.headers["webhook-id"]!,
            got!.body,
            got!.headers["webhook-signature"]!,
            got!.headers["webhook-timestamp"]!,
          ),
        ).toBe(true)
      }
    })

    test.todo(
      "custom endpoint headers cannot override signing headers (#281)",
      () => {},
    )
  })

  describe("durability", () => {
    // #279: the row says when the retry is owed, and the sweep re-queues it
    // after Redis forgets.
    test("a retry survives Redis losing its data", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "flaky/lost?n=1")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("lost").length >= 1, 3_000)
      await lab.redis.flushdb()
      const delivered = await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        10_000,
      )
      expect(delivered).toBe(true)
    })

    // #279: a row committed but never queued is due at once, and the sweep
    // finds it.
    test("a delivery whose enqueue failed after commit is still delivered", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/unqueued")
      await lab.emit(t, { k: 1 }, { enqueue: false })
      const delivered = await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        10_000,
      )
      expect(delivered).toBe(true)
    })

    // ⚠ THE LEASE IS WHAT LETS THE SWEEP RUN BESIDE THE QUEUE. A delivery
    // being attempted right now is due and pending, and must still never be
    // handed out a second time.
    test("the sweep never takes a delivery a worker is attempting", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "hang/leased")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("leased").length >= 1, 3_000)
      // Past the sweep's grace, still inside the attempt's timeout.
      await Bun.sleep(LAB.sweepGraceSeconds * 1000 + 200)
      const found = await lab.engine.sweep()
      expect(found).toBe(0)
      expect(lab.receiver.of("leased")).toHaveLength(1)
    })

    slow(
      "a delivery in flight when the worker dies is delivered after restart",
      async () => {
        const t = await lab.workspace()
        const ep = await lab.endpoint(t, "flaky/crash?n=1")
        await lab.emit(t, { k: 1 })
        await until(() => lab.receiver.of("crash").length >= 1, 3_000)
        await lab.restart(0)
        const delivered = await until(
          async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
          120_000,
          500,
        )
        expect(delivered).toBe(true)
      },
      130_000,
    )
  })
})
