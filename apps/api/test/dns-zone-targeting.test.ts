import { describe, expect, it } from "bun:test"
import { failureFor, relativeName, zoneFor } from "../src/dns/port.js"

/**
 * Choosing which zone a record belongs in, and what to call it once there.
 *
 * ⚠ THESE THREE FUNCTIONS DECIDE WHERE SOMEBODY ELSE'S DNS GETS WRITTEN, which
 * makes them the highest-consequence pure code in the product. Every failure
 * here is silent: the request succeeds, the provider is happy, and the record
 * simply exists somewhere that resolves for nobody — discovered days later as
 * "delegation did nothing".
 */

const zones = (...names: string[]) => names.map((name) => ({ id: `id-${name}`, name }))

describe("picking the zone a record belongs in", () => {
  /**
   * ⚠ THE LONGEST SUFFIX, NOT THE FIRST MATCH. An account can hold both
   * `example.com` and `mail.example.com` as separate zones, and our own
   * delegation puts records at `send.mail.example.com` — which belongs in the
   * second. Picking the first would write it into the parent, where it is inert
   * and looks published.
   */
  it("picks the most specific zone when several match", () => {
    const all = zones("example.com", "mail.example.com")
    expect(zoneFor(all, "send.mail.example.com")?.name).toBe("mail.example.com")
    expect(zoneFor(all, "_dmarc.example.com")?.name).toBe("example.com")
  })

  it("does not care what order the provider listed them in", () => {
    const forwards = zoneFor(
      zones("example.com", "mail.example.com"),
      "x.mail.example.com",
    )
    const backwards = zoneFor(
      zones("mail.example.com", "example.com"),
      "x.mail.example.com",
    )
    expect(forwards?.name).toBe("mail.example.com")
    expect(backwards?.name).toBe("mail.example.com")
  })

  /**
   * ⚠ A LABEL BOUNDARY, NOT `endsWith`. `notexample.com` ends with
   * `example.com` and belongs to somebody else entirely. Writing a customer's
   * DKIM key into a stranger's zone because of a string comparison is the worst
   * outcome this file exists to prevent.
   */
  it("refuses a zone that is only a string suffix", () => {
    expect(zoneFor(zones("example.com"), "notexample.com")).toBe(null)
    expect(zoneFor(zones("example.com"), "myexample.com")).toBe(null)
  })

  it("matches the apex itself", () => {
    expect(zoneFor(zones("example.com"), "example.com")?.name).toBe("example.com")
  })

  it("answers null when the credential cannot reach the domain", () => {
    expect(zoneFor(zones("other.com"), "example.com")).toBe(null)
    expect(zoneFor([], "example.com")).toBe(null)
  })

  it("ignores case and a trailing dot on either side", () => {
    expect(zoneFor(zones("Example.COM"), "MAIL.example.com.")?.name).toBe("Example.COM")
  })
})

describe("naming a record relative to its zone", () => {
  /**
   * ⚠ THE APEX IS `@`, NEVER AN EMPTY STRING. Some providers accept "" as a
   * literal label and create a record at `.example.com`, which resolves for
   * nobody and reports success.
   */
  it("calls the apex @", () => {
    expect(relativeName("example.com", "example.com")).toBe("@")
    expect(relativeName("EXAMPLE.com.", "example.com")).toBe("@")
  })

  it("strips the zone from a subdomain", () => {
    expect(relativeName("send.mail.example.com", "example.com")).toBe("send.mail")
    expect(relativeName("_dmarc.example.com", "example.com")).toBe("_dmarc")
  })

  it("leaves a name that is not inside the zone alone", () => {
    expect(relativeName("elsewhere.net", "example.com")).toBe("elsewhere.net")
  })
})

describe("whose fault a provider's refusal is", () => {
  /**
   * ⚠ THE DISTINCTION DRIVES A DIFFERENT DIALOG, and collapsing it sends
   * everybody to reconnect — including the people for whom reconnecting will
   * produce the identical failure, because their token is alive and simply
   * lacks the scope.
   */
  it("separates reconnect from re-scope from retry", () => {
    expect(failureFor(401)).toBe("unauthorized")
    expect(failureFor(403)).toBe("forbidden")
    expect(failureFor(404)).toBe("not_found")
    expect(failureFor(429)).toBe("unavailable")
    expect(failureFor(500)).toBe("unavailable")
    expect(failureFor(502)).toBe("unavailable")
  })
})
