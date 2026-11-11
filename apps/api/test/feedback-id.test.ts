import { describe, expect, it } from "bun:test"
import {
  FEEDBACK_SENDER_ID,
  feedbackIdHeaderValue,
  feedbackTokens,
} from "../src/send/feedback-id.js"

/**
 * The workspace token behind the Feedback-ID header.
 *
 * What matters is what a recipient or Google sees: a value that is stable for a
 * workspace so complaints accumulate under it, different between workspaces so
 * they do not merge, and that gives away nothing about the tenant behind it.
 */

const SECRET = "a-test-secret-that-is-at-least-32-bytes-long"
const TENANT_A = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6071"
const TENANT_B = "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f6072"

describe("the workspace token", () => {
  const token = feedbackTokens(SECRET)

  // ⚠ STABILITY IS THE POINT. Postmaster Tools aggregates by the value, so a
  // token that changed between sends would scatter one workspace's complaints
  // across rows that never reach the volume threshold.
  it("is the same for one tenant, across calls and across instances", () => {
    expect(token(TENANT_A)).toBe(token(TENANT_A))
    expect(feedbackTokens(SECRET)(TENANT_A)).toBe(token(TENANT_A))
  })

  // ⚠ AND TWO WORKSPACES MUST NOT SHARE ONE, or one sender's complaints would be
  // charged to the other.
  it("differs between tenants", () => {
    expect(token(TENANT_A)).not.toBe(token(TENANT_B))
  })

  it("is keyed: another secret gives another token", () => {
    expect(
      feedbackTokens("another-secret-that-is-also-32-bytes-long!")(TENANT_A),
    ).not.toBe(token(TENANT_A))
  })

  // ⚠ HEADERS ARE PUBLIC. Nothing of the tenant id may be readable in the token.
  it("reveals nothing of the tenant id", () => {
    const value = token(TENANT_A)
    const hex = TENANT_A.replaceAll("-", "")
    expect(value).not.toContain(TENANT_A)
    expect(hex).not.toContain(value)
    expect(value).not.toContain(hex.slice(0, 8))
  })

  // Letters, digits, underscore and dash is all an SES message-tag value allows
  // (256 at most), and a colon would split the Feedback-ID into extra fields.
  it("is short, and inside what an SES tag value and a header field allow", () => {
    const value = token(TENANT_A)
    expect(value).toMatch(/^[0-9a-f]{16}$/)
  })

  // ⚠ I10'S OWN MAIL, AND ANY TENANT ID THAT IS NOT A UUID, STILL GET A VALUE.
  // The function must not be a way for a send to fail.
  it("is defined for any tenant id, including an empty one", () => {
    for (const id of ["", "ten-1", "i10", "not a uuid at all"]) {
      expect(token(id)).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(token("")).not.toBe(token("ten-1"))
  })
})

describe("the direct route's header value", () => {
  const value = feedbackIdHeaderValue(feedbackTokens(SECRET)(TENANT_A))

  // Google: `a:b:c:SenderId`, with the SenderId 5 to 15 characters. Without a
  // SenderId no data is generated at all.
  it("is four colon-separated fields ending in a valid SenderId", () => {
    const fields = value.split(":")
    expect(fields).toHaveLength(4)
    expect(fields[3]).toBe(FEEDBACK_SENDER_ID)
    expect(FEEDBACK_SENDER_ID.length).toBeGreaterThanOrEqual(5)
    expect(FEEDBACK_SENDER_ID.length).toBeLessThanOrEqual(15)
  })

  it("carries the workspace token as the first identifier", () => {
    expect(value.split(":")[0]).toBe(feedbackTokens(SECRET)(TENANT_A))
  })

  it("is a single header-safe line", () => {
    expect(value).toMatch(/^[0-9a-f]{16}:::[A-Za-z0-9]+$/)
  })
})
