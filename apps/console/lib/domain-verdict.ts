import type { FieldState } from "@repo/ui/components/floating-field"
import type { FieldFocus } from "@repo/ui/hooks/field-focus"

/**
 * Telling somebody the domain they typed is not a domain, before we ask DNS.
 *
 * ⚠ THE FIELD HAD NO VERDICT AT ALL, WHICH IS WORSE HERE THAN ON THE SIGN-IN
 * PAGE. A malformed address gets refused by Clerk a second later; a malformed
 * domain gets a nameserver lookup that correctly finds nothing, and "we could
 * not match your nameservers to a provider we know" is a sentence about DNS
 * shown to somebody who typed `https://acme.com`. The form was answering a
 * question it had been asked by mistake.
 *
 * ⚠ AND THE HINTS NAME THE ACTUAL MISTAKE RATHER THAN RESTATING THE RULE.
 * Nearly every wrong value in this box is one of four things — a URL pasted out
 * of the address bar, an email address, a name with no dot, or a stray space —
 * and each has a different correction. "That does not look like a domain" is
 * true of all four and useful for none.
 *
 * ⚠ THE RULES ARE THE SAME ONES `useFieldFocus` ENFORCES EVERYWHERE ELSE: red
 * only once somebody has stopped typing, green only where a value was shown
 * wrong and has since been fixed. See @repo/ui/hooks/field-focus — the whole
 * reason that hook moved into the package was so this screen could not
 * accidentally invent a gentler or harsher version of them.
 */

export interface Verdict {
  state: FieldState
  hint?: string
}

type Reveal = Pick<FieldFocus, "blurred" | "submitted" | "recovering">

/**
 * ⚠ ONE LABEL AT A TIME, AND EVERY LABEL HAS TO BE NON-EMPTY. The obvious
 * one-line regex accepts `acme..com` and `.acme.com`, both of which are
 * rejected by DNS and by SES but look close enough to correct that nobody spots
 * them in a form. Splitting on the dot makes the empty label impossible rather
 * than merely unlikely.
 *
 * ⚠ AND THE LABEL RULES ARE RFC 1123's, NOT RFC 952's: a leading digit is legal
 * (`4chan.org` exists, and so do thousands of customer subdomains), a leading or
 * trailing hyphen is not, and 63 octets is the hard limit.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/**
 * ⚠ LETTERS ONLY, TWO OR MORE. Every delegated TLD is alphabetic — the digits
 * that appear in `xn--` punycode are inside the A-label, which starts with
 * letters — so this rejects `acme.123` and `192.168.1.1` without needing to
 * know what an IP address is.
 */
const TLD = /^[a-z]{2,}$/i

function malformed(value: string): string | null {
  if (/\s/.test(value)) return "A domain cannot contain spaces."

  /*
   * ⚠ CHECKED BEFORE THE SHAPE, BECAUSE A PASTED URL IS THE COMMONEST WRONG
   * ANSWER AND THE ONE WITH THE CLEAREST FIX. Somebody who copies the address
   * bar gets `https://acme.com/pricing`, which fails the label rules for three
   * separate reasons — none of which is worth explaining when "take off the
   * https://" is the whole correction.
   */
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//")) {
    return "Just the domain — no https:// in front."
  }
  if (value.includes("@")) {
    return "That is an email address. Enter the domain after the @."
  }
  if (value.includes("/")) return "Just the domain — leave off the path."
  if (value.includes("_")) return "Domain names cannot contain underscores."

  /*
   * ⚠ A TRAILING DOT IS THE FULLY-QUALIFIED FORM AND IS NOT A MISTAKE, so it is
   * stripped rather than refused. `acme.com.` is what a resolver writes and what
   * anybody who has read a zone file types; refusing it would be the form being
   * stricter than DNS.
   */
  const bare = value.replace(/\.$/, "")
  const labels = bare.split(".")

  if (labels.length < 2) return "A domain needs a dot, like example.com."
  if (labels.some((label) => label === "")) {
    return "That does not look like a domain — check the dots."
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return "That does not look like a domain."
  }
  if (!TLD.test(labels[labels.length - 1] ?? "")) {
    return "That does not end in a domain ending, like .com."
  }
  // ⚠ 253 OCTETS IS THE WIRE LIMIT for a name, and a name over it cannot be
  // looked up at all — so it fails here rather than as a resolver error.
  if (bare.length > 253) return "That domain is too long."

  return null
}

/** Whether what is in the box is wrong — as opposed to merely unfinished. */
export const isDomainMalformed = (value: string): boolean => {
  const trimmed = value.trim()
  return trimmed !== "" && malformed(trimmed) !== null
}

export function domainVerdict(value: string, reveal: Reveal): Verdict {
  const trimmed = value.trim()

  /*
   * ⚠ EMPTY IS NOT WRONG UNTIL THE BUTTON IS PRESSED. Tabbing through a box you
   * have not answered yet is how people read a form; reddening it for that is
   * the interface telling somebody off for looking.
   */
  if (trimmed === "") {
    return reveal.submitted
      ? { state: "invalid", hint: "Enter the domain you send from." }
      : { state: "idle" }
  }

  const problem = malformed(trimmed)

  /*
   * ⚠ CORRECT IS NOT THE SAME AS GREEN. Most domains are typed correctly first
   * time and saying so is not news — green is spent only on a value that was
   * SHOWN wrong and has since been fixed, and only while the caret is still in
   * the box asking the question green answers.
   */
  if (!problem) {
    return reveal.recovering ? { state: "valid" } : { state: "idle" }
  }

  /*
   * ⚠ AND RED WAITS. Every domain is malformed while it is being typed — `a`,
   * `ac`, `acme`, `acme.` — so a field that reddens on the first keystroke is
   * red for the whole time anybody is using it, and the colour stops meaning
   * anything at all.
   */
  return reveal.blurred ? { state: "invalid", hint: problem } : { state: "idle" }
}
