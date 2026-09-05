import { describe, expect, it } from "vitest"
import { dnsRecordsFor } from "../src/domains/records.js"

/**
 * Every string here gets pasted into somebody's DNS provider by hand. A typo in
 * a hostname is a customer who cannot send and cannot see why, so these assert
 * the exact values rather than the shape.
 */
const records = (dkimTokens: string[] = ["aaa", "bbb", "ccc"]) =>
  dnsRecordsFor({
    domain: "example.com",
    mailFromSubdomain: "send",
    region: "eu-central-1",
    dkimTokens,
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

  it("puts both on the return path, not on the apex", () => {
    for (const type of ["MX", "TXT"]) {
      expect(find(type, "send.example.com")).toBeDefined()
      expect(find(type, "example.com")).toBeUndefined()
    }
  })

  it("follows a custom return path", () => {
    const custom = dnsRecordsFor({
      domain: "example.com",
      mailFromSubdomain: "bounces",
      region: "eu-central-1",
      dkimTokens: [],
      status: "pending",
    })
    expect(custom.some((r) => r.name === "bounces.example.com")).toBe(true)
  })
})

describe("DKIM", () => {
  it("is one CNAME per token, pointing at Amazon", () => {
    const dkim = records().filter((r) => r.record === "DKIM")
    expect(dkim).toHaveLength(3)
    expect(dkim[0]).toMatchObject({
      type: "CNAME",
      name: "aaa._domainkey.example.com",
      value: "aaa.dkim.amazonses.com",
    })
  })

  // ⚠ Before the identity exists there are no tokens, and inventing placeholder
  // records would have a customer publish DNS that can never verify.
  it("is absent until the identity has been created", () => {
    expect(records([]).some((r) => r.record === "DKIM")).toBe(false)
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
