import { describe, expect, it } from "bun:test"
import { shorten } from "@/components/dns-records"

describe("shorten", () => {
  it("cuts only the long label of a hostname", () => {
    expect(shorten("8bee581b1cab454596b1e5f58b3cbca5.ns1.i10.tech")).toEqual([
      "8bee58",
      "ca5.ns1.i10.tech",
    ])
  })

  it("keeps what comes before the long label", () => {
    expect(shorten("i10ac452d807517abcdef._domainkey.acme.com")).toEqual([
      "i10ac4",
      "def._domainkey.acme.com",
    ])
  })

  it("leaves short values alone", () => {
    expect(shorten("send.acme.com")).toBeNull()
    expect(shorten("v=spf1 include:amazonses.com ~all")).toBeNull()
  })

  it("keeps a DKIM record's tags and the start of its key", () => {
    const key = `v=DKIM1; k=rsa; p=MIIBIjAN${"A".repeat(200)}IDAQAB`
    expect(shorten(key)).toEqual(["v=DKIM1; k=rsa; p=MIIBIjAN", key.slice(-13)])
  })

  it("leaves a DMARC line that fits alone", () => {
    expect(shorten("v=DMARC1; p=none; rua=mailto:dmarc@i10.tech")).toBeNull()
  })

  it("keeps the start and end of any other long value", () => {
    const long = "x".repeat(30) + "y".repeat(40)
    expect(shorten(long)).toEqual([long.slice(0, 14), long.slice(-13)])
  })

  it("drops a label's tail when tight, keeping the name after it", () => {
    expect(shorten("af716735bd944894a6d64b77c369ea1b.ns2.i10.tech", true)).toEqual([
      "af7",
      ".ns2.i10.tech",
    ])
  })
})
