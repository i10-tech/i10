import { describe, expect, it } from "vitest"
import { dnsRecordsFor } from "../src/domains/records.js"

/**
 * Every string here gets pasted into somebody's DNS provider by hand. A typo in
 * a hostname is a customer who cannot send and cannot see why, so these assert
 * the exact values rather than the shape.
 */
const PUBLIC_KEY = "MIIBIjANBgkq" + "A".repeat(380)

const records = (
  dkimSelector: string | null = "i10abc123",
  dkimPublicKey: string | null = PUBLIC_KEY,
) =>
  dnsRecordsFor({
    domain: "example.com",
    mailFromSubdomain: "send",
    bounceSubdomain: "bounce",
    bounceHost: "mx.i10.tech",
    region: "eu-central-1",
    dkimSelector,
    dkimPublicKey,
    spfInclude: "_spf.i10.tech",
    status: "pending",
  })

const find = (type: string, name: string) =>
  records().find((r) => r.type === type && r.name === name)

describe("the MAIL FROM records", () => {
  // ⚠ Without the MX, bounces go nowhere and SES refuses the identity.
  it("points the return path at the region's feedback host", () => {
    expect(find("MX", "send.example.com")).toMatchObject({
      record: "SPF",
      value: "feedback-smtp.eu-central-1.amazonses.com",
      priority: 10,
    })
  })

  /**
   * ⚠ `~all`, NOT `-all`. A hard fail rejects the customer's OWN mail from
   * their CRM, helpdesk or mail server the moment they publish this. Tightening
   * it is their decision once they know what else sends as them.
   */
  it("uses a soft fail", () => {
    const spf = find("TXT", "send.example.com")
    expect(spf?.value).toBe("v=spf1 include:amazonses.com ~all")
    expect(spf?.value).not.toContain("-all")
  })

  /**
   * ⚠ AN `include:`, NEVER AN `ip4:`. A literal address pins our infrastructure
   * into records we cannot edit — changing a relay would mean asking every
   * customer to re-publish, and the ones who did not would start failing SPF
   * with nothing to tell them why.
   */
  it("names our senders behind an include, not by address", () => {
    const spf = find("TXT", "bounce.example.com")
    expect(spf?.value).toBe("v=spf1 include:_spf.i10.tech ~all")
    expect(spf?.value).not.toMatch(/ip4:|ip6:/)
  })

  it("puts both on the return path, not on the apex", () => {
    for (const type of ["MX", "TXT"]) {
      expect(find(type, "send.example.com")).toBeDefined()
      expect(find(type, "example.com")).toBeUndefined()
    }
  })

  /**
   * ⚠ TWO RETURN PATHS, AND THIS IS WHAT MAKES DMARC PASS ON SPF WHATEVER SENT
   * THE MAIL. A name has one MX target and the two routes need different ones —
   * Amazon's feedback host for SES, ours for direct. Sharing one label would
   * mean one of the two routes bounces into the other's mailbox.
   */
  it("gives the direct route its own return path, pointed at us", () => {
    expect(find("MX", "bounce.example.com")).toMatchObject({
      value: "mx.i10.tech",
      priority: 10,
    })
    expect(find("MX", "send.example.com")?.value).toContain("amazonses.com")
  })

  // ⚠ Each path authorises only the sender that uses it. Listing both on both
  // lets each forge the other's bounces and spends SPF lookups for nothing.
  it("does not cross-authorise the two senders", () => {
    expect(find("TXT", "send.example.com")?.value).not.toContain("_spf.i10.tech")
    expect(find("TXT", "bounce.example.com")?.value).not.toContain("amazonses.com")
  })

  it("follows a custom return path", () => {
    const custom = dnsRecordsFor({
      domain: "example.com",
      mailFromSubdomain: "bounces",
      bounceSubdomain: "bounce",
      bounceHost: "mx.i10.tech",
      region: "eu-central-1",
      dkimSelector: null,
      dkimPublicKey: null,
      spfInclude: "_spf.i10.tech",
      status: "pending",
    })
    expect(custom.some((r) => r.name === "bounces.example.com")).toBe(true)
  })
})

describe("DKIM", () => {
  /**
   * ⚠ ONE TXT WITH OUR OWN PUBLIC KEY. Easy DKIM's three CNAMEs would put the
   * private half at Amazon, and only Amazon could then sign — which forecloses
   * routing a message through our own MTA. One key, both routes, one record the
   * customer publishes once.
   */
  it("is a single TXT holding our public key", () => {
    const dkim = records().filter((r) => r.record === "DKIM")
    expect(dkim).toHaveLength(1)
    expect(dkim[0]).toMatchObject({
      type: "TXT",
      name: "i10abc123._domainkey.example.com",
    })
    expect(dkim[0]?.value).toContain("v=DKIM1; k=rsa; p=")
    expect(dkim[0]?.value).not.toContain("amazonses.com")
  })

  /**
   * ⚠ A DNS CHARACTER-STRING CAPS AT 255 BYTES AND A 2048-BIT KEY IS LONGER.
   * Emitting one long unquoted string is the commonest way a DKIM record is
   * published broken — some providers split it, some truncate it, and the
   * failure is a signature that never verifies with no error anywhere.
   */
  it("splits a long key into quoted chunks", () => {
    const value = records().find((r) => r.record === "DKIM")?.value ?? ""
    expect(value.startsWith('"')).toBe(true)
    for (const chunk of value.split('" "')) {
      expect(chunk.replace(/"/g, "").length).toBeLessThanOrEqual(255)
    }
  })

  // ⚠ Before the key exists there is nothing to publish, and inventing a
  // placeholder record would have a customer publish DNS that can never verify.
  it("is absent until the key has been generated", () => {
    expect(records(null, null).some((r) => r.record === "DKIM")).toBe(false)
  })
})

describe("DMARC", () => {
  /**
   * ⚠ `p=none`. The large mailbox providers require a DMARC record to exist for
   * bulk senders, so a customer without one has a deliverability problem they
   * cannot see. `none` asks for nothing to be quarantined, which is the only
   * policy safe to hand somebody who has not yet found out what else sends as
   * their domain.
   */
  it("exists and quarantines nothing", () => {
    const dmarc = records().find((r) => r.record === "DMARC")
    expect(dmarc).toMatchObject({
      type: "TXT",
      name: "_dmarc.example.com",
      value: "v=DMARC1; p=none;",
    })
  })
})

describe("status", () => {
  // ⚠ SES verifies DKIM and MAIL FROM as units and reports no per-record
  // result, so a per-record status would be invented. Resend's shape has the
  // field; ours is honest about it being the same answer repeated.
  it("is the domain's, stamped on every record", () => {
    expect(records().every((r) => r.status === "pending")).toBe(true)
  })
})

/**
 * ⚠ THE CUSTOM MAIL FROM STAYS. An earlier draft proposed dropping it so that
 * one MX could serve both routes; it is not ours to drop. SES needs its own
 * feedback host there to accept the return path, so the SES route keeps these
 * records unchanged and DIRECT sends use i10's own bounce domain as the
 * envelope sender instead — which needs no record in the customer's DNS at all.
 * DMARC still passes on both routes, because BYODKIM aligns on the customer's
 * domain either way.
 */
describe("what the customer publishes, in total", () => {
  it("is six records and no more", () => {
    expect(records().map((r) => `${r.record}:${r.type}`)).toEqual([
      "SPF:MX",
      "SPF:TXT",
      "SPF:MX",
      "SPF:TXT",
      "DKIM:TXT",
      "DMARC:TXT",
    ])
  })

  // ⚠ AND NONE OF THEM CHANGES WITH THE ROUTE. That is the whole constraint:
  // the customer publishes once, and we decide per message whether the mail
  // leaves through SES or through our own MTA.
  it("names amazon only where SES must be named", () => {
    const amazon = records().filter((r) => r.value.includes("amazonses.com"))
    expect(amazon.map((r) => r.name)).toEqual(["send.example.com", "send.example.com"])
  })
})
