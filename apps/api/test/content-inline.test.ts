import { describe, expect, it } from "bun:test"
import { sendEmailSchema } from "@repo/contracts"
import {
  extractDataUris,
  inlineReferences,
  MARK,
  MIN_PAYLOAD_CHARS,
  restoreInline,
} from "../src/content/inline.js"
import { memoryStore, objectKey } from "../src/content/object-store.js"

/**
 * Data-URI images lifted out of stored html and put back byte-exactly (#168).
 */
const png = (fill: number, bytes = 2_000) =>
  Buffer.alloc(bytes, fill).toString("base64")
const page = (b64: string, extra = "") =>
  `<html><body><img alt="logo" src="data:image/png;base64,${b64}">${extra}<p>Thanks for your order.</p></body></html>`

describe("extractDataUris", () => {
  it("replaces large canonical payloads with a reference, and restores exactly", async () => {
    const html = page(png(1), `<img src="data:image/png;base64,${png(1)}">`)
    const out = extractDataUris(html)!
    expect(out).not.toBeNull()
    // The same image twice is one object.
    expect(out.objects.size).toBe(1)
    const [sha] = [...out.objects.keys()]
    expect(out.html).toContain(`data:image/png;base64,${MARK}${sha}${MARK}`)
    expect(out.html.length).toBeLessThan(html.length / 10)
    expect(inlineReferences(out.html)).toEqual([sha!])

    const store = memoryStore()
    const tenant = "t1"
    for (const [h, o] of out.objects) await store.put(objectKey(tenant, h), o.bytes)
    const [back] = await restoreInline(store, tenant, [
      { html: out.html, inlineObjects: [sha!] },
    ])
    expect(back!.html).toBe(html)
  })

  it("leaves small, non-canonical and already-marked bodies alone", () => {
    const small = Buffer.alloc(100, 7).toString("base64")
    expect(small.length).toBeLessThan(MIN_PAYLOAD_CHARS)
    expect(extractDataUris(page(small))).toBeNull()

    // Line-wrapped base64 decodes fine but would not restore byte-exactly.
    const wrapped = png(2).replace(/(.{76})/g, "$1\n")
    expect(extractDataUris(page(wrapped))).toBeNull()

    // A body that already holds the marker character is never touched.
    expect(extractDataUris(page(png(3), `<p>${MARK}odd</p>`))).toBeNull()
  })

  it("keeps the mime type and its parameters as they were", () => {
    const html = `<img src="data:image/svg+xml;charset=utf-8;base64,${png(4)}">`
    const out = extractDataUris(html)!
    expect(
      out.html.startsWith('<img src="data:image/svg+xml;charset=utf-8;base64,'),
    ).toBe(true)
    expect([...out.objects.values()][0]!.type).toBe("image/svg+xml")
  })
})

describe("restoreInline", () => {
  it("passes rows with no references through without a store", async () => {
    const rows = [{ html: "<p>hi</p>", inlineObjects: null }]
    expect(await restoreInline(null, "t1", rows)).toBe(rows)
  })

  it("fails loudly when references exist and no store is configured", async () => {
    const out = extractDataUris(page(png(5)))!
    await expect(
      restoreInline(null, "t1", [
        { html: out.html, inlineObjects: [...out.objects.keys()] },
      ]),
    ).rejects.toThrow("no content store is configured")
  })
})

describe("content_id in the contract", () => {
  const base = {
    from: "a@example.com",
    to: "b@example.com",
    subject: "s",
    html: '<img src="cid:logo">',
  }
  const att = (content_id: string) => ({
    filename: "logo.png",
    content: Buffer.from("x").toString("base64"),
    content_id,
  })

  it("accepts a plain id and refuses one that could break the header", () => {
    expect(
      sendEmailSchema.safeParse({ ...base, attachments: [att("logo@acme")] }).success,
    ).toBe(true)
    for (const bad of ["lo go", "<logo>", 'lo"go', "logo\r\nBcc: x@y.z"]) {
      expect(
        sendEmailSchema.safeParse({ ...base, attachments: [att(bad)] }).success,
      ).toBe(false)
    }
  })
})
