import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { webhookPayloadSchema } from "@repo/contracts"
import { dueDeliveries } from "../../src/webhooks/db.js"
import type { WebhookEventType } from "../../src/webhooks/events.js"
import {
  fanOutAndEnqueue,
  runHealthEmails,
  type HealthSummary,
} from "../../src/webhooks/health.js"
import { statsWindow } from "../../src/webhooks/stats.js"
import { webhookHistory, type WebhookHistory } from "../../src/webhooks/history.js"
import { sendTestEvent } from "../../src/webhooks/test-events.js"
import { createReplay, getReplay, resendDelivery } from "../../src/webhooks/replay.js"
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
    history = webhookHistory(lab.db, {
      onHealthChange: (t, id) =>
        fanOutAndEnqueue(lab.db, lab.engine.queue, { warn: () => {} })(t, id),
    })
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

  describe("endpoint options (#281)", () => {
    test("custom headers arrive, and a reserved one is refused on write", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/custom-headers")
      const ok = await lab.store.update(t, ep.id, {
        headers: { "X-Gateway-Token": "abc" },
      })
      expect(ok.status).toBe("updated")
      if (ok.status === "updated") {
        expect(ok.endpoint.header_names).toEqual(["x-gateway-token"])
        expect(JSON.stringify(ok.endpoint)).not.toContain("abc")
      }
      const bad = await lab.store.update(t, ep.id, {
        headers: { "webhook-signature": "forged" },
      })
      expect(bad.status).toBe("rejected")
      await lab.emit(t, { k: 1 })
      const got = await until(() => lab.receiver.of("custom-headers")[0], 5_000)
      expect(got!.headers["x-gateway-token"]).toBe("abc")
      expect(got!.headers["webhook-signature"]).toMatch(/^v1,/)
    })

    test("a domain filter and a tag filter narrow what an endpoint receives", async () => {
      const t = await lab.workspace()
      const byDomain = await lab.endpoint(t, "ok/f-domain")
      const byTag = await lab.endpoint(t, "ok/f-tag")
      await lab.store.update(t, byDomain.id, { filter_domains: ["Mail.Acme.test"] })
      await lab.store.update(t, byTag.id, { filter_tags: { category: "receipt" } })
      await lab.emit(t, {
        k: "acme-receipt",
        from: "A <a@mail.acme.test>",
        tags: { category: "receipt" },
      })
      await lab.emit(t, {
        k: "other-receipt",
        from: "b@other.test",
        tags: { category: "receipt" },
      })
      await lab.emit(t, {
        k: "acme-promo",
        from: "a@mail.acme.test",
        tags: { category: "promo" },
      })
      await Bun.sleep(1_500)
      expect(
        lab.receiver
          .of("f-domain")
          .map((r) => r.data.k)
          .sort(),
      ).toEqual(["acme-promo", "acme-receipt"])
      expect(
        lab.receiver
          .of("f-tag")
          .map((r) => r.data.k)
          .sort(),
      ).toEqual(["acme-receipt", "other-receipt"])
    })

    test("a paused endpoint receives nothing until it is resumed", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/paused")
      await lab.store.update(t, ep.id, { enabled: false })
      await lab.emit(t, { k: "while-paused" })
      await lab.store.update(t, ep.id, { enabled: true })
      await lab.emit(t, { k: "after" })
      await until(() => lab.receiver.of("paused").length >= 1, 5_000)
      await Bun.sleep(300)
      expect(lab.receiver.of("paused").map((r) => r.data.k)).toEqual(["after"])
    })

    test("a new URL gets the same SSRF checks as a new endpoint", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/move")
      for (const url of [
        "http://hooks.example.com/x",
        "https://10.0.0.1/x",
        "https://intranet/x",
      ]) {
        expect((await lab.store.update(t, ep.id, { url })).status).toBe("rejected")
      }
    })

    test("a test event is a real, signed delivery marked as a test", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/test-event")
      const r = await sendTestEvent(lab.db, lab.engine.queue, t, ep.id, "email.bounced")
      expect(r.status).toBe("queued")
      const got = await until(() => lab.receiver.of("test-event")[0], 5_000)
      const body = JSON.parse(got!.body)
      expect(body).toMatchObject({
        type: "email.bounced",
        data: { test: true, bounce: { type: "permanent" } },
      })
      expect(body).not.toHaveProperty("sequence")
      expect(
        verifySignature(
          ep.secret,
          got!.headers["webhook-id"]!,
          got!.body,
          got!.headers["webhook-signature"]!,
          got!.headers["webhook-timestamp"]!,
        ),
      ).toBe(true)
      if (r.status === "queued") {
        await until(
          async () => (await history.get(t, r.deliveryId))?.status === "delivered",
          3_000,
        )
        const detail = await history.get(t, r.deliveryId)
        expect(detail!.attempt_log[0]!.trigger).toBe("test")
      }
      await lab.store.update(t, ep.id, { enabled: false })
      expect(
        (await sendTestEvent(lab.db, lab.engine.queue, t, ep.id, "email.sent")).status,
      ).toBe("paused")
    })

    test("deliveries list newest first, filter, and page without repeats", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/listing")
      for (let k = 0; k < 7; k++) await lab.emit(t, { k })
      await until(
        async () =>
          (await lab.deliveries(ep.id)).every((d) => d.status === "delivered"),
        5_000,
      )
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = await history.list(t, {
          endpointId: ep.id,
          limit: 3,
          ...(cursor ? { cursor } : {}),
        })
        seen.push(...page.data.map((d) => d.id))
        cursor = page.next_cursor ?? undefined
      } while (cursor)
      expect(seen).toHaveLength(7)
      expect(new Set(seen).size).toBe(7)
      expect(
        (await history.list(t, { endpointId: ep.id, status: "failed" })).data,
      ).toHaveLength(0)
    })

    test("stats count a window", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "flaky/stats?n=1", {
        events: ["email.delivered"],
      })
      for (let k = 0; k < 3; k++) await lab.emit(t, { k })
      await until(
        async () =>
          (await lab.deliveries(ep.id)).every((d) => d.status === "delivered"),
        15_000,
      )
      const window = statsWindow({ since: new Date(Date.now() - 2 * 3_600_000) })
      if ("error" in window) throw new Error(window.error)
      const s = await lab.store.stats(t, ep.id, window)
      expect(s).toMatchObject({
        delivered: 3,
        failed: 0,
        pending: 0,
        success_rate: 1,
        failing_since: null,
        bucket: "hour",
        // Each delivery failed once, then succeeded: a perfect delivery rate
        // and a 50% error rate, which is the number that says trouble.
        attempts: 6,
        failed_attempts: 3,
      })
      expect(s!.p50_ms).not.toBeNull()
      // Every hour in the window, empty ones included, and the counts in them.
      expect(s!.series.length).toBeGreaterThanOrEqual(2)
      expect(s!.series.reduce((n, b) => n + b.attempts, 0)).toBe(6)
      expect(s!.series.reduce((n, b) => n + b.delivered, 0)).toBe(3)
      expect(s!.by_event_type).toEqual([
        { event_type: "email.delivered", delivered: 3, failed: 0, pending: 0 },
      ])

      // Workspace-wide: the same endpoint, plus one that only ever failed.
      const dead = await lab.endpoint(t, "fail/stats-dead", { events: ["email.sent"] })
      await lab.emit(t, { k: "x" }, { type: "email.sent" })
      await until(
        async () =>
          (
            await lab.owner`select count(*)::int as n from core.webhook_attempts
                            where endpoint_id = ${dead.id}`
          )[0]!.n >= 2,
        8_000,
      )
      const w = await lab.store.workspaceStats(t, {
        ...window,
        until: new Date(),
      })
      const rows = new Map(w.by_endpoint.map((r) => [r.endpoint_id, r]))
      expect(rows.get(ep.id)).toMatchObject({
        delivered: 3,
        attempts: 6,
        success_rate: 1,
      })
      expect(rows.get(dead.id)!.failed_attempts).toBe(rows.get(dead.id)!.attempts)
      expect(w.by_event_type.map((e) => e.event_type).sort()).toEqual([
        "email.delivered",
        "email.sent",
      ])

      // Another workspace's traffic is not counted.
      const other = await lab.workspace()
      expect(
        (await lab.store.workspaceStats(other, { ...window, until: new Date() }))
          .attempts,
      ).toBe(0)
    })
  })

  describe("replay (#282)", () => {
    const window = () => ({ since: new Date(Date.now() - 60 * 60_000) })
    const finished = (t: string, id: string) =>
      until(async () => {
        const r = await getReplay(lab.db, t, id)
        return r && (r.status === "done" || r.status === "failed") ? r : undefined
      }, 15_000)

    test("resend sends one finished delivery again, once, under the same id", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/resend")
      await lab.emit(t, { k: 1 })
      await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "delivered",
        5_000,
      )
      const [row] = await lab.deliveries(ep.id)
      const r = await resendDelivery(lab.db, lab.engine.queue, t, row!.id)
      expect(r.status).toBe("queued")
      await until(() => lab.receiver.of("resend").length >= 2, 5_000)
      const ids = lab.receiver.of("resend").map((x) => x.headers["webhook-id"])
      expect(ids).toEqual([row!.id, row!.id])
      const detail = await history.get(t, row!.id)
      expect(detail!.attempt_log.map((a) => a.trigger)).toEqual(["scheduled", "manual"])
    })

    test("resend refuses a delivery that is still being attempted", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "hang/resend-pending")
      await lab.emit(t, { k: 1 })
      const [row] = await lab.deliveries(ep.id)
      expect((await resendDelivery(lab.db, lab.engine.queue, t, row!.id)).status).toBe(
        "pending",
      )
    })

    test("replaying failures only resends the failed ones, one attempt each", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "failk/rf?k=0&n=5")
      for (let k = 0; k < 3; k++) await lab.emit(t, { k })
      // k=0 fails its whole budget (5 attempts here); 1 and 2 are delivered.
      await until(
        async () => (await lab.deliveries(ep.id)).every((d) => d.status !== "pending"),
        30_000,
      )
      // The exhausted head switched the endpoint off (no success for the
      // lab's stretch); the customer fixes their receiver and turns it back on.
      await lab.store.update(t, ep.id, { enabled: true })
      const before = lab.receiver.of("rf").length
      const r = await createReplay(lab.db, t, ep.id, "replay", {
        ...window(),
        statuses: ["failed"],
      })
      if (r.status !== "created") throw new Error(r.status)
      const done = await finished(t, r.replay.id)
      expect(done).toMatchObject({ status: "done", queued: 1, examined: 1 })
      await until(() => lab.receiver.of("rf").length > before, 5_000)
      await Bun.sleep(500)
      const resent = lab.receiver.of("rf").slice(before)
      expect(resent.map((x) => x.data.k)).toEqual([0])
      // k=0 now gets through (n=5 failures are spent), on the recover trigger.
      const failed = (await lab.deliveries(ep.id)).find((d) => d.attempts > 1)!
      const detail = await history.get(t, failed.id)
      expect(detail!.status).toBe("delivered")
      expect(detail!.attempt_log.at(-1)!.trigger).toBe("recover")
    }, 60_000)

    test("a replay that fails is one attempt and does not count against the endpoint", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "fail/rfail")
      await lab.store.update(t, ep.id, { enabled: true })
      await lab.emit(t, { k: 1 })
      await until(
        async () => (await lab.deliveries(ep.id))[0]?.status === "failed",
        30_000,
      )
      await lab.owner`update core.webhook_endpoints set failing_since = null, enabled = true where id = ${ep.id}`
      const before = lab.receiver.of("rfail").length
      const r = await createReplay(lab.db, t, ep.id, "replay", {
        ...window(),
        statuses: ["failed"],
      })
      if (r.status !== "created") throw new Error(r.status)
      await finished(t, r.replay.id)
      await until(() => lab.receiver.of("rfail").length > before, 5_000)
      await Bun.sleep(3_000)
      expect(lab.receiver.of("rfail").length - before).toBe(1)
      const [e] =
        await lab.owner`select failing_since from core.webhook_endpoints where id = ${ep.id}`
      expect(e!.failing_since).toBeNull()
    }, 60_000)

    test("replay-missing sends what an endpoint created later never got", async () => {
      const t = await lab.workspace()
      await lab.emit(t, { k: "early" }, { type: "email.delivered" })
      await lab.emit(t, { k: "early" }, { type: "email.bounced" })
      const ep = await lab.endpoint(t, "ok/missing", { events: ["email.delivered"] })
      const r = await createReplay(lab.db, t, ep.id, "replay_missing", window())
      if (r.status !== "created") throw new Error(r.status)
      const done = await finished(t, r.replay.id)
      expect(done).toMatchObject({ status: "done", queued: 1 })
      const got = await until(() => lab.receiver.of("missing")[0], 5_000)
      expect(JSON.parse(got!.body)).toMatchObject({
        type: "email.delivered",
        data: { email_id: expect.any(String) },
      })
      // Running it again finds nothing: it has a delivery now.
      const again = await createReplay(lab.db, t, ep.id, "replay_missing", window())
      if (again.status !== "created") throw new Error(again.status)
      expect(await finished(t, again.replay.id)).toMatchObject({
        status: "done",
        queued: 0,
      })
    })

    test("a replay resumes from its cursor after the worker restarts", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/resume")
      for (let k = 0; k < 150; k++) await lab.emit(t, { k }, { enqueue: false })
      await lab.owner`update core.webhook_deliveries set status = 'failed', next_attempt_at = null where endpoint_id = ${ep.id}`
      const r = await createReplay(lab.db, t, ep.id, "replay", {
        ...window(),
        statuses: ["failed"],
      })
      if (r.status !== "created") throw new Error(r.status)
      // Wait for the first batch, then restart the engine mid-replay.
      await until(
        async () => ((await getReplay(lab.db, t, r.replay.id))?.queued ?? 0) >= 100,
        10_000,
      )
      await lab.restart(0)
      const done = await finished(t, r.replay.id)
      expect(done).toMatchObject({ status: "done", queued: 150, examined: 150 })
      await until(() => lab.receiver.of("resume").length >= 150, 20_000)
      const ks = new Set(lab.receiver.of("resume").map((x) => x.data.k))
      expect(ks.size).toBe(150)
    }, 60_000)

    test("a replay to a switched-off endpoint is refused, not silently wasted", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/off")
      await lab.store.update(t, ep.id, { enabled: false })
      expect((await createReplay(lab.db, t, ep.id, "replay", window())).status).toBe(
        "paused",
      )
    })

    test("a window is refused when it is backwards or too wide", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/window")
      const now = Date.now()
      expect(
        (
          await createReplay(lab.db, t, ep.id, "replay", {
            since: new Date(now),
            until: new Date(now - 1),
          })
        ).status,
      ).toBe("rejected")
      expect(
        (
          await createReplay(lab.db, t, ep.id, "replay", {
            since: new Date(now - 40 * 86_400_000),
          })
        ).status,
      ).toBe("rejected")
    })
  })

  describe("health notifications (#284)", () => {
    const OPS: WebhookEventType[] = [
      "webhook_endpoint.failing",
      "webhook_endpoint.disabled",
      "webhook_endpoint.recovered",
    ]
    const changes = async (endpointId: string) =>
      (
        await lab.owner`select kind from core.webhook_health_events
                         where endpoint_id = ${endpointId} order by occurred_at, id`
      ).map((r) => r.kind as string)
    const healthOf = async (endpointId: string) =>
      (
        await lab.owner`select health from core.webhook_endpoints where id = ${endpointId}`
      )[0]!.health as string

    test("a dead endpoint is reported failing once, then disabled once, however many deliveries fail", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "fail/h-dead")
      for (let k = 0; k < 6; k++) await lab.emit(t, { k })
      expect(
        await until(async () => (await changes(ep.id)).includes("failing"), 8_000),
      ).toBe(true)
      expect(await healthOf(ep.id)).toBe("failing")
      expect(
        await until(async () => (await changes(ep.id)).includes("disabled"), 20_000),
      ).toBe(true)
      await Bun.sleep(500)
      expect(await changes(ep.id)).toEqual(["failing", "disabled"])
      expect(await healthOf(ep.id)).toBe("disabled")
    })

    test("a recovery is reported once, and only after a failure was", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "flaky/h-flaky?n=2")
      await lab.emit(t, { k: 1 })
      expect(
        await until(async () => (await changes(ep.id)).includes("recovered"), 10_000),
      ).toBe(true)
      expect(await changes(ep.id)).toEqual(["failing", "recovered"])
      expect(await healthOf(ep.id)).toBe("healthy")

      // Healthy and succeeding: nothing more to say.
      await lab.emit(t, { k: 2 })
      await until(() => lab.receiver.of("h-flaky").some((r) => r.data.k === 2), 5_000)
      await Bun.sleep(300)
      expect(await changes(ep.id)).toEqual(["failing", "recovered"])
    })

    test("410 disables at once, without a failing first", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "gone/h-gone")
      await lab.emit(t, { k: 1 })
      await lab.emit(t, { k: 2 })
      expect(await until(async () => (await changes(ep.id)).length > 0, 5_000)).toBe(
        true,
      )
      await Bun.sleep(500)
      expect(await changes(ep.id)).toEqual(["disabled"])
      const [row] = await lab.owner`select reason from core.webhook_health_events
                                    where endpoint_id = ${ep.id}`
      expect(row!.reason).toContain("410")
    })

    test("the change goes as a strict webhook to the other endpoints subscribed, never to the one it is about", async () => {
      const t = await lab.workspace()
      const dead = await lab.endpoint(t, "gone/h-self", {
        events: ["email.delivered", ...OPS],
      })
      const ops = await lab.endpoint(t, "ok/h-ops", { events: OPS })
      // A mail filter on the ops endpoint must not hide a change from it.
      await lab.owner`update core.webhook_endpoints set filter_domains = ${["nowhere.test"]}
                      where id = ${ops.id}`
      await lab.emit(t, { k: 1 })

      const got = await until(() => lab.receiver.of("h-ops")[0], 8_000)
      expect(got).toBeDefined()
      const body = JSON.parse(got!.body) as Record<string, unknown>
      expect(body.type).toBe("webhook_endpoint.disabled")
      expect(
        webhookPayloadSchema("webhook_endpoint.disabled").safeParse(body).success,
      ).toBe(true)
      expect(got!.data).toMatchObject({ endpoint_id: dead.id, url: dead.url })
      expect(typeof got!.headers["webhook-signature"]).toBe("string")

      await Bun.sleep(500)
      expect(
        lab.receiver.of("h-self").map((r) => JSON.parse(r.body).type as string),
      ).toEqual(["email.delivered"])
      const [fanned] =
        await lab.owner`select fanned_out_at from core.webhook_health_events
                                       where endpoint_id = ${dead.id}`
      expect(fanned!.fanned_out_at).not.toBeNull()
    })

    test("a resumed endpoint comes back failing, and its next success is the recovery", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "gone/h-resume")
      await lab.emit(t, { k: 1 })
      expect(
        await until(async () => (await healthOf(ep.id)) === "disabled", 5_000),
      ).toBe(true)
      // The customer fixes their receiver, then switches it back on.
      await lab.owner`update core.webhook_endpoints
                      set url = ${ep.url.replace("/gone/", "/ok/")} where id = ${ep.id}`
      const resumed = await lab.store.update(t, ep.id, { enabled: true })
      expect(resumed.status === "updated" && resumed.endpoint.health).toBe("failing")

      await lab.emit(t, { k: 2 })
      expect(
        await until(async () => (await changes(ep.id)).includes("recovered"), 5_000),
      ).toBe(true)
      expect(await changes(ep.id)).toEqual(["disabled", "recovered"])
      expect(await healthOf(ep.id)).toBe("healthy")
    })

    test("a customer's own pause is not a health change", async () => {
      const t = await lab.workspace()
      const ep = await lab.endpoint(t, "ok/h-pause")
      await lab.store.update(t, ep.id, { enabled: false })
      await lab.store.update(t, ep.id, { enabled: true })
      expect(await changes(ep.id)).toEqual([])
      expect(await healthOf(ep.id)).toBe("healthy")
    })

    test("a change the worker never fanned out is fanned out by the tick", async () => {
      const t = await lab.workspace()
      const quiet = await lab.endpoint(t, "ok/h-quiet", { events: ["email.sent"] })
      await lab.endpoint(t, "ok/h-late", { events: OPS })
      // As a worker that stopped right after committing the change leaves it.
      await lab.owner`insert into core.webhook_health_events
                        (tenant_id, endpoint_id, kind, url, reason, failing_since, occurred_at)
                      values (${t}, ${quiet.id}, 'failing', ${quiet.url}, 'HTTP 500',
                              now() - interval '20 minutes', now() - interval '1 minute')`
      const got = await until(() => lab.receiver.of("h-late")[0], 5_000)
      expect(got).toBeDefined()
      expect(JSON.parse(got!.body).type).toBe("webhook_endpoint.failing")
    })

    describe("email", () => {
      const seed = (t: string, endpointId: string, kind: string, ago: string) =>
        lab.owner`insert into core.webhook_health_events
                    (tenant_id, endpoint_id, kind, url, occurred_at, fanned_out_at)
                  values (${t}, ${endpointId}, ${kind}::core.webhook_health_change,
                          'https://example.com/hook', now() - ${ago}::interval, now())`
      const run = async (t: string) => {
        const calls: HealthSummary[] = []
        await runHealthEmails({
          db: lab.db,
          notify: async (tenantId, summary) => {
            if (tenantId === t) calls.push(summary)
          },
        })
        return calls
      }

      test("two replicas at once send one email, and it covers every change", async () => {
        const t = await lab.workspace()
        const a = await lab.endpoint(t, "ok/h-mail-a")
        const b = await lab.endpoint(t, "ok/h-mail-b")
        await seed(t, a.id, "failing", "2 minutes")
        await seed(t, b.id, "disabled", "1 minute")
        const [one, two] = await Promise.all([run(t), run(t)])
        expect(one!.length + two!.length).toBe(1)
        const summary = [...one!, ...two!][0]!
        expect(summary.worst).toBe("disabled")
        expect(summary.lines.map((l) => l.state)).toEqual(["disabled", "failing"])
        const [left] =
          await lab.owner`select count(*)::int as n from core.webhook_health_events
                                       where tenant_id = ${t} and emailed_at is null`
        expect(left!.n).toBe(0)
        expect(await run(t)).toEqual([])
      })

      test("a failure that recovered before anyone was told is not sent, and does not hold back the next", async () => {
        const t = await lab.workspace()
        const a = await lab.endpoint(t, "ok/h-blip")
        await seed(t, a.id, "failing", "3 minutes")
        await seed(t, a.id, "recovered", "2 minutes")
        expect(await run(t)).toEqual([])
        const [row] = await lab.owner`select bool_and(email_suppressed) as s
                                      from core.webhook_health_events where tenant_id = ${t}`
        expect(row!.s).toBe(true)

        await seed(t, a.id, "failing", "1 minute")
        expect((await run(t)).map((s) => s.worst)).toEqual(["failing"])
      })

      test("within half an hour of the last email, changes wait, unless an endpoint was switched off", async () => {
        const t = await lab.workspace()
        const a = await lab.endpoint(t, "ok/h-wait-a")
        const b = await lab.endpoint(t, "ok/h-wait-b")
        await seed(t, a.id, "failing", "5 minutes")
        expect(await run(t)).toHaveLength(1)

        await seed(t, b.id, "failing", "1 minute")
        expect(await run(t)).toEqual([])

        await seed(t, a.id, "disabled", "0 minutes")
        const [sent] = await run(t)
        expect(sent!.worst).toBe("disabled")
        // The change that waited goes in the same email.
        expect(sent!.lines.map((l) => l.state).sort()).toEqual(["disabled", "failing"])
      })
    })
  })

  describe("polling endpoints (#301)", () => {
    const poller = async (t: string, events?: WebhookEventType[]) => {
      const r = await lab.store.create(t, {
        kind: "polling",
        events: events ?? ["email.delivered"],
      })
      if (r.status !== "created") throw new Error(JSON.stringify(r))
      expect(r.endpoint.secret).toBeNull()
      expect(r.endpoint.url).toBeNull()
      return r.endpoint.id
    }
    const pollOk = async (
      t: string,
      id: string,
      input: { cursor?: number; limit?: number } = {},
    ) => {
      const r = await history.poll(t, id, input)
      if (r.status !== "ok") throw new Error(JSON.stringify(r))
      return r
    }
    const statuses = async (id: string) =>
      (
        await lab.owner`select status from core.webhook_deliveries
                         where endpoint_id = ${id} order by sequence`
      ).map((r) => r.status as string)

    test("is never sent to, and its events are pulled in order, acknowledged by the cursor", async () => {
      const t = await lab.workspace()
      const id = await poller(t)
      for (let k = 1; k <= 3; k++) await lab.emit(t, { k })
      await Bun.sleep(1_000)
      const [attempts] =
        await lab.owner`select count(*)::int as n from core.webhook_attempts
                                         where endpoint_id = ${id}`
      expect(attempts!.n).toBe(0)
      expect(
        (await dueDeliveries(lab.db, 0, 500)).filter((d) => d.endpointId === id),
      ).toEqual([])

      const first = await pollOk(t, id)
      expect(first.data.map((e) => [e.sequence, e.data.k])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
      ])
      expect(first.data[0]!.type).toBe("email.delivered")
      expect(first).toMatchObject({ next_cursor: "3", done: true })
      // Read, not acknowledged: still waiting.
      expect(await statuses(id)).toEqual(["pending", "pending", "pending"])

      expect((await pollOk(t, id, { cursor: 3 })).data).toEqual([])
      expect(await statuses(id)).toEqual(["delivered", "delivered", "delivered"])
      // Without a cursor it resumes after the last acknowledged.
      expect((await pollOk(t, id)).data).toEqual([])
      // An older cursor reads them again.
      expect((await pollOk(t, id, { cursor: 0 })).data).toHaveLength(3)
      const [row] =
        await lab.owner`select poll_cursor, last_polled_at from core.webhook_endpoints
                                    where id = ${id}`
      expect(Number(row!.poll_cursor)).toBe(3)
      expect(row!.last_polled_at).not.toBeNull()
    })

    test("pages, and acknowledges only what was passed back", async () => {
      const t = await lab.workspace()
      const id = await poller(t)
      for (let k = 1; k <= 5; k++) await lab.emit(t, { k })
      const a = await pollOk(t, id, { limit: 2 })
      expect(a.data.map((e) => e.sequence)).toEqual([1, 2])
      expect(a.done).toBe(false)
      const b = await pollOk(t, id, { cursor: Number(a.next_cursor), limit: 2 })
      expect(b.data.map((e) => e.sequence)).toEqual([3, 4])
      expect(await statuses(id)).toEqual([
        "delivered",
        "delivered",
        "pending",
        "pending",
        "pending",
      ])
    })

    test("refuses what it should", async () => {
      const t = await lab.workspace()
      const id = await poller(t)
      const http = await lab.endpoint(t, "ok/poll-http")
      await lab.emit(t, { k: 1 })
      expect(await history.poll(t, id, { cursor: 99 })).toMatchObject({
        status: "rejected",
      })
      expect((await history.poll(t, http.id, {})).status).toBe("not_polling")
      expect((await history.poll(await lab.workspace(), id, {})).status).toBe(
        "not_found",
      )
      // Nothing to send to, so nothing to rotate, point elsewhere, or replay.
      expect(
        (await lab.store.rotateSecret(t, id, { revoke: true } as never)).status,
      ).toBe("rejected")
      expect((await lab.store.update(t, id, { rate_limit: 5 })).status).toBe("rejected")
      expect(
        (await createReplay(lab.db, t, id, "replay", { since: new Date(0) })).status,
      ).toBe("rejected")
      const [d] =
        await lab.owner`select id from core.webhook_deliveries where endpoint_id = ${id}`
      await pollOk(t, id, { cursor: 1 })
      expect(
        (await resendDelivery(lab.db, lab.engine.queue, t, d!.id as string)).status,
      ).toBe("polling")
      // Paused, it is not polled.
      await lab.store.update(t, id, { enabled: false })
      expect((await history.poll(t, id, {})).status).toBe("paused")
    })

    test("a test event is part of its stream", async () => {
      const t = await lab.workspace()
      const id = await poller(t)
      await lab.emit(t, { k: 1 })
      expect(
        (await sendTestEvent(lab.db, lab.engine.queue, t, id, "email.bounced")).status,
      ).toBe("queued")
      const page = await pollOk(t, id)
      expect(page.data.map((e) => [e.sequence, e.type])).toEqual([
        [1, "email.delivered"],
        [2, "email.bounced"],
      ])
      expect(page.data[1]!.data.test).toBe(true)
    })

    test("one that stops collecting is reported failing, then disabled; polling again recovers it", async () => {
      const t = await lab.workspace()
      const id = await poller(t)
      // A poller can collect the health of the workspace's other endpoints too.
      const watcher = await poller(t, [
        "webhook_endpoint.failing",
        "webhook_endpoint.disabled",
        "webhook_endpoint.recovered",
      ])
      await lab.emit(t, { k: 1 })
      // The watcher keeps polling, as an operational poller would; one that
      // stopped would be judged like any other.
      const keepWatching = setInterval(() => void history.poll(t, watcher, {}), 200)
      const kinds = async () =>
        (
          await lab.owner`select kind from core.webhook_health_events
                           where endpoint_id = ${id} order by occurred_at, id`
        ).map((r) => r.kind as string)
      expect(
        await until(async () => (await kinds()).includes("disabled"), 10_000),
      ).toBe(true)
      expect(await kinds()).toEqual(["failing", "disabled"])
      const [off] = await lab.owner`select disabled_reason from core.webhook_endpoints
                                    where id = ${id}`
      expect(off!.disabled_reason).toContain("Not polled")

      await lab.store.update(t, id, { enabled: true })
      await pollOk(t, id, { cursor: 1 })
      expect(await kinds()).toEqual(["failing", "disabled", "recovered"])

      // The watcher collects all three as webhook_endpoint.* events.
      const seen = await until(async () => {
        const page = await pollOk(t, watcher, { cursor: 0 })
        return page.data.length >= 3 ? page.data : undefined
      }, 5_000)
      expect(seen!.map((e) => e.type)).toEqual([
        "webhook_endpoint.failing",
        "webhook_endpoint.disabled",
        "webhook_endpoint.recovered",
      ])
      clearInterval(keepWatching)
      expect(seen![0]!.data).toMatchObject({ endpoint_id: id, url: null })
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
