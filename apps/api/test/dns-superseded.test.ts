import { describe, expect, it } from "bun:test"
import { supersededBy } from "../src/dns/superseded.js"
import type { DesiredRecord } from "../src/dns/port.js"

/**
 * Recognising our own leftovers, and refusing to recognise anybody else's.
 *
 * ⚠ THE CASE THIS EXISTS FOR: a domain deleted in the console and added again
 * while the provider was still connected. Deleting here cannot reach into the
 * customer's zone, so the first set is still sitting there when the second is
 * published — six NS records at three delegated names, or two `v=DKIM1` TXT
 * records at one selector. Neither is untidy-but-working: both split
 * resolution and leave the domain pending with records that look perfect.
 *
 * ⚠ AND THE HALF OF THIS FILE THAT MATTERS MORE IS THE NEGATIVE HALF. Every
 * false positive here is a delete against somebody's live DNS, so the cases
 * below pin what must be LEFT ALONE just as hard as what must go.
 */

/** The adapters' own comparison, which every one of them spells the same. */
const sameValue = (type: string, stored: string, wanted: string) => {
  const norm = (v: string) =>
    v
      .trim()
      .replace(/^"(.*)"$/s, "$1")
      .replace(/\.$/, "")
  if (type === "TXT") return norm(stored) === norm(wanted)
  return norm(stored).toLowerCase() === norm(wanted).toLowerCase()
}

interface Row {
  name: string
  type: string
  value: string
}

const read = (record: Row) => record

const stale = (desired: DesiredRecord[], existing: Row[]) =>
  supersededBy(desired, existing, read, sameValue).map((r) => r.value)

const want = (over: Partial<DesiredRecord> = {}): DesiredRecord => ({
  name: "send.example.com",
  type: "NS",
  value: "ns3.i10.tech",
  ttl: 60,
  ...over,
})

describe("a previous delegation left in the zone", () => {
  it("finds the old nameservers we no longer serve from", () => {
    expect(
      stale(
        [want({ value: "ns3.i10.tech" }), want({ value: "ns4.i10.tech" })],
        [
          { name: "send.example.com", type: "NS", value: "ns1.i10.tech" },
          { name: "send.example.com", type: "NS", value: "ns2.i10.tech" },
        ],
      ),
    ).toEqual(["ns1.i10.tech", "ns2.i10.tech"])
  })

  /*
   * ⚠ THE ONES WE ARE ABOUT TO WRITE ARE NOT STALE. They are `unchanged`, and
   * deleting then recreating them would be a window — however short — where
   * the domain has no delegation at all.
   */
  it("leaves the records that are already correct", () => {
    expect(
      stale(
        [want({ value: "ns3.i10.tech" })],
        [{ name: "send.example.com", type: "NS", value: "ns3.i10.tech." }],
      ),
    ).toEqual([])
  })

  /*
   * ⚠ THE BLAST RADIUS IS THE NAMES WE PUBLISH TO AND NOTHING ELSE. A
   * customer delegating a subdomain of their own to another provider is
   * ordinary, and it is not at a name we are writing.
   */
  it("ignores a delegation at a name we are not publishing to", () => {
    expect(
      stale(
        [want()],
        [{ name: "internal.example.com", type: "NS", value: "ns1.i10.tech" }],
      ),
    ).toEqual([])
  })

  it("ignores somebody else's nameservers at a name we publish to", () => {
    expect(
      stale(
        [want()],
        [{ name: "send.example.com", type: "NS", value: "ns1.customer-dns.com" }],
      ),
    ).toEqual([])
  })
})

describe("a previous DKIM key at our own selector", () => {
  const dkim = (value: string): Row => ({
    name: "i10._domainkey.example.com",
    type: "TXT",
    value,
  })
  const desired = want({
    name: "i10._domainkey.example.com",
    type: "TXT",
    value: "v=DKIM1; k=rsa; p=NEWKEY",
  })

  /*
   * ⚠ THE MOST DAMAGING LEFTOVER IN THE PRODUCT. Two keys at one selector is
   * not "one of them wins" — SES signs with the key it issued and the
   * resolver answers with both, so verification fails against whichever
   * arrives first.
   */
  it("finds the key from the domain that was deleted", () => {
    expect(stale([desired], [dkim("v=DKIM1; k=rsa; p=OLDKEY")])).toEqual([
      "v=DKIM1; k=rsa; p=OLDKEY",
    ])
  })

  it("leaves a quoted copy of the key we are writing", () => {
    expect(stale([desired], [dkim('"v=DKIM1; k=rsa; p=NEWKEY"')])).toEqual([])
  })

  // ⚠ A VERIFICATION TOKEN AT THE SAME NAME IS NOT OURS TO REMOVE.
  it("leaves a TXT that is not a DKIM record", () => {
    expect(stale([desired], [dkim("google-site-verification=abc")])).toEqual([])
  })
})

describe("SPF, which is recognised by its include and nothing else", () => {
  const at = (value: string): Row => ({
    name: "send.example.com",
    type: "TXT",
    value,
  })
  const desired = want({
    name: "send.example.com",
    type: "TXT",
    value: "v=spf1 include:spf.i10.tech ~all",
  })

  it("finds an older SPF of ours at the same name", () => {
    expect(stale([desired], [at("v=spf1 include:spf.i10.tech -all")])).toEqual([
      "v=spf1 include:spf.i10.tech -all",
    ])
  })

  /*
   * ⚠ AND LEAVES THE CUSTOMER'S OWN. An SPF record naming their other senders
   * is theirs; it conflicts, and a human decides what happens to it.
   */
  it("leaves an SPF that does not include us", () => {
    expect(
      stale([desired], [at("v=spf1 include:_spf.google.com include:sendgrid.net ~all")]),
    ).toEqual([])
  })
})

describe("DMARC, where our shape and theirs are the same shape", () => {
  const at = (value: string): Row => ({
    name: "_dmarc.example.com",
    type: "TXT",
    value,
  })
  const desired = want({
    name: "_dmarc.example.com",
    type: "TXT",
    value: "v=DMARC1; p=none; rua=mailto:dmarc@i10.tech",
  })

  it("finds one reporting to the same place we report to", () => {
    expect(stale([desired], [at("v=DMARC1; p=quarantine; rua=mailto:x@i10.tech")])).toEqual(
      ["v=DMARC1; p=quarantine; rua=mailto:x@i10.tech"],
    )
  })

  /*
   * ⚠ THE ONE THAT WOULD HURT MOST. `v=DMARC1; p=reject` is a policy somebody
   * may have spent an afternoon arriving at, and the prefix alone proves
   * nothing about who wrote it. With no shared reporting address this is not
   * ours, so it takes the conflict path and a human is asked.
   */
  it("leaves a policy that reports somewhere else", () => {
    expect(
      stale([desired], [at("v=DMARC1; p=reject; rua=mailto:dmarc@acme.com")]),
    ).toEqual([])
  })

  it("leaves a policy with no reporting address at all", () => {
    expect(stale([desired], [at("v=DMARC1; p=reject")])).toEqual([])
  })
})

describe("the other record types", () => {
  it("finds a bounce CNAME pointing at an older host of ours", () => {
    expect(
      stale(
        [
          want({
            name: "bounce.example.com",
            type: "CNAME",
            value: "feedback.i10.tech",
          }),
        ],
        [{ name: "bounce.example.com", type: "CNAME", value: "bounce.i10.tech" }],
      ),
    ).toEqual(["bounce.i10.tech"])
  })

  it("finds an MX of ours whether or not the priority is folded in", () => {
    expect(
      stale(
        [want({ name: "send.example.com", type: "MX", value: "mx2.i10.tech" })],
        [{ name: "send.example.com", type: "MX", value: "10 mx1.i10.tech" }],
      ),
    ).toEqual(["10 mx1.i10.tech"])
  })

  /*
   * ⚠ A TWO-LABEL VALUE HAS NO PARENT WORTH COMPARING. `parentOf("acme.com")`
   * is `com`, and matching on that would call every record in every zone
   * ours.
   */
  it("never matches on a public suffix", () => {
    expect(
      stale(
        [want({ name: "send.example.com", type: "CNAME", value: "i10.tech" })],
        [{ name: "send.example.com", type: "CNAME", value: "acme.tech" }],
      ),
    ).toEqual([])
  })

  it("ignores a type we are not publishing at that name", () => {
    expect(
      stale([want()], [{ name: "send.example.com", type: "A", value: "1.2.3.4" }]),
    ).toEqual([])
  })
})
