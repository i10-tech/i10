import type { FieldState } from "@repo/ui/components/floating-field"
import type { PasswordRules } from "./environment"

/**
 * Telling somebody their address is wrong before we spend a round trip finding
 * out.
 *
 * ⚠ THIS EXISTS BECAUSE THE FORM WAS ASKING CLERK QUESTIONS IT COULD ANSWER
 * ITSELF. Typing `mido@` and pressing Create account produced a spinner, a
 * network round trip, and a toast two seconds later saying the address was
 * invalid — for a string that could not possibly have been valid, decided by a
 * server on another continent. Worse, pressing the button with BOTH boxes empty
 * did the same thing. The check belongs where the answer already is.
 *
 * ⚠ AND IT IS NOT A SUBSTITUTE FOR THE SERVER'S ANSWER, WHICH IS WHY NOTHING
 * HERE IS CLEVER. Clerk still decides whether an address is deliverable, already
 * taken, or on a blocklist, and it is still the only thing that can. The job
 * here is narrower and completely reliable: refuse the strings that are wrong on
 * their face, so the round trip is spent on the questions only a server can
 * answer.
 */

export interface Verdict {
  state: FieldState
  hint?: string
}

/**
 * ⚠ A DOT IN THE DOMAIN IS REQUIRED, WHICH THE HTML5 SPEC'S OWN PATTERN DOES
 * NOT REQUIRE. `type="email"` deliberately accepts `mido@localhost`, because the
 * spec is written for intranets as well as the internet. This is a product whose
 * entire function is delivering mail to the address, so an address with no
 * public domain is one we would accept and then fail to reach.
 *
 * ⚠ AND IT IS DELIBERATELY LOOSE EVERYWHERE ELSE. Every regex that tries to
 * fully implement RFC 5322 rejects addresses that work — plus-tagging, apostrophes,
 * long TLDs, new gTLDs — and the cost of a false rejection here is somebody who
 * cannot sign up at all and has no way to argue. The rule is "has a local part,
 * one @, a domain with a dot, and a plausible TLD", and nothing beyond it.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[a-z]{2,}$/i

export function emailVerdict(
  value: string,
  /**
   * Whether a red border is allowed yet. See `useFieldFocus` in field-state.ts,
   * which is what every caller passes: wrong **and** not currently focused.
   *
   * ⚠ GREEN IS IMMEDIATE AND RED WAITS, AND THE ASYMMETRY IS THE WHOLE DESIGN.
   * Every address is invalid while it is being typed — `m`, `mi`, `mid` — so a
   * field that goes red on the first keystroke is a field that is red for the
   * entire time anybody is using it, and the colour stops meaning anything.
   * Confirming correctness the moment it is correct has no such problem: there
   * is no state where "this is fine" is premature.
   */
  show: boolean,
): Verdict {
  const trimmed = value.trim()
  if (trimmed === "")
    return show
      ? { state: "invalid", hint: "Enter your email address." }
      : { state: "idle" }
  if (EMAIL.test(trimmed)) return { state: "valid" }
  return show
    ? { state: "invalid", hint: "That does not look like an email address." }
    : { state: "idle" }
}

/**
 * The password rules this instance actually enforces, checked here first.
 *
 * ⚠ THE NUMBER COMES FROM CLERK AND IS NEVER WRITTEN DOWN, which is the point —
 * see `passwordRules` in _lib/environment.ts. The hint under the box, the border
 * colour and whether the submit button is enabled are all the same number, so
 * they cannot drift from each other or from the instance.
 *
 * ⚠ ONE UNMET RULE IS NAMED AT A TIME, NOT ALL OF THEM. A list of five red
 * requirements under an empty box is a wall somebody reads once and then ignores;
 * naming the single thing standing between them and a valid password is
 * something they can act on without reading.
 */
export function passwordVerdict(
  value: string,
  rules: PasswordRules,
  show: boolean,
): Verdict {
  if (value === "")
    return show ? { state: "invalid", hint: "Choose a password." } : { state: "idle" }

  const unmet = firstUnmet(value, rules)
  if (!unmet) return { state: "valid" }

  /*
   * ⚠ LENGTH IS REPORTED WHILE TYPING, THE OTHER RULES ARE NOT. "6 of 8
   * characters" is a progress indicator and is useful on every keystroke;
   * "needs a number" on the second character is a complaint about a password
   * nobody has finished writing. So the count shows as a neutral GREY hint from
   * the start — it is information, not a refusal — and only the red border
   * waits for `show`.
   */
  if (unmet.kind === "length" && !show) {
    return { state: "idle", hint: unmet.hint }
  }

  return show ? { state: "invalid", hint: unmet.hint } : { state: "idle" }
}

type Unmet = { kind: "length" | "class"; hint: string }

function firstUnmet(value: string, rules: PasswordRules): Unmet | null {
  if (value.length < rules.minLength) {
    return {
      kind: "length",
      hint: `${value.length} of ${rules.minLength} characters.`,
    }
  }
  // ⚠ `0` MEANS "NO MAXIMUM" IN CLERK'S DOCUMENT, not "zero characters".
  if (rules.maxLength > 0 && value.length > rules.maxLength) {
    return { kind: "class", hint: `At most ${rules.maxLength} characters.` }
  }
  if (rules.requireLowercase && !/[a-z]/.test(value)) {
    return { kind: "class", hint: "Add a lowercase letter." }
  }
  if (rules.requireUppercase && !/[A-Z]/.test(value)) {
    return { kind: "class", hint: "Add a capital letter." }
  }
  if (rules.requireNumbers && !/[0-9]/.test(value)) {
    return { kind: "class", hint: "Add a number." }
  }
  if (rules.requireSpecial && !/[^A-Za-z0-9]/.test(value)) {
    return { kind: "class", hint: "Add a symbol." }
  }
  return null
}

/**
 * The rule, as one sentence, for the hint line under an untouched box.
 *
 * ⚠ IT IS BUILT FROM THE INSTANCE RATHER THAN WRITTEN OUT, so an instance with
 * `require_numbers` on gets a hint that says so without anybody editing this
 * file — and an instance that turns the minimum down from fifteen to twelve
 * says twelve everywhere, immediately, with no deploy.
 */
export function describeRules(rules: PasswordRules): string {
  const extras: string[] = []
  if (rules.requireLowercase) extras.push("a lowercase letter")
  if (rules.requireUppercase) extras.push("a capital")
  if (rules.requireNumbers) extras.push("a number")
  if (rules.requireSpecial) extras.push("a symbol")

  const length = `At least ${rules.minLength} characters`
  if (extras.length === 0) return `${length}.`
  if (extras.length === 1) return `${length}, including ${extras[0]}.`

  const last = extras[extras.length - 1]
  return `${length}, including ${extras.slice(0, -1).join(", ")} and ${last}.`
}

/** Whether the field would be accepted, ignoring whether it is showing an error. */
export const isEmailUsable = (value: string) => EMAIL.test(value.trim())

export const isPasswordUsable = (value: string, rules: PasswordRules) =>
  value !== "" && firstUnmet(value, rules) === null
