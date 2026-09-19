import { describe, expect, it } from "bun:test"
import { fieldVerdict } from "@repo/ui/components/validated-field"
import type { PasswordRules } from "../app/_lib/environment"
import { describeRules, isPasswordUsable, passwordProblem } from "../app/_lib/validate"

/**
 * The password policy, and the one thing about it that is not shared.
 *
 * ⚠ THE EMAIL HALF OF THIS FILE HAS MOVED TO packages/ui/test, along with the
 * rule itself. It was here because the auth app was the only thing that
 * checked an address; the console asks for them too and checked nothing, so
 * one copy now serves both. What is left is genuinely local: a password policy
 * is a property of the Clerk INSTANCE, read at runtime, and no other app has
 * one.
 *
 * ⚠ AND THE TIMING IS STILL ASSERTED HERE, THROUGH THE SHARED `fieldVerdict`.
 * The password field is the only one in the product that says something while
 * somebody is still typing — see `early` — so "when" is not purely generic for
 * this rule and is worth pinning next to it.
 */

const rules: PasswordRules = {
  minLength: 8,
  maxLength: 0,
  requireLowercase: false,
  requireUppercase: false,
  requireNumbers: false,
  requireSpecial: false,
}

/** The four moments a field can be judged in. */
const typing = { blurred: false, submitted: false, recovering: false }
const left = { blurred: true, submitted: false, recovering: false }
const refused = { blurred: true, submitted: true, recovering: false }
const fixing = { blurred: false, submitted: false, recovering: true }

const tooShort = "abcd"
const longEnough = "abcdefgh"
const withDigit = "abcdefg1"
const withSymbol = "abcdefg1!"

const field = { check: passwordProblem(rules), required: "Choose a password." }

describe("a password", () => {
  it("says nothing about an empty box somebody has merely tabbed through", () => {
    expect(fieldVerdict("", left, field)).toEqual({ state: "idle" })
  })

  it("asks for an empty box only once a submit has been refused", () => {
    expect(fieldVerdict("", refused, field)).toMatchObject({ state: "invalid" })
  })

  /*
   * ⚠ THE COUNT IS A PROGRESS INDICATOR, NOT A COMPLAINT, so it shows from the
   * first character while the BORDER waits. "4 of 8" is useful on every
   * keystroke; a red box around it is not. This is what `early` is for, and it
   * is the only rule in the product that uses it.
   */
  it("counts up while typing without turning red", () => {
    expect(fieldVerdict(tooShort, typing, field)).toEqual({
      state: "idle",
      hint: "4 of 8 characters.",
    })
  })

  it("turns red on the same message once the caret has left", () => {
    expect(fieldVerdict(tooShort, left, field)).toEqual({
      state: "invalid",
      hint: "4 of 8 characters.",
    })
  })

  it("accepts anything meeting the instance's own minimum, without going green", () => {
    expect(fieldVerdict(longEnough, left, field)).toEqual({ state: "idle" })
  })

  it("goes green once a rejected password has been made long enough", () => {
    expect(fieldVerdict(longEnough, fixing, field)).toEqual({ state: "valid" })
  })

  /*
   * ⚠ A CLASS RULE IS **NOT** EARLY, which is the other half of the same
   * decision. "Add a number." on the second character is an argument with
   * somebody who has not finished writing their password.
   */
  it("keeps quiet about a missing character class while typing", () => {
    const strict = { check: passwordProblem({ ...rules, requireNumbers: true }) }
    expect(fieldVerdict(longEnough, typing, strict)).toEqual({ state: "idle" })
    expect(fieldVerdict(longEnough, left, strict)).toEqual({
      state: "invalid",
      hint: "Add a number.",
    })
  })

  /*
   * ⚠ THE RULES COME FROM CLERK AND ARE NEVER WRITTEN DOWN IN THE APP. These
   * assert that turning a requirement on in the Clerk dashboard reaches the
   * hint and the border with no deploy — which is the whole reason
   * `passwordRules()` reads the environment document instead of a constant.
   */
  it("names one unmet requirement at a time, in order", () => {
    const strict: PasswordRules = {
      ...rules,
      requireNumbers: true,
      requireSpecial: true,
    }
    const check = passwordProblem(strict)
    expect(check(longEnough)).toBe("Add a number.")
    expect(check(withDigit)).toBe("Add a symbol.")
    expect(check(withSymbol)).toBeNull()
    expect(isPasswordUsable(withSymbol, strict)).toBe(true)
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
