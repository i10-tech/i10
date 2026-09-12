import { describe, expect, it, mock } from "bun:test"
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
    const fetch = mock(async () => ok({ id: crypto.randomUUID() }))
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
    const fetch = mock(async () => ok({ id: crypto.randomUUID() }))
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
      mock(
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

    // ⚠ CAUGHT BY HAND RATHER THAN `.rejects.toSatisfy(…)`. bun's `rejects`
    // does not unwrap for `toSatisfy`: the matcher receives the pending
    // promise, the predicate is never called, and the assertion fails on a
    // shape nobody wrote. Catching the error makes what is being asserted —
    // the `retryable` flag on a 429 — the visible thing anyway.
    const thrownBy = async (name: string) => {
      const i10 = new I10("k", { fetch: fail(name, 429) as never })
      try {
        await i10.emails.send(email)
      } catch (error) {
        return error as I10Error
      }
      throw new Error(`${name} did not reject`)
    }

    expect((await thrownBy("daily_quota_exceeded")).retryable).toBe(false)
    expect((await thrownBy("rate_limit_exceeded")).retryable).toBe(true)
  })

  it("throws an I10Error when the body is not JSON", async () => {
    const fetch = mock(async () => new Response("<html>502</html>", { status: 502 }))
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
