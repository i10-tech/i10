/**
 * The rules for a template's envelope - sender, reply-to, subject, preview
 * line - shared by the editor's fields and its test-email dialog.
 *
 * ⚠ THE SENDER BY THE SEND PATH'S OWN RULE: an address on a domain this
 * workspace has verified, matched exactly. The API checks the same again.
 */

const ADDRESS = /^(?:"?([^"<>]*?)"?\s*<([^\s<>@]+@[^\s<>@]+)>|([^\s<>@]+@[^\s<>@]+))$/
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[a-z]{2,}$/i

/** The bare address in `Name <a@b.c>` or `a@b.c`, or null. */
export function addressOf(value: string): string | null {
  const m = ADDRESS.exec(value.trim())
  if (!m) return null
  const address = (m[2] ?? m[3] ?? "").trim()
  return EMAIL.test(address) ? address : null
}

export function domainOf(value: string): string | null {
  const address = addressOf(value)
  return address ? address.slice(address.lastIndexOf("@") + 1).toLowerCase() : null
}

/** What is wrong with a sender, or null. Empty is allowed: a send may give its own. */
export function fromProblem(value: string, verified: string[]): string | null {
  const v = value.trim()
  if (!v) return null
  if (/[\r\n]/.test(v)) return "A sender is one line."
  const domain = domainOf(v)
  if (!domain) return "Write it as hi@acme.com or Acme <hi@acme.com>."
  if (!verified.includes(domain)) {
    return verified.length === 0
      ? `${domain} is not verified. Verify a domain before setting a sender.`
      : `${domain} is not verified in this workspace.`
  }
  return null
}

/** The reply-to list, split on commas. */
export function replyToList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function replyToProblem(value: string): string | null {
  const list = replyToList(value)
  const bad = list.find((a) => addressOf(a) === null)
  if (bad) return `${bad} is not an email address.`
  if (list.length > 50) return "At most 50 addresses."
  return null
}

export function subjectProblem(value: string): string | null {
  if (/[\r\n]/.test(value)) return "A subject is one line."
  if (value.length > 998) return "A subject is at most 998 characters."
  return null
}

export function previewProblem(value: string): string | null {
  return value.length > 300
    ? "Keep it under 300 characters; inboxes show about 100."
    : null
}
