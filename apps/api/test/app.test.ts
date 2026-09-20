import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"

const app = createApp()

describe("api", () => {
  it("answers /healthz", async () => {
    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it("refuses a send with no Authorization header", async () => {
    const res = await app.request("/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "hi@customer.com",
        to: "someone@example.com",
        subject: "hello",
        text: "hi",
      }),
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ name: "invalid_access" })
  })

  it("returns 404 in the API's error shape, not Hono's default text", async () => {
    const res = await app.request("/nope")
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ name: "not_found" })
  })
})

/**
 * ⚠ A THROW INSIDE A ROUTE DOES NOT CRASH THE PROCESS, so nothing in the SDK
 * sees it on its own — no uncaught-exception handler fires and, with tracing
 * off, there is no HTTP instrumentation either. This hook is the entire path
 * from a failed request to an alert.
 */
describe("an unhandled route error", () => {
  const authed = { Authorization: "Bearer a-metrics-token-long-enough" }
  const throwing = (
    reportError?: (e: unknown, c?: Record<string, unknown>) => void,
    logError?: (e: unknown, c: Record<string, unknown>) => void,
  ) =>
    createApp({
      metrics: {
        token: "a-metrics-token-long-enough",
        queueDepth: () => Promise.reject(new Error("redis is gone")),
      },
      reportError,
      logError,
    })

  it("answers the caller in the same shape as every other error, with no detail", async () => {
    const res = await throwing().request("/internal/queue-depth", { headers: authed })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      statusCode: 500,
      name: "internal_error",
      message: "Something went wrong.",
    })
  })

  /**
   * ⚠ THE LOG LINE IS THE ONE THAT SURVIVES A QUOTA, AND FOR A LONG TIME IT DID
   * NOT EXIST. This handler's own comment said "what went wrong is in the log
   * and in Sentry" while writing nothing at all — so when Sentry stopped
   * accepting events, every 500 in production became invisible. A customer
   * reported an error on a domain whose DNS was perfect, `kubectl logs` showed
   * nothing for the request, and the only way to find out what threw was to
   * read the code and guess.
   */
  it("writes the failure to the log as well as reporting it", async () => {
    const logError = mock()
    await throwing(undefined, logError).request("/internal/queue-depth", {
      headers: authed,
    })

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]?.[1]).toEqual({
      route: "/internal/queue-depth",
      method: "GET",
    })
  })

  /*
   * ⚠ AND IT DOES NOT DEPEND ON THE REPORTER BEING THERE. The two are separate
   * dependencies precisely so that losing one does not lose the other.
   */
  it("logs even when there is no reporter at all", async () => {
    const logError = mock()
    await throwing(undefined, logError).request("/internal/queue-depth", {
      headers: authed,
    })
    expect(logError).toHaveBeenCalledTimes(1)
  })

  // The route PATTERN, so every failure of one endpoint is one issue rather
  // than one per id.
  it("reports it with the route pattern and the method", async () => {
    const reportError = mock()
    await throwing(reportError).request("/internal/queue-depth", { headers: authed })

    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError.mock.calls[0]?.[1]).toMatchObject({
      route: "/internal/queue-depth",
      method: "GET",
    })
  })

  it("still answers 500 when nothing is there to report to", async () => {
    const res = await throwing().request("/internal/queue-depth", { headers: authed })
    expect(res.status).toBe(500)
  })
})
