import { describe, expect, it } from "bun:test"
import type { PasswordRules } from "../app/_lib/environment"
import {
  describeRules,
  emailVerdict,
  isEmailUsable,
  isPasswordUsable,
  passwordVerdict,
} from "../app/_lib/validate"

/**
 * The rules the sign-up and sign-in forms colour their borders by.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE SAME LOGIC HAS BEEN WRONG TWICE, IN OPPOSITE
 * DIRECTIONS, AND BOTH TIMES IT WAS REPORTED BY SOMEBODY USING THE PRODUCT
 * RATHER THAN CAUGHT HERE. First it went red on every keystroke, so a field was
 * red for the whole time anybody was filling it in; then it went red on blur,
 * so tabbing past a box nobody had answered yet told them off for looking. The
 * rules are three lines of `if` and they are still easy to get wrong, because
 * what makes them right is WHEN they fire rather than what they return.
 *
 * ⚠ AND IT IS THE FIRST TEST IN THIS APP, WHICH IS WHY `test` AND `types` HAD TO
 * BE ADDED TO ITS package.json AND tsconfig. Everything else here is a React
 * component that needs a browser and a live Clerk instance to say anything; this
 * is the one piece of real logic that is a pure function, so it is the one piece
 * that can be pinned down cheaply.
 */

const rules: PasswordRules = {
  minLength: 8,
  maxLength: 0,
  requireSpecial: false,
  requireNumbers: false,
  requireUppercase: false,
  requireLowercase: false,
}

/** Untouched, mid-typing, left alone, and submitted-against. */
const typing = { blurred: false, submitted: false }
const left = { blurred: true, submitted: false }
const refused = { blurred: true, submitted: true }

describe("an email address", () => {
  /*
   * ⚠ THE EMPTY CASES ARE THE POINT OF THE FILE. "Not filled in yet" and "filled
   * in wrongly" are different states and only one of them is a mistake before
   * somebody presses the button.
   */
  it("says nothing about an empty box somebody has merely tabbed through", () => {
    expect(emailVerdict("", left)).toEqual({ state: "idle" })
  })

  it("says nothing about an empty box nobody has touched", () => {
    expect(emailVerdict("", typing)).toEqual({ state: "idle" })
  })

  it("asks for an empty box only once a submit has been refused", () => {
    expect(emailVerdict("", refused)).toMatchObject({ state: "invalid" })
  })

  // ⚠ EVERY ADDRESS IS INVALID WHILE IT IS BEING TYPED — `m`, `mi`, `mid` — so
  // a field that reddens on the first keystroke is red for the entire time
  // anybody is using it, and the colour stops carrying information.
  it("stays quiet about a malformed address while the caret is still in it", () => {
    expect(emailVerdict("mido@", typing)).toEqual({ state: "idle" })
  })

  it("refuses a malformed address once the caret has left", () => {
    expect(emailVerdict("mido@", left)).toMatchObject({ state: "invalid" })
  })

  // ⚠ GREEN IS NOT GATED THE SAME WAY, AND THE ASYMMETRY IS DELIBERATE. There is
  // no state in which "this is fine" is premature.
  it("confirms a valid address immediately, without waiting to be left", () => {
    expect(emailVerdict("mohamed@i10.tech", typing)).toEqual({ state: "valid" })
  })

  it("requires a dot in the domain, which `type=email` does not", () => {
    expect(isEmailUsable("mido@localhost")).toBe(false)
    expect(isEmailUsable("mido@i10.tech")).toBe(true)
  })

  it("accepts the shapes a stricter regex would wrongly refuse", () => {
    for (const address of [
      "mohamed+newsletter@i10.tech",
      "o'brien@example.co.uk",
      "a@b.technology",
      "first.last@mail.sub.example.com",
    ]) {
      expect(isEmailUsable(address)).toBe(true)
    }
  })

  it("trims before judging, so a pasted address with a trailing space passes", () => {
    expect(emailVerdict("  mohamed@i10.tech  ", typing)).toEqual({ state: "valid" })
  })
})

describe("a password", () => {
  it("says nothing about an empty box somebody has merely tabbed through", () => {
    expect(passwordVerdict("", rules, left)).toEqual({ state: "idle" })
  })

  it("asks for an empty box only once a submit has been refused", () => {
    expect(passwordVerdict("", rules, refused)).toMatchObject({ state: "invalid" })
  })

  /*
   * ⚠ THE COUNT IS A PROGRESS INDICATOR, NOT A COMPLAINT, so it shows from the
   * first character while the BORDER waits. "4 of 8" is useful on every
   * keystroke; a red box around it is not.
   */
  it("counts up while typing without turning red", () => {
    expect(passwordVerdict("abcd", rules, typing)).toEqual({
      state: "idle",
      hint: "4 of 8 characters.",
    })
  })

  it("turns red on the same message once the caret has left", () => {
    expect(passwordVerdict("abcd", rules, left)).toEqual({
      state: "invalid",
      hint: "4 of 8 characters.",
    })
  })

  it("accepts anything meeting the instance's own minimum", () => {
    expect(passwordVerdict("abcdefgh", rules, left)).toEqual({ state: "valid" })
  })

  /*
   * ⚠ THE RULES COME FROM CLERK AND ARE NEVER WRITTEN DOWN IN THE APP. These
   * two assert that turning a requirement on in the Clerk dashboard reaches the
   * hint and the border with no deploy — which is the whole reason
   * `passwordRules()` reads the environment document instead of a constant.
   */
  it("names one unmet requirement at a time, in order", () => {
    const strict: PasswordRules = { ...rules, requireNumbers: true, requireSpecial: true }
    expect(passwordVerdict("abcdefgh", strict, left)).toMatchObject({
      hint: "Add a number.",
    })
    expect(passwordVerdict("abcdefg1", strict, left)).toMatchObject({
      hint: "Add a symbol.",
    })
    expect(isPasswordUsable("abcdefg1!", strict)).toBe(true)
  })

  it("describes the instance's rules as one sentence", () => {
    expect(describeRules(rules)).toBe("At least 8 characters.")
    expect(describeRules({ ...rules, requireNumbers: true })).toBe(
      "At least 8 characters, including a number.",
    )
    expect(
      describeRules({ ...rules, requireNumbers: true, requireUppercase: true }),
    ).toBe("At least 8 characters, including a capital and a number.")
  })

  // ⚠ CLERK WRITES `0` FOR "NO MAXIMUM", NOT FOR "ZERO CHARACTERS". Reading it
  // literally would refuse every password on the instance.
  it("reads a maximum of 0 as no maximum at all", () => {
    expect(isPasswordUsable("a".repeat(200), rules)).toBe(true)
    expect(isPasswordUsable("a".repeat(200), { ...rules, maxLength: 64 })).toBe(false)
  })
})
