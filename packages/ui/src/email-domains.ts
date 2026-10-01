/**
 * Which mailbox provider somebody is halfway through typing, and which one
 * they mistyped (#175). Pure, so the rules are tested without a DOM.
 */

/**
 * Offered after `@`, in this order.
 *
 * ⚠ THE ORDER IS THE TIE-BREAK, SO IT IS BY HOW OFTEN EACH IS THE ANSWER.
 * After a bare `@` only the first one can be shown, and after `@h` only the
 * first match; whatever is most likely has to come first or the ghost text is
 * wrong more often than it is right.
 */
export const SUGGESTED_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "live.com",
  "aol.com",
  "protonmail.com",
  "me.com",
] as const

/**
 * Real providers that sit one letter away from a suggested one.
 *
 * ⚠ NEVER "CORRECTED", BECAUSE THEY ARE NOT MISTAKES. `mail.com` is one
 * deletion from `gmail.com` and `ymail.com` one substitution, and both are
 * somebody's actual address. Asking "did you mean gmail.com?" of a person who
 * typed their own domain correctly is worse than not asking at all.
 */
const REAL_NEIGHBOURS = new Set([
  "mail.com",
  "ymail.com",
  "gmx.com",
  "gmx.de",
  "mac.com",
  "msn.com",
  "pm.me",
  "hey.com",
  "fastmail.com",
  "zoho.com",
  "yandex.com",
  "outlook.de",
  "hotmail.de",
  "hotmail.fr",
  "hotmail.co.uk",
  "yahoo.de",
  "yahoo.fr",
  "yahoo.co.uk",
  "live.de",
  "live.fr",
  "live.co.uk",
])

const KNOWN = new Set<string>(SUGGESTED_DOMAINS)

/** The address split at its LAST `@`, or `null` before there is one. */
function split(value: string): { local: string; domain: string } | null {
  const at = value.lastIndexOf("@")
  if (at <= 0) return null
  return { local: value.slice(0, at), domain: value.slice(at + 1) }
}

/**
 * The rest of the domain to show as ghost text, or `null`.
 *
 * ⚠ ONLY WHILE THE TYPED DOMAIN IS A STRICT PREFIX. `gmail.com` typed in full
 * gets nothing, which is also what keeps this out of autofill's way: a filled
 * address is always complete, so there is never anything left to offer.
 *
 * Case-insensitive on the match, and the completion keeps the typed case for
 * the typed half, since that half is the person's own.
 */
export function domainCompletion(value: string): string | null {
  const parts = split(value)
  if (!parts || /\s/.test(value)) return null
  const typed = parts.domain.toLowerCase()
  const match = SUGGESTED_DOMAINS.find(
    (domain) => domain.startsWith(typed) && domain !== typed,
  )
  return match ? match.slice(typed.length) : null
}

/**
 * The address they probably meant, or `null`.
 *
 * ⚠ ONE EDIT AWAY, COUNTING A SWAPPED PAIR AS ONE. That is `gmial.com`,
 * `hotmial.com`, `gmail.co`, `yahooo.com` - the slips fingers actually make.
 * Two edits starts matching real, unrelated domains.
 */
export function domainCorrection(value: string): string | null {
  const parts = split(value.trim())
  if (!parts) return null
  const domain = parts.domain.toLowerCase()
  if (!domain.includes(".") || KNOWN.has(domain) || REAL_NEIGHBOURS.has(domain))
    return null
  const match = SUGGESTED_DOMAINS.find((known) => oneEditApart(domain, known))
  return match ? `${parts.local}@${match}` : null
}

/** Damerau: one insertion, deletion, substitution or adjacent swap. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const diffs: number[] = []
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i)
    if (diffs.length === 1) return true
    const [i, j] = diffs
    return diffs.length === 2 && j === i! + 1 && a[i!] === b[j] && a[j] === b[i!]
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  while (i < short.length && short[i] === long[i]) i++
  return short.slice(i) === long.slice(i + 1)
}
