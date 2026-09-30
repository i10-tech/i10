import { describe, expect, it } from "bun:test"
// ⚠ THE APP FIRST: it installs the OpenAPI extension on zod, which the
// contracts' schemas expect to find when they are first evaluated.
import { createApp } from "../src/app.js"
import { MAX_ATTACHMENTS, sendEmailSchema } from "@repo/contracts"
import { buildRawMessage } from "../src/send/mime.js"

/**
 * Input the send path refuses, or neutralises, without altering content (#189).
 *
 * ⚠ HEADER INJECTION WAS REAL. An address is written raw into `From`, `To`,
 * `Cc` and `Reply-To`, and `Evil\r\nX-A: 1 <me@verified.test>` still parses as
 * an address on the verified domain - so before this, a caller could put any
 * header, or a blank line and a body of its choosing, into its own message,
 * past the headers the pipeline owns.
 */
const base = { from: "a@b.test", to: "c@d.test", subject: "s", text: "t" }
const issues = (input: unknown) => {
  const r = sendEmailSchema.safeParse(input)
  // The top-level field each issue is about: `to.1` and `headers.X-A` are `to`
  // and `headers`.
  return r.success ? [] : [...new Set(r.error.issues.map((i) => String(i.path[0])))]
}

describe("the send contract", () => {
  it("refuses a line break or control character in any address", () => {
    expect(issues({ ...base, from: "Evil\r\nX-A: 1 <a@b.test>" })).toContain("from")
    expect(issues({ ...base, to: ["ok@d.test", "x\n@d.test"] })).toEqual(["to"])
    expect(issues({ ...base, reply_to: "r@x.test\u0000" })).toEqual(["reply_to"])
    expect(issues({ ...base, from: 'Bob "The Sender" <a@b.test>' })).toEqual([])
  })

  it("refuses a header name that is not a field name", () => {
    expect(issues({ ...base, headers: { "X-A\r\nBcc": "v" } })).toEqual(["headers"])
    expect(issues({ ...base, headers: { "X A": "v" } })).toEqual(["headers"])
    expect(issues({ ...base, headers: { "X-Entity-Ref-ID": "v" } })).toEqual([])
  })

  it("refuses text that is not valid Unicode", () => {
    expect(issues({ ...base, subject: "a\ud800b" })).toEqual(["subject"])
    expect(issues({ ...base, html: "<p>\udc00</p>" })).toEqual(["html"])
    expect(issues({ ...base, text: "emoji 😀 is fine" })).toEqual([])
  })

  it("refuses more attachments than SES takes MIME parts", () => {
    const file = { filename: "a.txt", content: "YQ==" }
    expect(
      issues({ ...base, attachments: Array(MAX_ATTACHMENTS + 1).fill(file) }),
    ).toEqual(["attachments"])
  })
})

describe("the MIME builder, as a second line", () => {
  it("never writes a line break from an address or a header name", () => {
    const raw = buildRawMessage(
      {
        id: "00000000-0000-4000-8000-000000000000",
        from: "Evil\r\nX-Injected: 1 <a@b.test>",
        to: ["c@d.test"],
        cc: [],
        bcc: [],
        replyTo: ["r@x.test\r\nX-Also: 1"],
        subject: "Hi\r\nX-Subject: 1",
        html: null,
        text: "t",
        headers: { "X-A\r\nX-Name": "v", "X-Ok": "fine" },
      } as never,
      [],
    )
    const head = raw.split("\r\n\r\n")[0]!
    expect(head).not.toMatch(/^X-(Injected|Also|Subject|Name)/m)
    expect(head).toMatch(/^X-Ok: fine$/m)
  })
})

describe("the send routes' body limit", () => {
  const post = (path: string, bytes: number) =>
    createApp({}).request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(bytes).fill(0x20),
    })

  it("refuses a body past the limit before anything reads it", async () => {
    expect((await post("/emails", 25 * 1024 * 1024)).status).toBe(413)
    expect((await post("/emails/batch", 41 * 1024 * 1024)).status).toBe(413)
    expect((await post("/emails", 1024)).status).not.toBe(413)
  })
})
