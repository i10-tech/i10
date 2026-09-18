import { describe, expect, it } from "bun:test"
import { delegationChecker, type DelegationLookups } from "../src/console/delegation.js"

/**
 * Telling four indistinguishable failures apart.
 *
 * ⚠ THE WHOLE VALUE OF THIS MODULE IS THE CLASSIFICATION, and the classification
 * is what a person is shown as the reason nothing is working. Getting it wrong
 * is worse than not having it: "your records point somewhere else" shown to
 * somebody whose records are correct sends them to break the ones that work.
 *
 * ⚠ AND THE FINDING THAT MATTERS MOST IS THE ONE THAT BLAMES US.
 * `nameserver_silent` and `nameservers_answering: false` are how a deployment
 * with no authoritative DNS server stops presenting as the customer's problem.
 * That was the live state when this was written: `ns1.i10.tech` and
 * `ns2.i10.tech` resolve to Cloudflare's HTTP proxy addresses and answer
 * nothing on port 53, so every delegated domain was permanently unverifiable
 * while the console said "propagation can take up to 72 hours".
 */

const NS = ["ns1.i10.tech", "ns2.i10.tech"]

const missing = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" })
const servfail = () => Object.assign(new Error("servfail"), { code: "ESERVFAIL" })

const lookups = (over: Partial<DelegationLookups> = {}): DelegationLookups => ({
  nsOf: async () => NS,
  soaOf: async () => {},
  addressesOf: async () => ["203.0.113.1"],
  respondsAt: async () => true,
  ...over,
})

const check = (over: Partial<DelegationLookups> = {}) =>
  delegationChecker({ nameservers: NS, lookups: lookups(over) }).check("example.com")

describe("the three zones", () => {
  it("checks the names the customer was actually told to publish", async () => {
    const asked: string[] = []
    await check({
      nsOf: async (zone) => {
        asked.push(zone)
        return NS
      },
    })

    // ⚠ THE SAME NAMES `delegatedZoneNames` BUILDS THE RECORDS FROM. A check
    // against a different set would report a correct delegation as missing.
    expect(asked.sort()).toEqual([
      "_dmarc.example.com",
      "_domainkey.example.com",
      "mail.example.com",
    ])
  })

  it("reports a working delegation", async () => {
    const report = await check()
    expect(report.zones.every((z) => z.code === "ok")).toBe(true)
    expect(report.nameserversAnswering).toBe(true)
  })
})

describe("what each failure is called", () => {
  /** The ordinary state of somebody who added the domain a minute ago. */
  it("calls an absent NS record set `not_published`", async () => {
    const report = await check({
      nsOf: async () => {
        throw missing()
      },
    })
    expect(report.zones.map((z) => z.code)).toEqual([
      "not_published",
      "not_published",
      "not_published",
    ])
  })

  /**
   * ⚠ A FAILED LOOKUP IS NOT AN ANSWER ABOUT THE RECORDS. SERVFAIL at the
   * parent says our resolver had a bad time, not that the customer did
   * anything; reporting it as "not published" would tell somebody to go and
   * re-add records that are already there.
   */
  it("keeps a broken lookup separate from a missing record", async () => {
    const report = await check({
      nsOf: async () => {
        throw servfail()
      },
    })
    expect(report.zones.every((z) => z.code === "lookup_failed")).toBe(true)
  })

  it("spots a delegation pointing at somebody else", async () => {
    const report = await check({
      nsOf: async () => ["ns1.digitalocean.com", "ns2.digitalocean.com"],
    })

    const first = report.zones[0]!
    expect(first.code).toBe("delegated_elsewhere")
    expect(first.code === "delegated_elsewhere" && first.observed).toContain(
      "ns1.digitalocean.com",
    )
  })

  /**
   * ⚠ THE FINDING THIS MODULE WAS BUILT FOR. The NS records point at us and the
   * zone still does not resolve, which means the customer is finished and we
   * are not serving it. Nothing above DNS can see this: SES reports `pending`,
   * exactly as it does for a domain nobody has touched.
   */
  it("blames us when the delegation lands and the zone does not resolve", async () => {
    const report = await check({
      soaOf: async () => {
        throw servfail()
      },
    })
    expect(report.zones.every((z) => z.code === "nameserver_silent")).toBe(true)
  })
})

describe("whether our own nameservers are up", () => {
  /**
   * ⚠ THE PRODUCTION STATE WHEN THIS WAS WRITTEN. The hostnames resolve — to
   * Cloudflare's HTTP proxy — and nothing answers DNS at those addresses. A
   * checker that only looked at whether the names resolved would call this
   * healthy.
   */
  it("is false when the names resolve but nothing answers", async () => {
    const report = await check({ respondsAt: async () => false })
    expect(report.nameserversAnswering).toBe(false)
  })

  it("is false when the names do not resolve at all", async () => {
    const report = await check({
      addressesOf: async () => {
        throw missing()
      },
    })
    expect(report.nameserversAnswering).toBe(false)
  })

  /**
   * ⚠ ONE LIVE SERVER SERVES THE ZONE. Resolvers try every nameserver in a
   * delegation before giving up, so a single survivor is a redundancy problem
   * rather than an outage — and reporting it as "this is on us" would send
   * somebody chasing a fault while their domain verifies perfectly well.
   */
  it("is true when only one of them answers", async () => {
    const report = await check({
      respondsAt: async (_address, name) => name === "ns1.i10.tech",
    })
    expect(report.nameserversAnswering).toBe(true)
  })
})

describe("comparing nameserver names", () => {
  it("ignores a trailing dot and case", async () => {
    const report = await check({ nsOf: async () => ["NS1.I10.TECH.", "ns2.i10.tech."] })
    expect(report.zones.every((z) => z.code === "ok")).toBe(true)
  })

  /**
   * ⚠ `some`, NOT `every`. Somebody part-way through publishing has one of the
   * two in place; that is delegated to us and resolving, not a misconfiguration
   * worth a red box.
   */
  it("accepts a partial delegation to us", async () => {
    const report = await check({ nsOf: async () => ["ns1.i10.tech"] })
    expect(report.zones.every((z) => z.code === "ok")).toBe(true)
  })
})
