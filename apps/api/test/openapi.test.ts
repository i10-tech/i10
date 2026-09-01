import { describe, expect, it } from "vitest"
import { createApp } from "../src/app.js"

const app = createApp()

async function spec() {
  const res = await app.request("/openapi.json")
  expect(res.status).toBe(200)
  return (await res.json()) as {
    openapi: string
    paths: Record<string, Record<string, unknown>>
    components?: { securitySchemes?: Record<string, unknown> }
  }
}

describe("the published OpenAPI document", () => {
  it("describes both send routes", async () => {
    const doc = await spec()
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.paths["/emails"]?.post).toBeDefined()
    expect(doc.paths["/emails/batch"]?.post).toBeDefined()
  })

  // ⚠ The webhook implements Clerk's contract, not ours. Publishing it would
  // invite customers to call it and put it in every generated SDK.
  it("does not publish the Clerk webhook", async () => {
    const doc = await spec()
    expect(Object.keys(doc.paths)).not.toContain("/webhooks/clerk")
  })

  // The header is what makes `resend/node` → `@i10/node` a one-line migration.
  it("documents bearer authentication", async () => {
    const doc = await spec()
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    })
  })

  it("carries the request body schema, so SDKs can be generated from it", async () => {
    const doc = await spec()
    const post = doc.paths["/emails"]!.post as {
      requestBody: { content: Record<string, { schema: { properties?: object } }> }
      responses: Record<string, unknown>
    }
    const schema = post.requestBody.content["application/json"]!.schema
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["from", "to", "subject"]),
    )
    // Error responses are part of the contract an SDK codes against.
    expect(Object.keys(post.responses)).toEqual(
      expect.arrayContaining(["200", "401", "422", "429"]),
    )
  })

  it("serves the Scalar reference", async () => {
    const res = await app.request("/reference")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
  })
})

describe("the send path's error ordering", () => {
  it("refuses an unauthenticated send before it validates the body", async () => {
    const res = await app.request("/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}), // would also fail validation
    })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ name: "invalid_access" })
  })

  // ⚠ This asserts the safety interlock, not a finished feature. A well-formed
  // key gets 501 because key verification is not wired up, and until it is the
  // route must refuse rather than fall through to a half-built send path.
  // When auth lands, this becomes the 422 validation-shape test.
  it("refuses a well-formed key while verification is unwired", async () => {
    const res = await app.request("/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer i10_test_abcdefghijklmnopqrstuvwx",
      },
      body: JSON.stringify({ from: "a@i10.tech", subject: "hi", text: "x" }),
    })
    expect(res.status).toBe(501)
  })
})
