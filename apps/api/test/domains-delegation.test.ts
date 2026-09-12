import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "bun:test"
import {
  delegatedZoneNames,
  delegatedZones,
  delegationRecordsFor,
} from "../src/domains/zone.js"
import {
  clearRecordsStatement,
  insertRecordsStatement,
  upsertZoneStatement,
} from "../src/domains/powerdns.js"

const NS = ["ns1.i10.tech", "ns2.i10.tech"]
const dialect = new PgDialect()

const zones = (dkim: [string, string] | null = ["i10abc", "PUBLICKEY"]) =>
  delegatedZones({
    domain: "example.com",
    mailFromSubdomain: "send",
    bounceSubdomain: "bounce",
    bounceHost: "mx.i10.tech",
    region: "eu-central-1",
    dkimSelector: dkim?.[0] ?? null,
    dkimPublicKey: dkim?.[1] ?? null,
    spfInclude: "_spf.i10.tech",
    nameservers: NS,
  })

const zone = (name: string) => zones().find((z) => z.name === name)

describe("what the customer delegates", () => {
  /**
   * ⚠ THREE SUBDOMAINS, NEVER THE APEX. Taking the whole zone would make i10
   * responsible for their website and their inbound MX — a bad day for our
   * nameserver would take their marketing site down, not just their mail.
   */
  it("is three subdomains and nothing above them", () => {
    expect(delegatedZoneNames("example.com")).toEqual({
      dkim: "_domainkey.example.com",
      mail: "mail.example.com",
      dmarc: "_dmarc.example.com",
    })
    expect(zones().map((z) => z.name)).not.toContain("example.com")
  })

  it("asks for one NS record set per zone", () => {
    const records = delegationRecordsFor("example.com", NS, "pending")
    expect(records).toHaveLength(6)
    expect(records.every((r) => r.type === "NS")).toBe(true)
    expect(new Set(records.map((r) => r.name)).size).toBe(3)
  })
})

describe("the zones we then serve", () => {
  // Every zone needs its own SOA and its own NS set, or a resolver treats the
  // delegation as broken rather than empty.
  it("gives each zone an SOA and its nameservers", () => {
    for (const z of zones()) {
      expect(z.records.filter((r) => r.type === "SOA")).toHaveLength(1)
      expect(z.records.filter((r) => r.type === "NS")).toHaveLength(NS.length)
    }
  })

  /**
   * ⚠ THE RETURN PATHS MOVE UNDER `mail.`, WHICH IS WHY ONLY THREE NS SETS ARE
   * NEEDED. Delegating `send.` and `bounce.` separately would be two more
   * record sets for the customer to add and two more chances to add one wrong.
   */
  it("serves both return paths inside the mail zone", () => {
    const mail = zone("mail.example.com")!
    expect(mail.records.find((r) => r.name === "send.mail.example.com")).toMatchObject({
      type: "MX",
      content: "feedback-smtp.eu-central-1.amazonses.com",
    })
    expect(
      mail.records.find((r) => r.name === "bounce.mail.example.com" && r.type === "MX"),
    ).toMatchObject({ content: "mx.i10.tech" })
  })

  // ⚠ Still no cross-authorisation: each path names only its own sender.
  it("keeps the two SPF records apart", () => {
    const mail = zone("mail.example.com")!
    const ses = mail.records.find(
      (r) => r.name === "send.mail.example.com" && r.type === "TXT",
    )
    const direct = mail.records.find(
      (r) => r.name === "bounce.mail.example.com" && r.type === "TXT",
    )
    expect(ses?.content).toBe("v=spf1 include:amazonses.com ~all")
    expect(direct?.content).toBe("v=spf1 include:_spf.i10.tech ~all")
  })

  it("puts the DKIM key in its own zone", () => {
    const dkim = zone("_domainkey.example.com")!
    expect(
      dkim.records.find((r) => r.name === "i10abc._domainkey.example.com"),
    ).toMatchObject({ type: "TXT" })
  })

  /**
   * ⚠ ABSENT, NOT EMPTY. A zone that answers NOERROR with no TXT reads to a
   * verifier as "published but malformed" — a permanent failure — where an
   * absent name reads as "not yet".
   */
  it("omits the DKIM record until the key exists", () => {
    const dkim = delegatedZones({
      domain: "example.com",
      mailFromSubdomain: "send",
      bounceSubdomain: "bounce",
      bounceHost: "mx.i10.tech",
      region: "eu-central-1",
      dkimSelector: null,
      dkimPublicKey: null,
      spfInclude: "_spf.i10.tech",
      nameservers: NS,
    }).find((z) => z.name === "_domainkey.example.com")!

    expect(dkim.records.every((r) => r.type !== "TXT")).toBe(true)
  })
})

describe("the PowerDNS statements", () => {
  /**
   * ⚠ POWERDNS'S TABLES CARRY `CHECK (name = LOWER(name))`. A mixed-case domain
   * — which a customer will paste — is a constraint violation at insert rather
   * than a zone that quietly fails to match queries.
   */
  it("lowercases every name it writes", () => {
    const { params } = dialect.sqlToQuery(upsertZoneStatement("Mail.EXAMPLE.com"))
    expect(params).toContain("mail.example.com")
  })

  // ⚠ `NATIVE`, not `MASTER`: with one server and no AXFR there is nobody to
  // notify, and the failed attempts look like a fault in the log.
  it("creates native zones", () => {
    expect(
      dialect.sqlToQuery(upsertZoneStatement("mail.example.com")).params,
    ).toContain("NATIVE")
  })

  // Replacing a zone wholesale is the only way removal works at all; a diff
  // would have to decide what "the same record" means when the value changed.
  it("clears the zone before inserting", () => {
    const { sql: statement } = dialect.sqlToQuery(
      clearRecordsStatement("mail.example.com"),
    )
    expect(statement).toContain("delete from pdns.records")
    expect(statement).toContain("domain_id = (select id from pdns.domains")
  })

  it("writes MX priority into its own column", () => {
    const { sql: statement } = dialect.sqlToQuery(
      insertRecordsStatement(1, [
        {
          name: "a.example.com",
          type: "MX",
          content: "mx.i10.tech",
          ttl: 300,
          priority: 10,
        },
      ]),
    )
    expect(statement).toContain("prio")
  })
})
