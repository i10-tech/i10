import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { dueDeliveries } from "../../src/webhooks/db.js"
import { webhookHistory, type WebhookHistory } from "../../src/webhooks/history.js"
import { verifySignature } from "../../src/webhooks/signing.js"
import { enabled, LAB, LAB_RULES, startLab, until, type Lab } from "./harness.js"

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
let history: WebhookHistory

suite("webhook conformance lab", () => {
  beforeAll(async () => {
    lab = await startLab()
    history = webhookHistory(lab.db)
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

    // #276: never before what the endpoint asked for.
    test("Retry-After is honoured", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "ratelimit/rl?s=3")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("rl").length >= 2, 8_000)
      const [a, b] = lab.receiver.of("rl")
      expect(b!.at - a!.at).toBeGreaterThanOrEqual(3_000)
    })

    // #276: Svix's 429 penalty never applies (a 429 and a 500 were retried at
    // the same moments in its lab). Ours is a floor on the next gap.
    test("a 429 waits at least the overload penalty, a 500 does not", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "fail/plain500")
      await lab.endpoint(t, "ratelimit/rl-nohdr?s=0")
      await lab.emit(t, { k: 1 })
      await until(
        () =>
          lab.receiver.of("plain500").length >= 2 &&
          lab.receiver.of("rl-nohdr").length >= 2,
        10_000,
      )
      const gap = (tag: string) => {
        const [a, b] = lab.receiver.of(tag)
        return b!.at - a!.at
      }
      expect(gap("rl-nohdr")).toBeGreaterThanOrEqual(
        LAB_RULES.overloadPenaltySeconds * 1000,
      )
      expect(gap("plain500")).toBeLessThan(LAB_RULES.overloadPenaltySeconds * 1000)
    })

    // #276: the receiver said it is not coming back.
    test("a 410 ends the delivery and disables the endpoint at once", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "gone/gone")
      await lab.emit(t, { k: 1 })
      const row = await until(async () => {
        const [d] = await lab.deliveries(ep.id)
        return d?.status === "failed" ? d : undefined
      }, 5_000)
      expect(row?.attempts).toBe(1)
      const [endpoint] =
        await lab.owner`select enabled, disabled_reason from core.webhook_endpoints where id = ${ep.id}`
      expect(endpoint).toMatchObject({
        enabled: false,
        disabled_reason: "The endpoint answered 410 Gone.",
      })
    })

    // #276: disabled for a stretch of time with no success, not a count.
    test("an endpoint with no success for the plan's stretch is disabled when a delivery runs out", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "fail/stretch")
      await lab.emit(t, { k: 1 })
      const disabled = await until(async () => {
        const [e] =
          await lab.owner`select enabled, disabled_reason from core.webhook_endpoints where id = ${ep.id}`
        return e && !e.enabled ? e : undefined
      }, 25_000)
      expect(disabled?.disabled_reason).toMatch(/^No successful delivery for/)
    })

    test("one success ends the failing run, so the endpoint stays on", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "flaky/recovers?n=1")
      await lab.emit(t, { k: 1 })
      await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        8_000,
      )
      const [e] =
        await lab.owner`select enabled, failing_since from core.webhook_endpoints where id = ${ep.id}`
      expect(e).toMatchObject({ enabled: true, failing_since: null })
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

    // #277: ordered while healthy. A failing head holds its endpoint for the
    // hold (2s here, 5 minutes in production), then moves aside.
    test("a failing head does not hold the endpoint for its whole retry budget", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "failk/head?k=0")
      const base = Date.now()
      for (let k = 0; k < 5; k++) {
        await lab.emit(t, { k }, { occurredAt: new Date(base + k), enqueue: false })
      }
      await lab.enqueuePending(ep.id)
      // The head's whole budget is ~15s here (gaps 1, 2, 4, 4s, each plus
      // groupmq's second). The others must not wait for it.
      const rest = await until(
        () => lab.receiver.of("head").filter((r) => r.data.k !== 0).length >= 4,
        6_000,
      )
      expect(rest).toBe(true)
    })
  })

  describe("ordering after the hold", () => {
    test("the event set aside is still delivered, on the retry lane, after the rest", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "failk/aside?k=0&n=3")
      const base = Date.now()
      for (let k = 0; k < 3; k++) {
        await lab.emit(t, { k }, { occurredAt: new Date(base + k), enqueue: false })
      }
      await lab.enqueuePending(ep.id)
      const done = await until(
        async () =>
          (await lab.deliveries(ep.id)).every((d) => d.status === "delivered"),
        20_000,
      )
      expect(done).toBe(true)
      const order = lab.receiver
        .of("aside")
        .filter((r) => r.data.k !== 0 || r.n === 4)
        .map((r) => r.data.k)
      // 1 and 2 went on without it; 0 arrived on its fourth attempt, last.
      expect(order).toEqual([1, 2, 0])
      const [lane] = await lab.owner`select lane from core.webhook_deliveries
                                      where endpoint_id = ${ep.id} and (payload->>'k')::int = 0`
      expect(lane!.lane).toBe("retry")
    })

    test("every event carries its place in the endpoint's stream", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/seq")
      for (let k = 0; k < 3; k++) await lab.emit(t, { k })
      await until(() => lab.receiver.of("seq").length >= 3, 5_000)
      const seqs = lab.receiver.of("seq").map((r) => JSON.parse(r.body).sequence)
      expect(seqs.sort()).toEqual([1, 2, 3])
      expect(ep.id).toBeTruthy()
    })
  })

  describe("fairness", () => {
    // #278: each workspace gets a quarter of the slots (2 of 8 here), so ten
    // hanging endpoints from one cannot take the slot another one needs.
    test("a quiet workspace is not delayed by a noisy one", async () => {
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

    // #278: Svix stores this and never reads it (40 events in 30ms at a limit
    // of 2). Counted in Redis, so it would hold across replicas too.
    test("a per-endpoint throttle is enforced", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "ok/throttled", { rateLimit: 2 })
      for (let k = 0; k < 6; k++) await lab.emit(t, { k })
      await until(() => lab.receiver.of("throttled").length >= 6, 10_000)
      const perSecond = new Map<number, number>()
      for (const r of lab.receiver.of("throttled")) {
        const s = Math.floor(r.at / 1000)
        perSecond.set(s, (perSecond.get(s) ?? 0) + 1)
      }
      expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(2)
    })

    // #278: after repeated timeouts the endpoint cools instead of holding a
    // slot for every attempt. Without the breaker, the third attempt would
    // come about 5s after the second (timeout penalty); with it, not for 10s.
    test("an endpoint that keeps timing out cools before its next attempt", async () => {
      const t = await lab.workspace()
      await lab.endpoint(t, "hang/cooling")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("cooling").length >= 2, 12_000)
      const second = lab.receiver.of("cooling")[1]!.at
      await until(() => lab.receiver.of("cooling").length >= 3, 15_000)
      const third = lab.receiver.of("cooling")[2]?.at
      expect(third).toBeDefined()
      expect(third! - second).toBeGreaterThanOrEqual(LAB.breaker.coolMs)
    }, 40_000)
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

  describe("history (#280)", () => {
    test("every attempt is logged with what came back, and never the signature", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "flaky/logged?n=2")
      await lab.emit(t, { k: 1 })
      await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        10_000,
      )
      const [row] = await lab.deliveries(ep.id)
      const detail = await history.get(t, row!.id)
      expect(
        detail!.attempt_log.map((a) => [a.attempt, a.response_status, a.response_body]),
      ).toEqual([
        [1, 500, "not yet"],
        [2, 500, "not yet"],
        [3, 200, "ok"],
      ])
      for (const a of detail!.attempt_log) {
        expect(a.request_headers).not.toHaveProperty("webhook-signature")
        expect(a.request_headers["webhook-id"]).toBe(row!.id)
      }
      expect(detail!.attempt_log[0]!.error_kind).toBe("status")
    })

    test("another workspace cannot see a delivery or its attempts", async () => {
      const mine = await lab.workspace()
      const theirs = await lab.workspace()
      const ep = await lab.endpoint(theirs, "ok/private")
      await lab.emit(theirs, { k: 1 })
      await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        5_000,
      )
      const [row] = await lab.deliveries(ep.id)
      expect(await history.get(mine, row!.id)).toBeNull()
      expect(await history.expunge(mine, row!.id)).toBe("not_found")
    })

    test("a payload is expunged only once the delivery has finished", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "hang/expunge")
      await lab.emit(t, { secret: "do not keep" })
      await until(() => lab.receiver.of("expunge").length >= 1, 3_000)
      const [row] = await lab.deliveries(ep.id)
      expect(await history.expunge(t, row!.id)).toBe("pending")

      const done = await lab.workspace()
      const ok = await lab.endpoint(done, "ok/expunge-done")
      await lab.emit(done, { secret: "do not keep" })
      await until(
        async () => (await lab.deliveries(ok.id))[0]?.status === "delivered",
        5_000,
      )
      const [d] = await lab.deliveries(ok.id)
      expect(await history.expunge(done, d!.id)).toBe("expunged")
      const detail = await history.get(done, d!.id)
      expect(detail!.payload).toEqual({})
      expect(detail!.payload_expunged_at).not.toBeNull()
      expect(detail!.attempt_log).toHaveLength(1)
    })

    test("attempts go with their delivery", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/cascade")
      await lab.emit(t, { k: 1 })
      await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        5_000,
      )
      const [row] = await lab.deliveries(ep.id)
      await lab.owner`delete from core.webhook_deliveries where id = ${row!.id}`
      const [left] =
        await lab.owner`select count(*)::int as n from core.webhook_attempts where delivery_id = ${row!.id}`
      expect(left!.n).toBe(0)
    })
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
      const ep = await lab.endpoint(t, "hang/leased")
      await lab.emit(t, { k: 1 })
      await until(() => lab.receiver.of("leased").length >= 1, 3_000)
      const [row] = await lab.deliveries(ep.id)
      // Past the sweep's grace, still inside the attempt's timeout. The sweep
      // is global, so the question is whether THIS row is among what it finds.
      await Bun.sleep(LAB.sweepGraceSeconds * 1000 + 200)
      const due = await dueDeliveries(lab.db, LAB.sweepGraceSeconds, 500)
      expect(due.map((d) => d.id)).not.toContain(row!.id)
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
