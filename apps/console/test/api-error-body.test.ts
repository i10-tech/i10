import { describe, expect, it } from "bun:test"
import { normaliseError } from "../lib/api-error"

/**
 * What survives an API refusal on its way to the browser.
 *
 * ⚠ THIS EXISTS BECAUSE THREE SHIPPED FEATURES WERE INERT AND NOTHING SAID SO.
 * `lib/api.ts` rebuilt an error body from `statusCode`, `name` and `message`
 * and dropped every other field — so the publish dialog's conflict list, the
 * DNS callback's `detail`, and the step-up prompt's `clerk_error` were all
 * written, all correct on the API, and all invisible. Each one failed by
 * showing a slightly less useful message, which is the failure nobody reports.
 *
 * ⚠ IT CALLS THE REAL FUNCTION. An earlier draft of this file re-implemented
 * the normaliser next to the assertions, which would have passed for ever —
 * including after somebody changed the original back.
 */

describe("an error body the console has to act on", () => {
  /*
   * ⚠ CLERK LOOKS FOR THIS EXACT KEY AND NOTHING ELSE. Drop it and the
   * verification dialog never opens — the person sees a 403 toast on a button
   * that is supposed to ask them a question.
   */
  it("keeps the reverification hint", () => {
    const parsed = normaliseError(
      {
        clerk_error: { type: "forbidden", reason: "reverification-error" },
        statusCode: 403,
        name: "invalid_access",
        message: "Confirm it is you before doing this.",
      },
      403,
    )

    expect(parsed).toMatchObject({
      clerk_error: { reason: "reverification-error" },
      name: "invalid_access",
    })
  })

  it("keeps the provider's own reason on a DNS callback failure", () => {
    const parsed = normaliseError(
      {
        statusCode: 502,
        name: "internal_server_error",
        message: "Cloudflare did not complete the authorisation.",
        detail: "HTTP 403 · Cloudflare served a bot challenge · cf-ray abc123",
      },
      502,
    )

    expect((parsed as { detail?: string }).detail).toContain("cf-ray")
  })

  it("keeps the records standing in the way of a publish", () => {
    const parsed = normaliseError(
      {
        statusCode: 409,
        name: "validation_error",
        message: "Some records already exist.",
        conflicts: [{ type: "TXT", name: "_dmarc.acme.com" }],
      },
      409,
    )

    expect((parsed as { conflicts?: unknown[] }).conflicts).toHaveLength(1)
  })

  /*
   * ⚠ AND THE THREE KNOWN FIELDS ARE STILL NORMALISED ON TOP. A body missing
   * `statusCode` or `name` must still produce a complete `ApiError`, because
   * every error surface in the console renders all three.
   */
  it("fills in what the API left out", () => {
    const parsed = normaliseError({ message: "Something went wrong." }, 500)
    expect(parsed).toEqual({
      statusCode: 500,
      name: "internal_server_error",
      message: "Something went wrong.",
    })
  })

  it("falls back entirely when there is no message to show", () => {
    const parsed = normaliseError({ detail: "html page" }, 502)
    expect(parsed.message).toBe("The API answered 502.")
  })
})
