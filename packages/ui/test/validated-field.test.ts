import { describe, expect, it } from "bun:test"
import { emailProblem, httpsUrlProblem } from "../src/checks"
import { fieldBlocks, fieldVerdict } from "../src/components/validated-field"

/**
 * The rules every field in the product is judged by.
 *
 * ⚠ THESE USED TO BE TESTED TWICE, IN TWO APPS, AGAINST TWO COPIES OF THE SAME
 * LOGIC — apps/auth/test/validate.test.ts and apps/console/test/
 * domain-verdict.test.ts. Both were right and neither could keep the other
 * honest. This is the single copy, so a change to the timing rules breaks one
 * file rather than passing in one app and regressing in the other.
 *
 * ⚠ AND WHAT IS BEING ASSERTED IS **WHEN**, NOT WHETHER. Whether a string is an
 * email address is easy. Red on the first keystroke, red on an untouched empty
 * box, green on everything correct — three bugs, none of them about whether a
 * string is valid, all three shipped at some point.
 */

/** The four moments a field can be judged in. */
const typing = { blurred: false, submitted: false, recovering: false }
const left = { blurred: true, submitted: false, recovering: false }
const refused = { blurred: true, submitted: true, recovering: false }
const fixing = { blurred: false, submitted: false, recovering: true }

const rule = { check: emailProblem, required: "Enter your email address." }

describe("while somebody is typing", () => {
  /*
   * ⚠ THE HALF-TYPED CASES ARE THE POINT. Every one of these is wrong and every
   * one of them is somebody part-way through their own address.
   */
  it.each(["m", "mi", "mido", "mido@", "mido@acme"])(
    "says nothing about %p while the caret is still in the box",
    (value) => {
      expect(fieldVerdict(value, typing, rule)).toEqual({ state: "idle" })
    },
  )

  it("says nothing about an empty box somebody has merely tabbed through", () => {
    expect(fieldVerdict("", left, rule)).toEqual({ state: "idle" })
  })

  it("asks for an empty box only once the button has been pressed", () => {
    expect(fieldVerdict("", refused, rule)).toEqual({
      state: "invalid",
      hint: "Enter your email address.",
    })
  })

  // ⚠ A FIELD WITH NO `required` IS OPTIONAL, and pressing the button must not
  // redden it. This is most of the console: a description, a last name.
  it("leaves an optional empty box alone even after a refused submit", () => {
    expect(fieldVerdict("", refused, { check: emailProblem })).toEqual({
      state: "idle",
    })
  })
})

describe("once the caret has left", () => {
  it("refuses a malformed value and names the fix", () => {
    expect(fieldVerdict("mido@", left, rule)).toEqual({
      state: "invalid",
      hint: "That does not look like an email address.",
    })
  })

  it("names the missing @ rather than restating the rule", () => {
    expect(fieldVerdict("mido", left, rule)).toEqual({
      state: "invalid",
      hint: "An email address needs an @.",
    })
  })

  /*
   * ⚠ CORRECT IS NOT GREEN. Most fields are filled in correctly first time, and
   * a receipt for that is the "green on everything" problem which costs the one
   * colour in a monochrome console that means "resolved".
   */
  it("does not congratulate a value that was never wrong", () => {
    expect(fieldVerdict("mido@acme.com", left, rule)).toEqual({ state: "idle" })
  })

  it("goes green only for a value that was shown wrong and has been fixed", () => {
    expect(fieldVerdict("mido@acme.com", fixing, rule)).toEqual({ state: "valid" })
  })
})

describe("a problem that is worth saying early", () => {
  /*
   * ⚠ PROGRESS IS NOT A COMPLAINT. "6 of 8 characters" helps on every
   * keystroke; "needs a number" on the second character is an argument with
   * somebody who has not finished. `early` shows the sentence in the neutral
   * tone and still waits before reddening anything.
   */
  const counting = {
    check: (value: string) =>
      value.length < 8
        ? { message: `${value.length} of 8 characters.`, early: true }
        : null,
  }

  it("shows the message while typing, without the red", () => {
    expect(fieldVerdict("abc", typing, counting)).toEqual({
      state: "idle",
      hint: "3 of 8 characters.",
    })
  })

  it("reddens the same message once the caret leaves", () => {
    expect(fieldVerdict("abc", left, counting)).toEqual({
      state: "invalid",
      hint: "3 of 8 characters.",
    })
  })
})

describe("what the submit guard asks", () => {
  /*
   * ⚠ IT IS A SEPARATE QUESTION FROM THE BORDER, and the difference is the
   * whole reason both exist: a field can be blocking without showing anything
   * yet, which is exactly the state of every untouched box on a form somebody
   * has just pressed the button on.
   */
  it("blocks an empty required field", () => {
    expect(fieldBlocks("", rule)).toBe(true)
  })

  it("lets an empty optional field through", () => {
    expect(fieldBlocks("", { check: emailProblem })).toBe(false)
  })

  it("blocks a malformed value whatever the border is showing", () => {
    expect(fieldBlocks("mido@", rule)).toBe(true)
  })

  it("lets a good value through", () => {
    expect(fieldBlocks("mido@acme.com", rule)).toBe(false)
  })

  // ⚠ WHITESPACE IS EMPTY. Otherwise a space bar counts as an answer.
  it("treats a box of spaces as empty", () => {
    expect(fieldBlocks("   ", rule)).toBe(true)
  })
})

describe("the email rule", () => {
  it.each(["mido@acme.com", "a+b@acme.co.uk", "o'brien@acme.com", "MIDO@ACME.COM"])(
    "accepts %p",
    (value) => {
      expect(emailProblem(value)).toBeNull()
    },
  )

  /*
   * ⚠ `mido@localhost` IS A VALID ADDRESS AND IS STILL REFUSED. `type="email"`
   * accepts it because the HTML spec is written for intranets too; this is a
   * product that has to deliver to the address.
   */
  it.each(["mido@localhost", "mido@acme", "mido @acme.com", "@acme.com"])(
    "refuses %p",
    (value) => {
      expect(emailProblem(value)).not.toBeNull()
    },
  )
})

describe("the webhook URL rule", () => {
  it("accepts a public https endpoint", () => {
    expect(httpsUrlProblem("https://acme.com/hooks/i10")).toBeNull()
  })

  /*
   * ⚠ EACH WRONG ANSWER GETS ITS OWN CORRECTION. The form used to carry all of
   * this as a grey hint under a box that accepted anything — a rule written
   * down rather than applied.
   */
  it.each([
    ["http://acme.com/hooks", "Use https:// — we will not post over http."],
    ["acme.com/hooks", "Start with https://"],
    ["not a url", "That does not look like a URL."],
    [
      "https://localhost:3000/hooks",
      "We cannot reach localhost. Use a tunnel while developing.",
    ],
    ["https://internal/hooks", "That host is not publicly reachable."],
  ])("refuses %p", (value, message) => {
    expect(httpsUrlProblem(value)).toBe(message)
  })
})
