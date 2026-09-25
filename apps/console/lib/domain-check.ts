import type { Check } from "@repo/ui/checks"

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
 * ⚠ IT IS A `Check` AND NOTHING MORE: a value in, the correction out, `null`
 * when there is nothing to say. WHEN that sentence is shown — red only once
 * somebody has stopped typing, green only where a value was shown wrong and
 * has since been fixed — belongs to the field rather than to the rule, and
 * this file used to own a copy of it. See @repo/ui/components/validated-field.
 *
 * ⚠ AND IT STAYS IN THE CONSOLE RATHER THAN MOVING TO THE PACKAGE, because a
 * sending domain is a fact about this product. `emailProblem` moved because
 * two apps ask for addresses; nothing outside the console asks for a domain.
 */

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

export const domainProblem: Check = (value) => malformed(value.trim())

/**
 * Whether what is in the box is wrong — as opposed to merely unfinished.
 *
 * ⚠ IT IS STILL HERE BECAUSE THE DNS LOOKUP NEEDS IT, NOT THE BORDER. The form
 * only asks a nameserver about a name that could exist, and that gate has to
 * agree with the field exactly — it did not once, and `acme.c` produced "DNS
 * hosted by Cloudflare" under a name the box was about to call malformed.
 */
export const isDomainMalformed = (value: string): boolean => {
  const trimmed = value.trim()
  return trimmed !== "" && malformed(trimmed) !== null
}

/**
 * Whether a failed create was a refusal of the NAME — ours (422), or already
 * held here or elsewhere (409) — rather than of anything else.
 *
 * ⚠ THOSE TWO GO UNDER THE BOX; EVERYTHING ELSE KEEPS ITS TOAST. A full plan
 * or an API that is down is not answered by editing the domain, and the plan
 * limit's toast carries the one button that does answer it.
 */
export const refusesTheName = (errorName: string): boolean =>
  errorName === "validation_error" || errorName === "domain_already_exists"
