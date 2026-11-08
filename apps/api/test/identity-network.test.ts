import { describe, expect, it } from "bun:test"
import {
  MAX_RANGES,
  clientAddress,
  formatAddress,
  inRanges,
  normaliseRanges,
  parseAddress,
  parseCidr,
  readRanges,
} from "../src/identity/network.js"
import { signClientContext } from "../src/risk/identity.js"
import { EDGE_PROOF, EDGE_SECRET } from "./edge-fixture.js"

/**
 * The IP allowlist's address maths (#345): what counts as an address, what a
 * range means, and which address a request is taken to come from. Refusals
 * first.
 */

const ranges = (...list: string[]) => {
  const done = normaliseRanges(list)
  if (!done.ok) throw new Error("bad fixture")
  return readRanges(done.ranges)
}
const at = (text: string) => {
  const a = parseAddress(text)
  if (!a) throw new Error(`bad address ${text}`)
  return a
}

describe("addresses we refuse to read", () => {
  const bad = [
    "",
    "256.1.1.1",
    "1.2.3",
    "1.2.3.4.5",
    "01.2.3.4",
    "1.2.3.04",
    "1.2.3.4 ",
    "1.2.3.4/24",
    "::g",
    "1::2::3",
    "fe80::1%eth0",
    "12345::1",
    ":::",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "::ffff:1.2.3.256",
    "x".repeat(60),
  ]
  for (const text of bad)
    it(`does not parse ${JSON.stringify(text.slice(0, 20))}`, () => {
      expect(parseAddress(text)).toBeNull()
    })
})

describe("ranges we refuse to save", () => {
  const bad = [
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0/",
    "10.0.0.0/08",
    "10.0.0.0/8/8",
    "2001:db8::/129",
    "not an address",
    "10.0.0.0/ 8",
    "::ffff:10.0.0.0/64",
    "::ffff:10.0.0.0/95",
    "",
  ]
  for (const text of bad)
    it(`refuses ${JSON.stringify(text)}`, () => {
      expect(parseCidr(text)).toBeNull()
      expect(normaliseRanges([text])).toEqual({ ok: false, error: "invalid", index: 0 })
    })

  it("refuses a list that is not strings, with the position of the bad one", () => {
    expect(normaliseRanges(["10.0.0.0/8", 5])).toEqual({
      ok: false,
      error: "invalid",
      index: 1,
    })
  })

  it(`refuses more than ${MAX_RANGES} ranges and accepts exactly that many`, () => {
    const many = Array.from({ length: MAX_RANGES + 1 }, (_, i) => `10.0.${i}.0/24`)
    expect(normaliseRanges(many)).toEqual({ ok: false, error: "too_many" })
    expect(normaliseRanges(many.slice(0, MAX_RANGES)).ok).toBe(true)
  })
})

describe("normalising", () => {
  it("clears host bits, drops duplicates and orders IPv4 before IPv6", () => {
    const done = normaliseRanges([
      "2001:DB8::1/32",
      "203.0.113.77/24",
      "203.0.113.0/24",
      "198.51.100.9",
    ])
    expect(done).toEqual({
      ok: true,
      ranges: ["198.51.100.9/32", "203.0.113.0/24", "2001:db8::/32"],
    })
  })

  it("writes IPv6 the canonical way", () => {
    const text = (input: string) => {
      const done = normaliseRanges([input])
      return done.ok ? done.ranges[0] : null
    }
    expect(text("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1/128")
    expect(text("0:0:0:0:0:0:0:1")).toBe("::1/128")
    expect(text("2001:db8:0:1:0:0:0:1/64")).toBe("2001:db8:0:1::/64")
    expect(text("1:0:0:2:0:0:0:3/128")).toBe("1:0:0:2::3/128")
    // RFC 5952: a lone zero group is written out, never shortened.
    expect(text("1:0:2:0:3:0:4:0/128")).toBe("1:0:2:0:3:0:4:0/128")
  })

  it("reads an IPv4-mapped range as the IPv4 range it is", () => {
    expect(normaliseRanges(["::ffff:203.0.113.0/120"])).toEqual({
      ok: true,
      ranges: ["203.0.113.0/24"],
    })
    expect(normaliseRanges(["::ffff:cb00:7100/120"])).toEqual({
      ok: true,
      ranges: ["203.0.113.0/24"],
    })
  })
})

describe("matching", () => {
  it("matches inside a range and not one address past it", () => {
    const list = ranges("203.0.113.0/24")
    expect(inRanges(at("203.0.113.0"), list)).toBe(true)
    expect(inRanges(at("203.0.113.255"), list)).toBe(true)
    expect(inRanges(at("203.0.114.0"), list)).toBe(false)
    expect(inRanges(at("203.0.112.255"), list)).toBe(false)
  })

  it("matches a single host only", () => {
    const list = ranges("198.51.100.9")
    expect(inRanges(at("198.51.100.9"), list)).toBe(true)
    expect(inRanges(at("198.51.100.10"), list)).toBe(false)
  })

  it("matches IPv6 by prefix", () => {
    const list = ranges("2001:db8:abcd::/48")
    expect(inRanges(at("2001:db8:abcd:ffff::1"), list)).toBe(true)
    expect(inRanges(at("2001:db8:abce::1"), list)).toBe(false)
  })

  it("treats an IPv4-mapped IPv6 client as the IPv4 address it is", () => {
    const v4 = ranges("203.0.113.0/24")
    expect(inRanges(at("::ffff:203.0.113.7"), v4)).toBe(true)
    expect(inRanges(at("::ffff:cb00:7107"), v4)).toBe(true)
    expect(inRanges(at("::ffff:203.0.114.7"), v4)).toBe(false)
  })

  it("never lets an IPv4 range match an IPv6 address, or the reverse", () => {
    expect(inRanges(at("2001:db8::1"), ranges("203.0.113.0/24"))).toBe(false)
    // The IPv6 address whose low 32 bits equal the IPv4 range, but not mapped.
    expect(inRanges(at("2001:db8::cb00:7107"), ranges("203.0.113.0/24"))).toBe(false)
    expect(inRanges(at("203.0.113.7"), ranges("2001:db8::/32"))).toBe(false)
    expect(inRanges(at("::ffff:203.0.113.7"), ranges("::/96"))).toBe(false)
  })

  it("formats an address the way the audit log and the grace compare it", () => {
    expect(formatAddress(at("::ffff:203.0.113.7"))).toBe("203.0.113.7")
    expect(formatAddress(at("2001:0DB8:0:0:0:0:0:1"))).toBe("2001:db8::1")
  })

  it("drops a stored range that does not parse instead of widening it", () => {
    expect(readRanges(["203.0.113.0/24", "garbage", "0.0.0.0/0"])).toHaveLength(1)
  })
})

describe("the address a request came from", () => {
  const SECRET = "context-secret-for-tests"
  const headers = (init: Record<string, string>) => new Headers(init)

  it("is the signed context's, ahead of any header", () => {
    const signed = signClientContext({ ip: "203.0.113.7", ts: Date.now() }, SECRET)
    const a = clientAddress(
      headers({
        "x-i10-client": signed,
        "cf-connecting-ip": "198.51.100.1",
        ...EDGE_PROOF,
      }),
      SECRET,
      EDGE_SECRET,
    )
    expect(a && formatAddress(a)).toBe("203.0.113.7")
  })

  it("is Cloudflare's header when nothing is signed", () => {
    const a = clientAddress(
      headers({ "cf-connecting-ip": "198.51.100.1", ...EDGE_PROOF }),
      SECRET,
      EDGE_SECRET,
    )
    expect(a && formatAddress(a)).toBe("198.51.100.1")
  })

  it("is never x-forwarded-for, whoever sets it", () => {
    expect(
      clientAddress(headers({ "x-forwarded-for": "203.0.113.7" }), SECRET, EDGE_SECRET),
    ).toBeNull()
    expect(
      clientAddress(
        headers({
          "x-forwarded-for": "203.0.113.7",
          "cf-connecting-ip": "198.51.100.1",
          ...EDGE_PROOF,
        }),
        SECRET,
        EDGE_SECRET,
      ),
    ).toMatchObject({ family: 4 })
    const a = clientAddress(
      headers({
        "x-forwarded-for": "203.0.113.7",
        "cf-connecting-ip": "198.51.100.1",
        ...EDGE_PROOF,
      }),
      SECRET,
      EDGE_SECRET,
    )
    expect(a && formatAddress(a)).toBe("198.51.100.1")
  })

  it("ignores a forged context signature and falls back to Cloudflare's", () => {
    const forged = signClientContext(
      { ip: "203.0.113.7", ts: Date.now() },
      "other-secret",
    )
    const a = clientAddress(
      headers({
        "x-i10-client": forged,
        "cf-connecting-ip": "198.51.100.1",
        ...EDGE_PROOF,
      }),
      SECRET,
      EDGE_SECRET,
    )
    expect(a && formatAddress(a)).toBe("198.51.100.1")
  })

  it("is unknown when there is nothing to trust, or it does not parse", () => {
    expect(clientAddress(headers({}), SECRET, EDGE_SECRET)).toBeNull()
    expect(
      clientAddress(
        headers({ "cf-connecting-ip": "not-an-ip", ...EDGE_PROOF }),
        SECRET,
        EDGE_SECRET,
      ),
    ).toBeNull()
    expect(
      clientAddress(
        headers({ "cf-connecting-ip": "fe80::1%eth0", ...EDGE_PROOF }),
        SECRET,
        EDGE_SECRET,
      ),
    ).toBeNull()
  })

  it("is unknown when Cloudflare's header comes without the edge proof", () => {
    const forged = { "cf-connecting-ip": "198.51.100.1" }
    expect(clientAddress(headers(forged), SECRET, EDGE_SECRET)).toBeNull()
    expect(
      clientAddress(headers({ ...forged, "x-i10-edge": "wrong" }), SECRET, EDGE_SECRET),
    ).toBeNull()
    // No secret configured: nothing can be proven, so nothing is believed.
    expect(
      clientAddress(headers({ ...forged, ...EDGE_PROOF }), SECRET, undefined),
    ).toBeNull()
  })
})
