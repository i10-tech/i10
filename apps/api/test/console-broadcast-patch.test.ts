import { describe, expect, it } from "bun:test"
import { broadcastPatch } from "../src/routes/console/campaigns.js"

/**
 * The wire names, translated into the store's names.
 *
 * ⚠ THIS FUNCTION IS THE ONLY PLACE THE TWO VOCABULARIES MEET, AND A MISSING
 * LINE IN IT IS SILENT. `PATCH /broadcasts/:id` answers 200 with the broadcast
 * either way; the field simply does not move. The first version of this dropped
 * `segment_id` and `topic_id` entirely — so choosing who a broadcast goes to
 * appeared to work, saved nothing, and sent to nobody.
 *
 * ⚠ AND `undefined` VERSUS `null` IS THE WHOLE SEMANTIC. Absent means "leave it
 * alone"; explicit null means "clear it". Collapsing them would make every
 * partial save wipe every field the form did not include.
 */
describe("broadcastPatch", () => {
  it("maps every wire field onto its column", () => {
    expect(
      broadcastPatch({
        segment_id: "11111111-1111-4111-8111-111111111111",
        topic_id: "22222222-2222-4222-8222-222222222222",
        name: "October launch",
        from: "news@acme.com",
        reply_to: ["hello@acme.com"],
        subject: "We shipped",
        preview_text: "Six months of work",
        html: "<p>hi</p>",
        text: "hi",
        scheduled_at: "2026-10-01T09:00:00.000Z",
      }),
    ).toEqual({
      segmentId: "11111111-1111-4111-8111-111111111111",
      topicId: "22222222-2222-4222-8222-222222222222",
      name: "October launch",
      from: "news@acme.com",
      replyTo: ["hello@acme.com"],
      subject: "We shipped",
      previewText: "Six months of work",
      html: "<p>hi</p>",
      text: "hi",
      scheduledAt: new Date("2026-10-01T09:00:00.000Z"),
    })
  })

  it("omits a field that was not sent, rather than clearing it", () => {
    expect(broadcastPatch({ subject: "Just the subject" })).toEqual({
      subject: "Just the subject",
    })
  })

  /**
   * ⚠ AN EXPLICIT NULL IS AN INSTRUCTION. "Send to everybody rather than to a
   * segment", "unschedule this", "drop the plain-text part" — each is a real
   * edit somebody makes, and each is indistinguishable from "field absent" if
   * the mapping tests `typeof x === "string"` instead of `!== undefined`.
   */
  it("carries an explicit null through as a clear", () => {
    expect(
      broadcastPatch({
        segment_id: null,
        topic_id: null,
        preview_text: null,
        html: null,
        text: null,
        scheduled_at: null,
      }),
    ).toEqual({
      segmentId: null,
      topicId: null,
      previewText: null,
      html: null,
      text: null,
      scheduledAt: null,
    })
  })

  it("is an empty patch for an empty or missing body", () => {
    expect(broadcastPatch(null)).toEqual({})
    expect(broadcastPatch({})).toEqual({})
  })

  /**
   * ⚠ A `reply_to` WITH A NUMBER IN IT MUST NOT REACH A `text[]` COLUMN. The
   * insert would throw, which is a 500 for a body the API should have refused
   * — and the array arrives from a form that a browser extension or a bad SDK
   * can shape however it likes.
   */
  it("keeps only the strings out of reply_to", () => {
    expect(
      broadcastPatch({ reply_to: ["a@acme.com", 7, null, "b@acme.com", {}] }),
    ).toEqual({ replyTo: ["a@acme.com", "b@acme.com"] })
  })

  /**
   * ⚠ AN UNPARSEABLE DATE BECOMES `null`, NOT AN `Invalid Date`. An invalid Date
   * object passed to the driver is `NaN` in a timestamptz parameter, which fails
   * the statement — a 500 for somebody typing in a date field.
   */
  it("does not pass an unparseable date through", () => {
    expect(broadcastPatch({ scheduled_at: "next tuesday" })).toEqual({
      scheduledAt: null,
    })
  })

  /**
   * ⚠ THE OLD VOCABULARY IS NOT ACCEPTED. `audience_id` was this product's name
   * for a segment for about a week; a patch that quietly honoured it would let
   * the two names diverge in every client that copied an old example.
   */
  it("ignores fields that are not part of the contract", () => {
    expect(
      broadcastPatch({ audience_id: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual({})
  })
})
