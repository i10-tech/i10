import { describe, expect, it, vi } from "vitest"
import { I10 } from "../src/client.js"
import { I10Error } from "../src/error.js"

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

describe("I10", () => {
  it("requires an API key", () => {
    expect(() => new I10("")).toThrow(/API key is required/)
  })

  it("sends Authorization: Bearer, not a custom header", async () => {
    const fetch = vi.fn(async () => ok({ id: crypto.randomUUID() }))
    const i10 = new I10("i10_live_test", { fetch: fetch as never })

    await i10.emails.send({
      from: "hi@customer.com",
      to: "someone@example.com",
      subject: "hello",
      text: "hi",
    })

    const [, init] = fetch.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer i10_live_test",
    })
  })

  it("only sends Idempotency-Key when one is given", async () => {
    const fetch = vi.fn(async () => ok({ id: crypto.randomUUID() }))
    const i10 = new I10("i10_live_test", { fetch: fetch as never })
    const email = {
      from: "hi@customer.com",
      to: "someone@example.com",
      subject: "hello",
      text: "hi",
    }

    await i10.emails.send(email)
    await i10.emails.send(email, { idempotencyKey: "reset-42" })

    const first = (fetch.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >
    const second = (fetch.mock.calls[1]![1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(first["Idempotency-Key"]).toBeUndefined()
    expect(second["Idempotency-Key"]).toBe("reset-42")
  })

  it("marks a quota error non-retryable and a rate limit retryable", async () => {
    const fail = (name: string, statusCode: number) =>
      vi.fn(
        async () =>
          new Response(JSON.stringify({ statusCode, name, message: name }), {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          }),
      )

    const email = {
      from: "hi@customer.com",
      to: "someone@example.com",
      subject: "hello",
      text: "hi",
    }

    const quota = new I10("k", { fetch: fail("daily_quota_exceeded", 429) as never })
    await expect(quota.emails.send(email)).rejects.toSatisfy(
      (e: I10Error) => e.retryable === false,
    )

    const rate = new I10("k", { fetch: fail("rate_limit_exceeded", 429) as never })
    await expect(rate.emails.send(email)).rejects.toSatisfy(
      (e: I10Error) => e.retryable === true,
    )
  })

  it("throws an I10Error when the body is not JSON", async () => {
    const fetch = vi.fn(async () => new Response("<html>502</html>", { status: 502 }))
    const i10 = new I10("k", { fetch: fetch as never })

    await expect(
      i10.emails.send({
        from: "hi@customer.com",
        to: "someone@example.com",
        subject: "hello",
        text: "hi",
      }),
    ).rejects.toBeInstanceOf(I10Error)
  })
})
