import { describe, expect, it } from "bun:test"
import { domainProblem, isDomainMalformed } from "../lib/domain-check"

/**
 * What counts as a domain, and what to say when it is not one.
 *
 * ⚠ THIS FILE USED TO TEST THE TIMING AS WELL — when red appears, when green
 * is earned — and that half has moved to packages/ui/test/validated-field.
 * The rules are the same for every field in the product, so testing them here
 * meant a second copy that could pass while the shared one regressed. What is
 * left is the part that is genuinely about domains.
 *
 * ⚠ AND THE VALUES BELOW ARE THINGS PEOPLE ACTUALLY TYPE INTO THIS BOX, not
 * adversarial strings. A pasted address bar, an email address, a bare name
 * with no dot: those are the wrong answers worth having a sentence for, and
 * the test asserts the SENTENCE, because a correct verdict with a useless
 * message leaves somebody exactly as stuck.
 */

describe("a domain that is wrong on its face", () => {
  /*
   * ⚠ EACH WRONG ANSWER GETS ITS OWN CORRECTION. "That does not look like a
   * domain" is true of all of these and useful for none — the point of
   * checking them separately is that the sentence names the actual mistake.
   */
  it.each([
    ["https://acme.com/pricing", "Just the domain — no https:// in front."],
    ["http://acme.com", "Just the domain — no https:// in front."],
    ["//acme.com", "Just the domain — no https:// in front."],
    ["mido@acme.com", "That is an email address. Enter the domain after the @."],
    ["acme.com/pricing", "Just the domain — leave off the path."],
    ["acme com", "A domain cannot contain spaces."],
    ["acme_mail.com", "Domain names cannot contain underscores."],
    ["acme", "A domain needs a dot, like example.com."],
    ["acme..com", "That does not look like a domain — check the dots."],
    [".acme.com", "That does not look like a domain — check the dots."],
    ["-acme.com", "That does not look like a domain."],
    ["acme-.com", "That does not look like a domain."],
    ["acme.123", "That does not end in a domain ending, like .com."],
    ["192.168.1.1", "That does not end in a domain ending, like .com."],
    ["acme.c", "That does not end in a domain ending, like .com."],
  ])("refuses %p", (value, message) => {
    expect(domainProblem(value)).toBe(message)
  })

  it("refuses a name longer than the wire format allows", () => {
    // ⚠ EVERY LABEL IS LEGAL ON ITS OWN — 63 octets is the per-label maximum —
    // so this can only fail the 253-octet limit on the WHOLE name, which is the
    // rule being tested. A fixture with an over-long label would pass for the
    // wrong reason.
    const label = "a".repeat(63)
    const tooLong = `${label}.${label}.${label}.${label}.com`
    expect(domainProblem(tooLong)).toBe("That domain is too long.")
  })
})

describe("a domain that is fine", () => {
  it.each([
    "acme.com",
    "mail.acme.com",
    "ACME.COM",
    "  acme.com  ",
    // ⚠ THE FULLY-QUALIFIED FORM IS NOT A MISTAKE. It is what a resolver prints
    // and what anybody who has read a zone file types.
    "acme.com.",
    // ⚠ A LEADING DIGIT IS LEGAL under RFC 1123 and was illegal under RFC 952;
    // a validator written from the older rule refuses real domains.
    "4chan.org",
    "x.co",
    "a-b.example.co.uk",
    // Punycode: the A-label starts with letters, so a TLD rule of "letters
    // only" accepts it without knowing what an IDN is.
    "xn--80ak6aa92e.com",
  ])("accepts %p", (value) => {
    expect(domainProblem(value)).toBeNull()
  })
})

describe("what the nameserver lookup asks", () => {
  /*
   * ⚠ THE LOOKUP GATE AND THE BORDER HAVE TO AGREE, and they did not once. The
   * gate was its own looser regex, so `acme.c` was looked up and the form
   * reported "DNS hosted by Cloudflare" under a name it was about to call
   * malformed.
   */
  it("does not call an empty box malformed", () => {
    expect(isDomainMalformed("")).toBe(false)
    expect(isDomainMalformed("   ")).toBe(false)
  })

  it("agrees with the rule about a half-typed name", () => {
    expect(isDomainMalformed("acme.c")).toBe(true)
    expect(domainProblem("acme.c")).not.toBeNull()
  })

  it("agrees with the rule about a good name", () => {
    expect(isDomainMalformed("acme.com")).toBe(false)
    expect(domainProblem("acme.com")).toBeNull()
  })
})
