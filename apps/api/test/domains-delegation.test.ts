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
const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
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
    claim: TOKEN,
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

  it("asks for one NS record set per zone and nothing else", () => {
    const records = delegationRecordsFor("example.com", NS, "pending", TOKEN)
    expect(records).toHaveLength(6)
    expect(records.every((r) => r.type === "NS")).toBe(true)
    expect(new Set(records.map((r) => r.name)).size).toBe(3)
  })

  /**
   * ⚠ THE NAMESERVER NAMES CARRY THE CLAIM, AND THAT IS WHAT RETIRED THE
   * SEVENTH RECORD. Every delegating customer used to publish the same
   * `ns1.i10.tech`, so the delegation established that SOMEBODY had delegated
   * the name and nothing about who — a stranger could add a domain, publish
   * nothing, and have the real owner's records resolve to the stranger's zone.
   * A challenge TXT record had to carry the identity the delegation could not.
   *
   * ⚠ NOW THE DELEGATION PROVES ITSELF. Only the holder of `example.com`'s DNS
   * can publish `<claim>.ns1.i10.tech`, and the label says whose claim it is —
   * the same property a manual domain's per-row DKIM selector always had, which
   * is why a manual domain never needed a challenge record either.
   */
  it("puts the claim in the nameserver names", () => {
    const records = delegationRecordsFor("example.com", NS, "pending", TOKEN)
    expect(records.map((r) => r.value)).toEqual([
      `${TOKEN}.ns1.i10.tech`,
      `${TOKEN}.ns2.i10.tech`,
      `${TOKEN}.ns1.i10.tech`,
      `${TOKEN}.ns2.i10.tech`,
      `${TOKEN}.ns1.i10.tech`,
      `${TOKEN}.ns2.i10.tech`,
    ])

    // ⚠ AND A BARE NAMESERVER NAME IS NEVER ASKED FOR. It would prove only that
    // somebody delegated to i10, which is the hole this closes.
    expect(records.some((r) => r.value === "ns1.i10.tech")).toBe(false)
  })

  /**
   * ⚠ THE ZONE'S OWN NS RECORDS MUST MATCH WHAT THE PARENT IS ASKED TO PUBLISH.
   * A child zone naming different nameservers than its parent is a lame
   * delegation: resolvers mostly tolerate it, some caches do not, and the
   * failure is intermittent and unattributable.
   */
  it("serves the same nameserver names it asks the customer to publish", () => {
    const asked = new Set(
      delegationRecordsFor("example.com", NS, "pending", TOKEN).map((r) => r.value),
    )
    for (const z of zones()) {
      const served = z.records.filter((r) => r.type === "NS").map((r) => r.content)
      expect(served.length).toBeGreaterThan(0)
      for (const ns of served) expect(asked.has(ns)).toBe(true)
    }
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
      claim: TOKEN,
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
