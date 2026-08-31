import { describe, expect, it } from "vitest"
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
