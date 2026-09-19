import type { Check } from "@repo/ui/checks"
import type { PasswordRules } from "./environment"

/**
 * Telling somebody their password will be refused before we spend a round trip
 * finding out.
 *
 * ⚠ THIS EXISTS BECAUSE THE FORM WAS ASKING CLERK QUESTIONS IT COULD ANSWER
 * ITSELF. Typing a five-character password and pressing Create account produced
 * a spinner, a network round trip, and a toast two seconds later — for a value
 * that could not possibly have been accepted, decided by a server on another
 * continent. The check belongs where the answer already is.
 *
 * ⚠ AND IT IS NOT A SUBSTITUTE FOR THE SERVER'S ANSWER, WHICH IS WHY NOTHING
 * HERE IS CLEVER. Clerk still decides whether a password has been breached or
 * is too common, and it is still the only thing that can. The job here is
 * narrower and completely reliable: refuse what is wrong on its face, so the
 * round trip is spent on the questions only a server can answer.
 *
 * ⚠ THE EMAIL RULE USED TO LIVE HERE AND HAS MOVED TO @repo/ui/checks, because
 * the console asks for addresses too and was not checking them at all. This
 * one stays: a password policy is a property of the Clerk INSTANCE, read at
 * runtime from `environment.ts`, and nothing outside this app has one.
 */

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
 *
 * ⚠ AND IT IS A FACTORY BECAUSE THE RULES COME FROM THE INSTANCE, not from this
 * file. `Check` takes a value and nothing else, so the policy is closed over
 * once per render rather than threaded through every caller — which is also
 * what lets the field, the hint and the submit guard read the same numbers.
 */
export const passwordProblem =
  (rules: PasswordRules): Check =>
  (value) => {
    const unmet = firstUnmet(value, rules)
    if (!unmet) return null

    /*
     * ⚠ LENGTH IS REPORTED WHILE TYPING, THE OTHER RULES ARE NOT. "6 of 8
     * characters" is a progress indicator and is useful on every keystroke;
     * "needs a number" on the second character is a complaint about a password
     * nobody has finished writing. `early` is exactly that distinction — see
     * `Problem` in @repo/ui/checks.
     */
    return unmet.kind === "length" ? { message: unmet.hint, early: true } : unmet.hint
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
export const isPasswordUsable = (value: string, rules: PasswordRules) =>
  value !== "" && firstUnmet(value, rules) === null
