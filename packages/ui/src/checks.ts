/**
 * The rules a field is judged by. One sentence per way of being wrong.
 *
 * ⚠ A CHECK RETURNS THE CORRECTION, NOT A BOOLEAN, AND THAT IS THE WHOLE
 * INTERFACE. `false` tells somebody they are wrong; "Just the domain — no
 * https:// in front." tells them what to do instead, and the difference is
 * whether they get unstuck. It also means the message lives next to the test
 * that produced it rather than in a lookup table three files away, which is
 * how a rule and its explanation drift apart.
 *
 * ⚠ AND `null` MEANS ACCEPTABLE, NOT EXCELLENT. Nothing here says a value is
 * good; it says there is nothing to complain about. See `fieldVerdict` in
 * components/validated-field.tsx for why that distinction is what keeps green
 * meaningful.
 *
 * ⚠ CHECKS ARE NEVER ASKED ABOUT AN EMPTY VALUE. Emptiness is the field's own
 * business — it is not a mistake until somebody presses the button — so every
 * function here may assume it has been given something.
 */

/**
 * What is wrong with a value.
 *
 * ⚠ THE OBJECT FORM EXISTS FOR PROGRESS, NOT FOR EMPHASIS. "6 of 8 characters"
 * is useful on every keystroke and is not a complaint; "needs a number" typed
 * at somebody on the second character of a password they have not finished is.
 * `early` shows the message immediately in the neutral tone and still waits for
 * the caret to leave before turning anything red.
 */
export type Problem = string | { message: string; early: boolean }

/** A rule. `null` when there is nothing to say. */
export type Check = (value: string) => Problem | null

/**
 * ⚠ A DOT IN THE DOMAIN IS REQUIRED, WHICH THE HTML5 SPEC'S OWN PATTERN DOES
 * NOT REQUIRE. `type="email"` deliberately accepts `mido@localhost`, because
 * the spec is written for intranets as well as the internet. This is a product
 * whose entire function is delivering mail to the address, so an address with
 * no public domain is one we would accept and then fail to reach.
 *
 * ⚠ AND IT IS DELIBERATELY LOOSE EVERYWHERE ELSE. Every regex that tries to
 * fully implement RFC 5322 rejects addresses that work — plus-tagging,
 * apostrophes, long TLDs, new gTLDs — and the cost of a false rejection is
 * somebody who cannot sign up at all and has no way to argue. The rule is "has
 * a local part, one @, a domain with a dot, and a plausible TLD", and nothing
 * beyond it.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[a-z]{2,}$/i

/**
 * An email address.
 *
 * ⚠ IT MOVED OUT OF THE AUTH APP BECAUSE THE CONSOLE ASKS FOR ADDRESSES TOO,
 * and was not checking them at all — "Add a contact" and "Suppress an address"
 * both took whatever was typed and sent it to the API. Two rules for one
 * concept is how `mido@localhost` gets refused at sign-up and accepted as a
 * contact.
 */
export const emailProblem: Check = (value) => {
  const trimmed = value.trim()
  if (EMAIL.test(trimmed)) return null
  if (!trimmed.includes("@")) return "An email address needs an @."
  return "That does not look like an email address."
}

/** Whether an address would be accepted. For a guard, not for a border. */
export const isEmailUsable = (value: string): boolean => emailProblem(value) === null

/**
 * A URL we are going to POST to.
 *
 * ⚠ HTTPS ONLY, AND REFUSING `http://` HERE IS NOT PEDANTRY. A webhook carries
 * event data and a signature over plaintext otherwise, and the endpoint that
 * receives it is somebody's production system. The form used to say "Must be
 * HTTPS and publicly reachable" in a grey hint under a box that accepted
 * anything, which is a rule written down rather than applied.
 *
 * ⚠ AND `localhost` IS NAMED SPECIFICALLY, because it is the commonest wrong
 * answer and the one whose failure is most confusing: the endpoint saves, and
 * then nothing ever arrives, because the delivery worker is not on the
 * developer's laptop.
 */
export const httpsUrlProblem: Check = (value) => {
  const trimmed = value.trim()

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed.includes(".")
      ? "Start with https://"
      : "That does not look like a URL."
  }

  if (url.protocol === "http:") return "Use https:// — we will not post over http."
  if (url.protocol !== "https:") return "Start with https://"
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    return "We cannot reach localhost. Use a tunnel while developing."
  }
  if (!url.hostname.includes(".")) return "That host is not publicly reachable."

  return null
}
