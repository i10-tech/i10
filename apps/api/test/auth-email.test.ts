import { describe, expect, it, mock } from "bun:test"
import { SLUG } from "@repo/emails"
import { authEmailDelivery, type AuthEmailSend } from "../src/auth-email/deliver.js"

/**
 * Who sends Clerk's authentication mail, and when we must not.
 *
 * The double-send guard is the one that matters: Clerk's per-template switch
 * means both states exist at once during the migration.
 */

function harness() {
  const sent: AuthEmailSend[] = []
  const log = { info: mock(), warn: mock() }
  const delivery = authEmailDelivery({
    sender: {
      async send(input) {
        sent.push(input)
      },
    },
    log,
  })
  return { delivery, sent, log }
}

const event = (over: Record<string, unknown> = {}) => ({
  id: "eml_1",
  slug: SLUG.verificationCode,
  subject: "Your verification code",
  to_email_address: "someone@example.com",
  delivered_by_clerk: false,
  data: { otp_code: "384021" },
  ...over,
})

describe("who owns delivery", () => {
  /**
   * ⚠ THE EXPENSIVE MISTAKE. Clerk cannot disable its delivery for every
   * template at once, so a template still marked "Delivered by Clerk" emits
   * this event AND sends the mail. Sending again puts two codes in somebody's
   * inbox, and the second one invalidates the first.
   */
  it("sends nothing when Clerk already delivered it", async () => {
    const h = harness()
    const outcome = await h.delivery.onEmailCreated(event({ delivered_by_clerk: true }))

    expect(outcome).toBe("clerk_delivers")
    expect(h.sent).toHaveLength(0)
  })

  it("sends when Clerk has handed delivery over", async () => {
    const h = harness()
    const outcome = await h.delivery.onEmailCreated(event())

    expect(outcome).toBe("sent")
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.to).toBe("someone@example.com")
  })
})

describe("what gets sent", () => {
  it("renders our own template when the code is there", async () => {
    const h = harness()
    await h.delivery.onEmailCreated(event())

    expect(h.sent[0]!.html).toContain("384021")
    // A real plain-text part, not stripped HTML — see renderClerkEmail.
    expect(h.sent[0]!.text?.length).toBeGreaterThan(0)
  })

  /**
   * ⚠ CLERK ADDS TEMPLATES, AND WE MUST NOT DROP THEM. A slug we have never
   * seen still has to reach the customer, in Clerk's styling, rather than
   * vanishing the first time somebody turns on a feature in the dashboard.
   */
  it("falls back to Clerk's body for a template we do not know", async () => {
    const h = harness()
    const outcome = await h.delivery.onEmailCreated(
      event({ slug: "brand_new_template", data: {}, body: "<p>from clerk</p>" }),
    )

    expect(outcome).toBe("sent")
    expect(h.sent[0]!.html).toContain("from clerk")
  })

  /** The unknown slug is logged, which is how the slug table gets filled in. */
  it("names the unrecognised slug in the log", async () => {
    const h = harness()
    await h.delivery.onEmailCreated(
      event({ slug: "brand_new_template", data: {}, body: "<p>x</p>" }),
    )

    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "brand_new_template" }),
      expect.stringContaining("clerk's own body"),
    )
  })

  /**
   * ⚠ A CODE EMAIL WITH NO CODE IS WORSE THAN CLERK'S VERSION OF IT. Rendering
   * ours anyway would send an empty box where the digits should be.
   */
  it("falls back rather than rendering a code email with no code", async () => {
    const h = harness()
    await h.delivery.onEmailCreated(event({ data: {}, body: "<p>from clerk</p>" }))

    expect(h.sent[0]!.html).toContain("from clerk")
  })
})

describe("what cannot be sent", () => {
  it("drops an event with no recipient", async () => {
    const h = harness()
    const outcome = await h.delivery.onEmailCreated(
      event({ to_email_address: undefined }),
    )

    expect(outcome).toBe("nothing_to_send")
    expect(h.sent).toHaveLength(0)
  })

  it("drops an event with nothing to render and no body", async () => {
    const h = harness()
    const outcome = await h.delivery.onEmailCreated(
      event({ slug: "unknown", data: {}, body: undefined }),
    )

    expect(outcome).toBe("nothing_to_send")
    expect(h.sent).toHaveLength(0)
  })
})

describe("surviving a redelivery", () => {
  /**
   * ⚠ THE SEND PATH DEDUPES, NOT THIS MODULE. Svix retries, and the projection
   * claims the Svix id in a transaction that commits before anything is sent —
   * so keying on that would skip a send that had failed. Clerk's email id is
   * stable across redeliveries and is what the send path refuses twice.
   */
  it("keys idempotency on Clerk's email id", async () => {
    const h = harness()
    await h.delivery.onEmailCreated(event())

    expect(h.sent[0]!.idempotencyKey).toBe("eml_1")
  })

  it("falls back to a stable key when Clerk sends no id", async () => {
    const h = harness()
    await h.delivery.onEmailCreated(event({ id: undefined }))
    await h.delivery.onEmailCreated(event({ id: undefined }))

    expect(h.sent[0]!.idempotencyKey).toBe(h.sent[1]!.idempotencyKey)
  })
})
