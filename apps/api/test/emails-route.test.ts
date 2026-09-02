import { describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app.js"
import type { AcceptOps } from "../src/send/accept.js"
import { unmetered, type Metering } from "../src/send/metering.js"

/**
 * The route, end to end through Hono, with the persistence faked.
 *
 * Authentication is stubbed by injecting an apiKeyAuth that always verifies —
 * `requireApiKey` is covered by its own tests, and what these assert is the
 * mapping from an accept outcome to a status code, which is the part every SDK
 * on the compatibility path reads.
 */

const KEY = "i10_live_abcdefghijklmnopqrstuvwxyz012345"

const body = {
  from: "hello@i10.tech",
  to: "user@example.com",
  subject: "Hi",
  text: "body",
}

function app(over: Partial<AcceptOps> = {}, metering: Metering = unmetered) {
  const enqueue = vi.fn(async () => {})
  const sendPath = {
    persist: vi.fn(async (input: { messages: unknown[] }) => ({
      status: "written" as const,
      ids: input.messages.map((_, i) => `id-${i}`),
      refs: input.messages.map((_, i) => ({ id: `id-${i}`, createdAt: new Date() })),
    })),
    suppressedFor: async () => new Set<string>(),
    enqueue,
    metering,
    log: { warn: vi.fn(), error: vi.fn() },
    ...over,
  } as never

  return {
    app: createApp({
      sendPath,
      apiKeyAuth: {
        verify: async () =>
          ({
            id: "ak_1",
            scopes: ["emails:send"],
            claims: { tenantId: "ten-1", mode: "live" },
            revoked: false,
            expired: false,
          }) as never,
        cache: { get: async () => null, set: async () => {} },
        ttlSeconds: 60,
      },
    }),
    enqueue,
    sendPath,
  }
}

const post = (
  a: ReturnType<typeof createApp>,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
) =>
  a.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      ...headers,
    },
    body: JSON.stringify(payload),
  })

describe("POST /emails", () => {
  it("returns an id synchronously", async () => {
    const { app: a } = app()
    const res = await post(a, "/emails", body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "id-0" })
  })

  it("queues it", async () => {
    const { app: a, enqueue } = app()
    await post(a, "/emails", body)
    // ⚠ transactional, not bulk — a single send is the one somebody is waiting
    // for.
    expect(enqueue).toHaveBeenCalledWith("transactional", expect.anything())
  })

  it("passes the Idempotency-Key through", async () => {
    const { app: a, sendPath } = app()
    await post(a, "/emails", body, { "Idempotency-Key": "k-1" })
    expect(
      (
        sendPath as unknown as {
          persist: { mock: { calls: [{ idempotencyKey: string }][] } }
        }
      ).persist.mock.calls[0]![0].idempotencyKey,
    ).toBe("k-1")
  })

  // ⚠ 200 with the ORIGINAL id. The caller cannot tell whether their first
  // attempt landed; the id they would have got the first time is the answer
  // that lets them stop worrying.
  it("replays as a 200 with the first id", async () => {
    const { app: a, enqueue } = app({
      persist: async () => ({ status: "replayed", ids: ["id-original"] }),
    } as never)

    const res = await post(a, "/emails", body, { "Idempotency-Key": "k-1" })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "id-original" })
    expect(enqueue).not.toHaveBeenCalled()
  })

  // ⚠ 409, not 422. An SDK retries neither, but a 422 says "fix your body" when
  // the body is fine and the key is the problem.
  it("answers 409 for a reused key with a different body", async () => {
    const { app: a } = app({ persist: async () => ({ status: "conflict" }) } as never)
    const res = await post(a, "/emails", body, { "Idempotency-Key": "k-1" })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ name: "idempotency_conflict" })
  })

  // ⚠ 429 with daily_quota_exceeded, which is what makes an SDK back off — and
  // the name is what distinguishes it from a rate limit, which is retryable.
  it("answers 429 when over quota", async () => {
    const { app: a } = app(
      {},
      {
        checkQuota: async () => ({ status: "exceeded", message: "no credits" }),
        recordSent: async () => {},
      },
    )
    const res = await post(a, "/emails", body)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({
      name: "daily_quota_exceeded",
      message: "no credits",
    })
  })

  it("still validates the body", async () => {
    const { app: a } = app()
    const res = await post(a, "/emails", { from: "x@i10.tech" })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ name: "validation_error" })
  })

  it("still requires a key", async () => {
    const { app: a } = app()
    const res = await a.request("/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(401)
  })
})

describe("POST /emails/batch", () => {
  it("returns one id per element, in submission order", async () => {
    const { app: a } = app()
    const res = await post(a, "/emails/batch", [body, body, body])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [{ id: "id-0" }, { id: "id-1" }, { id: "id-2" }],
    })
  })

  // ⚠ A different queue from /emails, which is the whole reason the two classes
  // exist: a thousand-message batch must not queue in front of a reset.
  it("routes to the bulk queue", async () => {
    const { app: a, enqueue } = app()
    await post(a, "/emails/batch", [body])
    expect(enqueue).toHaveBeenCalledWith("bulk", expect.anything())
  })
})

describe("when the send path is not configured", () => {
  // ⚠ Never a silent success. Returning an id would tell callers their mail was
  // accepted while nothing existed to send it.
  it("answers 501 rather than inventing an id", async () => {
    const unconfigured = createApp({
      apiKeyAuth: {
        verify: async () =>
          ({
            id: "ak_1",
            scopes: [],
            claims: { tenantId: "ten-1", mode: "live" },
            revoked: false,
            expired: false,
          }) as never,
        cache: { get: async () => null, set: async () => {} },
        ttlSeconds: 60,
      },
    })
    const res = await post(unconfigured, "/emails", body)
    expect(res.status).toBe(501)
  })
})
