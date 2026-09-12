import { describe, expect, it } from "bun:test"
import { createApp } from "../src/app.js"

const app = createApp()

async function spec() {
  const res = await app.request("/openapi.json")
  expect(res.status).toBe(200)
  return (await res.json()) as {
    openapi: string
    paths: Record<string, Record<string, unknown>>
    components?: {
      securitySchemes?: Record<string, unknown>
      schemas?: Record<string, unknown>
    }
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
      requestBody: { content: Record<string, { schema: { $ref?: string } }> }
      responses: Record<string, unknown>
    }

    // ⚠ A $ref, not an inline object. Without named components a generator
    // emits an anonymous type per endpoint, and the same Error shape lands four
    // times under four different names.
    const ref = post.requestBody.content["application/json"]!.schema.$ref
    expect(ref).toBe("#/components/schemas/SendEmail")

    const component = doc.components?.schemas?.SendEmail as { properties?: object }
    expect(Object.keys(component.properties ?? {})).toEqual(
      expect.arrayContaining(["from", "to", "subject"]),
    )

    // Error responses are part of the contract an SDK codes against.
    expect(Object.keys(post.responses)).toEqual(
      expect.arrayContaining(["200", "401", "422", "429"]),
    )
  })

  it("names every shared schema as a reusable component", async () => {
    const doc = await spec()
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(
      expect.arrayContaining([
        "SendEmail",
        "SendEmailResponse",
        "BatchSend",
        "BatchSendResponse",
        "Error",
      ]),
    )
  })

  // The human-readable reference lives at docs.i10.tech/api. This origin serves
  // machines; two rendered copies would be two things to keep in sync.
  it("does not render HTML on the API origin", async () => {
    const res = await app.request("/reference")
    expect(res.status).toBe(404)
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
