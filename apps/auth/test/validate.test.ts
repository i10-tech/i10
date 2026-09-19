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
 * ⚠ THIS FILE EXISTS BECAUSE THE SAME LOGIC HAS BEEN WRONG THREE TIMES AND
 * EVERY ONE OF THEM WAS REPORTED BY SOMEBODY USING THE PRODUCT RATHER THAN
 * CAUGHT HERE. It went red on every keystroke, so a field was red for the whole
 * time anybody was filling it in. Then it went red on blur, so tabbing past a
 * box nobody had answered yet told them off for looking. Then it went green on
 * everything correct, which is most of a form, so the colour meant nothing.
 *
 * None of those are bugs in what the functions RETURN — every one of them is a
 * bug in WHEN. That is what this file pins down, and it is why the fixtures
 * below are named for moments rather than for values.
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

/**
 * The four states a field can be judged in.
 *
 * ⚠ `fixing` IS THE ONE THAT EARNS GREEN: it has been shown wrong at some point
 * and the caret is back in it. Nothing else does — see `recovering` in
 * _lib/field-state.ts for why a correct value on its own is not news.
 */
const typing = { blurred: false, submitted: false, recovering: false }
const left = { blurred: true, submitted: false, recovering: false }
const refused = { blurred: true, submitted: true, recovering: false }
const fixing = { blurred: false, submitted: false, recovering: true }

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

  /*
   * ⚠ THE GREEN RULES ARE THE SUBTLE ONES AND THEY ARE WHY THIS BLOCK EXISTS.
   * Green is spent on a recovery — this was shown wrong, and is not any more —
   * rather than issued as a receipt for typing correctly first time.
   */
  it("does not go green for an address that was right first time", () => {
    expect(emailVerdict("mohamed@i10.tech", typing)).toEqual({ state: "idle" })
    expect(emailVerdict("mohamed@i10.tech", left)).toEqual({ state: "idle" })
  })

  it("goes green once a rejected address has been corrected", () => {
    expect(emailVerdict("mohamed@i10.tech", fixing)).toEqual({ state: "valid" })
  })

  // ⚠ AND IT RETIRES WHEN THEY MOVE ON. `recovering` carries the focus
  // requirement, so this is what a corrected field looks like once left: plain.
  it("stops being green once the caret has moved on", () => {
    const moved = { ...fixing, recovering: false, blurred: true }
    expect(emailVerdict("mohamed@i10.tech", moved)).toEqual({ state: "idle" })
  })

  it("is still not green while the correction is itself malformed", () => {
    expect(emailVerdict("mido@", fixing)).toEqual({ state: "idle" })
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
    expect(emailVerdict("  mohamed@i10.tech  ", fixing)).toEqual({ state: "valid" })
    expect(emailVerdict("  mohamed@i10.tech  ", left)).toEqual({ state: "idle" })
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

  it("accepts anything meeting the instance's own minimum, without going green", () => {
    expect(passwordVerdict("abcdefgh", rules, left)).toEqual({ state: "idle" })
  })

  it("goes green once a rejected password has been made long enough", () => {
    expect(passwordVerdict("abcdefgh", rules, fixing)).toEqual({ state: "valid" })
  })

  /*
   * ⚠ THE RULES COME FROM CLERK AND ARE NEVER WRITTEN DOWN IN THE APP. These
   * two assert that turning a requirement on in the Clerk dashboard reaches the
   * hint and the border with no deploy — which is the whole reason
   * `passwordRules()` reads the environment document instead of a constant.
   */
  it("names one unmet requirement at a time, in order", () => {
    const strict: PasswordRules = {
      ...rules,
      requireNumbers: true,
      requireSpecial: true,
    }
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
