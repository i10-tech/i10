import { describe, expect, it } from "bun:test"
import {
  ALLOWLISTED,
  BAND_COUNT,
  fingerprint,
  htmlToText,
  linkHosts,
  minhash,
  MIN_FINGERPRINT_CHARS,
  normalise,
  similarity,
} from "../src/risk/fingerprint.js"

const shared = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length

/**
 * Content fingerprints (#170): the same mail must match across workspaces
 * however it is personalised, and different mail must not.
 */
const PROMO = `<html><body><h1>Exclusive offer for you, {{name}}</h1>
<p>Claim your reward today. Limited stock, act now before the offer ends.</p>
<p>Visit <a href="https://deals.example.top/claim?u=8812&t=abcdef0123456789xyz">our store</a> and use code 4471.</p>
<p>Unsubscribe at https://deals.example.top/u/8812</p></body></html>`

const personalised = (name: string, id: number) =>
  PROMO.replace("{{name}}", name)
    .replaceAll("8812", String(id))
    .replace("4471", String(id * 3))

describe("normalising", () => {
  it("strips what differs per recipient: digits, query strings, addresses, whitespace", () => {
    const a = normalise("Offer 1", personalised("Ann", 1001), null)
    const b = normalise("Offer 2", personalised("Ann", 2002), null)
    expect(a).toBe(b)
    expect(a).not.toContain("?")
    expect(a).toContain("url:deals.example.top")
    expect(normalise("hi", null, "write to bob@example.com")).toContain("@")
  })

  it("drops script and style content from HTML", () => {
    const text = htmlToText(
      "<style>.a{color:red}</style><script>alert(1)</script><p>Hello</p>",
    )
    expect(text).not.toContain("color")
    expect(text).not.toContain("alert")
    expect(text).toContain("Hello")
  })
})

describe("fingerprints", () => {
  it("gives identical mail an identical exact hash and identical bands", () => {
    const a = fingerprint("Exclusive offer", personalised("Ann", 1), null)!
    const b = fingerprint("Exclusive offer", personalised("Ann", 999), null)!
    expect(a.exact).toBe(b.exact)
    expect(a.bands).toEqual(b.bands)
    expect(a.bands).toHaveLength(BAND_COUNT)
  })

  it("matches near-duplicates on two or more bands when the exact hash differs", () => {
    const a = fingerprint("Exclusive offer", personalised("Ann", 1), null)!
    const b = fingerprint("Exclusive offer", `${personalised("Zed", 1)} zqxjv`, null)!
    expect(a.exact).not.toBe(b.exact)
    expect(shared(a.bands, b.bands)).toBeGreaterThanOrEqual(2)
  })

  it("shares no band between unrelated mail", () => {
    const a = fingerprint("Exclusive offer", personalised("Ann", 1), null)!
    const b = fingerprint(
      "Your receipt",
      null,
      "Thanks for your order. Your receipt for the annual plan is attached, and your invoice is available in the billing portal at any time.",
    )!
    expect(shared(a.bands, b.bands)).toBe(0)
  })

  it("estimates similarity: high for a copy with a word changed, low for different text", () => {
    const base = normalise(
      "Spring",
      null,
      "New arrivals include jackets shoes bags and accessories for every season with free shipping on orders over fifty and easy returns within thirty days",
    )
    const edit = base.replace("jackets", "coats")
    const other = normalise(
      "Receipt",
      null,
      "Thanks for your order your receipt for the annual plan is attached and the invoice is in the billing portal",
    )
    expect(similarity(minhash(base), minhash(edit))).toBeGreaterThan(0.6)
    expect(similarity(minhash(base), minhash(other))).toBeLessThan(0.2)
  })

  it("keeps every signature slot unsigned (the bug that made copies look 6% alike)", () => {
    for (const v of minhash("a b c d e f g h i j k l m n o p")) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it("refuses to fingerprint mail too short to be distinctive", () => {
    expect(fingerprint("hi", null, "test")).toBeNull()
    expect(MIN_FINGERPRINT_CHARS).toBeGreaterThan(20)
  })

  it("is fast enough for the accept path", () => {
    const body = "word ".repeat(1000)
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) fingerprint(`s${i}`, null, `${body}${i}`)
    expect((performance.now() - t0) / 200).toBeLessThan(5)
  })

  it("allowlists our own docs' examples", () => {
    expect(ALLOWLISTED.size).toBeGreaterThan(0)
  })
})

describe("link hosts", () => {
  it("keeps hosts, never paths or query strings", () => {
    const hosts = linkHosts(PROMO, "also https://Example.COM/path?secret=1")
    expect(hosts).toContain("deals.example.top")
    expect(hosts).toContain("example.com")
    expect(hosts.join(" ")).not.toContain("secret")
    expect(hosts.join(" ")).not.toContain("/")
  })

  it("is bounded", () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `https://h${i}.example.com/`,
    ).join(" ")
    expect(linkHosts(null, many, 50)).toHaveLength(50)
  })
})
