import { describe, expect, it } from "bun:test"
import { domainVerdict, isDomainMalformed } from "../lib/domain-verdict"

/**
 * The rules the add-domain field colours its border by.
 *
 * ⚠ IT IS THE SAME FILE AS `apps/auth/test/validate.test.ts` IN SPIRIT AND FOR
 * THE SAME REASON: what these functions RETURN is easy and what they return
 * WHEN is where every previous version of this logic went wrong. Red on the
 * first keystroke, red on an untouched empty box, green on everything correct —
 * three bugs, none of them about whether a string is a domain.
 *
 * ⚠ AND THE VALUES BELOW ARE THINGS PEOPLE ACTUALLY TYPE INTO THIS BOX, not
 * adversarial strings. A pasted address bar, an email address, a bare name with
 * no dot: those are the four wrong answers worth having a sentence for, and the
 * test asserts the SENTENCE, because a correct verdict with a useless message
 * leaves somebody exactly as stuck.
 */

/**
 * The four moments a field can be judged in.
 *
 * ⚠ `fixing` IS THE ONLY ONE THAT EARNS GREEN — shown wrong at some point, and
 * the caret is back in it. See `recovering` in @repo/ui/hooks/field-focus.
 */
const typing = { blurred: false, submitted: false, recovering: false }
const left = { blurred: true, submitted: false, recovering: false }
const refused = { blurred: true, submitted: true, recovering: false }
const fixing = { blurred: false, submitted: false, recovering: true }

describe("a domain, while it is being typed", () => {
  /*
   * ⚠ THE HALF-TYPED CASES ARE THE POINT. Every one of these is malformed and
   * every one of them is somebody part-way through `acme.com`.
   */
  it.each(["a", "ac", "acme", "acme.", "acme.c"])(
    "says nothing about %p while the caret is still in the box",
    (value) => {
      expect(domainVerdict(value, typing)).toEqual({ state: "idle" })
    },
  )

  it("says nothing about an empty box somebody has merely tabbed through", () => {
    expect(domainVerdict("", left)).toEqual({ state: "idle" })
  })

  it("asks for an empty box only once the button has been pressed", () => {
    expect(domainVerdict("", refused)).toEqual({
      state: "invalid",
      hint: "Enter the domain you send from.",
    })
  })
})

describe("a domain that is wrong on its face", () => {
  /*
   * ⚠ EACH WRONG ANSWER GETS ITS OWN CORRECTION. "That does not look like a
   * domain" is true of all four of these and useful for none — the point of
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
  ])("refuses %p once the caret has left", (value, hint) => {
    expect(domainVerdict(value, left)).toEqual({ state: "invalid", hint })
  })

  it("refuses a name longer than the wire format allows", () => {
    // ⚠ EVERY LABEL IS LEGAL ON ITS OWN — 63 octets is the per-label maximum —
    // so this can only fail the 253-octet limit on the WHOLE name, which is the
    // rule being tested. A fixture with an over-long label would pass for the
    // wrong reason.
    const label = "a".repeat(63)
    const tooLong = `${label}.${label}.${label}.${label}.com`
    expect(domainVerdict(tooLong, left)).toEqual({
      state: "invalid",
      hint: "That domain is too long.",
    })
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
    expect(domainVerdict(value, left)).toEqual({ state: "idle" })
  })

  /*
   * ⚠ CORRECT IS NOT GREEN. Most domains are typed correctly first time, and a
   * receipt for that is the "green on everything" problem which costs the one
   * colour in a monochrome console that means "resolved".
   */
  it("does not congratulate a domain that was never wrong", () => {
    expect(domainVerdict("acme.com", left)).toEqual({ state: "idle" })
  })

  it("goes green only for a domain that was shown wrong and has been fixed", () => {
    expect(domainVerdict("acme.com", fixing)).toEqual({ state: "valid" })
  })
})

describe("what the submit guard asks", () => {
  /*
   * ⚠ EMPTY IS NOT MALFORMED, and the form depends on the difference: an empty
   * box must not arm the green that a corrected one does.
   */
  it("does not call an empty box malformed", () => {
    expect(isDomainMalformed("")).toBe(false)
    expect(isDomainMalformed("   ")).toBe(false)
  })

  it("calls a half-typed name malformed, whatever the border is showing", () => {
    expect(isDomainMalformed("acme")).toBe(true)
  })

  it("agrees with the verdict about a good name", () => {
    expect(isDomainMalformed("acme.com")).toBe(false)
  })
})
