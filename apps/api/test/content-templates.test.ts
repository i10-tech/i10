import { describe, expect, it } from "bun:test"
import {
  compactable,
  derive,
  joinBody,
  match,
  render,
  restore,
  skeletonHash,
  splitBody,
  staticBytes,
  tokenize,
} from "../src/content/templates.js"

/**
 * Template discovery and byte-exact compaction (#169, #171).
 *
 * ⚠ THE PROPERTY THAT MATTERS: whatever the split, a stored body rebuilds to
 * exactly what was sent. These tests throw random bodies at it to prove that,
 * not a handful of hand-picked ones.
 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32
}
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!

const RECEIPT = (name: string, order: string, total: string) =>
  `<!doctype html><html><head><style>.a{color:#333}</style></head><body>` +
  `<table width="600"><tr><td><img src="https://cdn.acme.com/logo.png" alt="Acme"></td></tr>` +
  `<tr><td><h1>Thanks for your order, ${name}!</h1>` +
  `<p>Your order <strong>#${order}</strong> is confirmed and will ship within two business days.</p>` +
  `<p>Total charged: ${total}</p><p>Questions? Reply to this email and our team will help.</p>` +
  `<p style="font-size:12px;color:#999">Acme Inc, 1 Market St, San Francisco</p></td></tr></table></body></html>`

describe("tokenising", () => {
  it("concatenates back to the input exactly, for any input", () => {
    const r = rng(1)
    const alphabet = [
      "<p>",
      "</p>",
      " ",
      "\n\t",
      "héllo",
      "世界",
      "&amp;",
      "<",
      ">",
      "a1_b",
      "!",
      "\u0000",
      "😀",
    ]
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: Math.floor(r() * 40) }, () =>
        pick(r, alphabet),
      ).join("")
      expect(tokenize(s).join("")).toBe(s)
    }
  })
})

describe("deriving a template from two sends", () => {
  it("finds the static skeleton and the holes", () => {
    const a = RECEIPT("John", "1001", "$25.00")
    const b = RECEIPT("Sarah", "1002", "$310.50")
    const t = derive(a, b)!
    expect(t).not.toBeNull()
    expect(t.segments.length - 1).toBeLessThanOrEqual(4)
    expect(staticBytes(t) / a.length).toBeGreaterThan(0.9)
    expect(render(t, match(t, a)!)).toBe(a)
  })

  it("fits a third send it has never seen", () => {
    const t = derive(
      RECEIPT("John", "1001", "$25.00"),
      RECEIPT("Sarah", "1002", "$310.50"),
    )!
    const c = RECEIPT("Mohamed Abdelkhalek", "99999", "$1,234.56")
    const values = match(t, c)!
    expect(values).not.toBeNull()
    expect(render(t, values)).toBe(c)
  })

  it("treats identical bodies as one template with no holes", () => {
    const a = RECEIPT("Ann", "1", "$1")
    expect(derive(a, a)).toEqual({ segments: [a] })
  })

  it("refuses bodies that are not one template", () => {
    expect(
      derive(
        RECEIPT("A", "1", "$1"),
        "<p>A completely different newsletter about gardening and spring bulbs.</p>",
      ),
    ).toBeNull()
  })

  it("names a template by its skeleton, not by its values", () => {
    const t1 = derive(RECEIPT("A", "1", "$1"), RECEIPT("B", "2", "$2"))!
    const t2 = derive(RECEIPT("C", "3", "$3"), RECEIPT("D", "4", "$4"))!
    expect(skeletonHash(t1)).toBe(skeletonHash(t2))
  })
})

describe("byte-exact compaction", () => {
  it("rebuilds every body exactly, across thousands of random sends", () => {
    const r = rng(7)
    const names = [
      "Ann",
      "Bob",
      "Zoë",
      "李雷",
      "O'Brien",
      "<b>x</b>",
      "",
      " ",
      "Thanks for your order, ",
    ]
    const t = derive(
      RECEIPT("John", "1001", "$25.00"),
      RECEIPT("Sarah", "1002", "$310.50"),
    )!
    let fitted = 0
    for (let i = 0; i < 2000; i++) {
      const body = RECEIPT(
        pick(r, names),
        String(Math.floor(r() * 1e6)),
        `$${(r() * 1000).toFixed(2)}`,
      )
      const parts = { html: body, text: r() > 0.5 ? `Thanks ${pick(r, names)}` : null }
      const joinedTemplate = derive(
        joinBody({ html: RECEIPT("John", "1001", "$25.00"), text: null })!,
        joinBody({ html: RECEIPT("Sarah", "1002", "$310.50"), text: null })!,
      )!
      const values = compactable(joinedTemplate, parts)
      if (values) {
        fitted++
        expect(restore(joinedTemplate, values)).toEqual(parts)
      }
      void t
    }
    expect(fitted).toBeGreaterThan(500)
  })

  it("keeps null and empty apart for html and text", () => {
    for (const parts of [
      { html: null, text: "t" },
      { html: "", text: "t" },
      { html: "h", text: null },
      { html: "h", text: "" },
      { html: null, text: null },
    ]) {
      expect(splitBody(joinBody(parts)!)).toEqual(parts)
    }
  })

  it("refuses a body containing the separator rather than risk it", () => {
    expect(joinBody({ html: "a\u0001b", text: null })).toBeNull()
    expect(
      compactable({ segments: ["x"] }, { html: "a\u0001b", text: null }),
    ).toBeNull()
  })

  it("never claims a body fits when it does not", () => {
    const t = derive(
      joinBody({ html: RECEIPT("A", "1", "$1"), text: null })!,
      joinBody({ html: RECEIPT("B", "2", "$2"), text: null })!,
    )!
    expect(compactable(t, { html: "<p>unrelated</p>", text: null })).toBeNull()
    // A space after </html> has no hole to go in: refused, which is safe.
    expect(
      compactable(t, { html: RECEIPT("A", "1", "$1") + " ", text: null }),
    ).toBeNull()
    // Currency is part of the skeleton here; a euro total is a different mail.
    expect(
      compactable(t, { html: RECEIPT("A", "1", "\u20ac1"), text: null }),
    ).toBeNull()
  })

  it("is fast enough for a background job on a 20 KB body", () => {
    const pad =
      "<p>" +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(300) +
      "</p>"
    const a = RECEIPT("John", "1001", "$25.00") + pad
    const b = RECEIPT("Sarah", "1002", "$310.50") + pad
    const t0 = performance.now()
    const t = derive(a, b)!
    for (let i = 0; i < 200; i++) match(t, RECEIPT(`N${i}`, String(i), "$1") + pad)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
