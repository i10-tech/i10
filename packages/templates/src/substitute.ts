import { markerPattern } from "./markers.js"
import { lookup, type Variable } from "./variables.js"

/**
 * Filling a stored version with one send's variables.
 *
 * ⚠ THIS IS ALL THAT RUNS ON THE SEND PATH. No template code, no sandbox, no
 * network: the version's skeleton was rendered once when it was created, and a
 * send is string substitution into it. Everything a render would have done to
 * a value has to be done here instead, and there are exactly two such things:
 *
 *   escaping        React escapes text and attribute values; so do we, with
 *                   the same five entities, so a filled skeleton is byte-equal
 *                   to rendering the template with those values.
 *   blocked URLs    React refuses `javascript:` URLs; a value filled into a URL
 *                   attribute is checked the same way.
 */

export interface Filled {
  html: string | null
  text: string | null
  subject: string | null
}

export type FillResult =
  { ok: true; filled: Filled } | { ok: false; missing: string[]; invalid: string[] }

export interface Fillable {
  html: string | null
  text: string | null
  subject: string | null
  nonce: string
  variables: readonly Variable[]
}

export function fill(version: Fillable, values: unknown): FillResult {
  const missing: string[] = []
  const invalid: string[] = []
  const resolved: string[] = []

  for (const variable of version.variables) {
    const got = lookup(values, variable.path)
    if (got.found) resolved.push(got.value)
    else if (got.reason === "missing" && variable.fallback !== undefined) {
      resolved.push(variable.fallback)
    } else {
      resolved.push("")
      ;(got.reason === "missing" ? missing : invalid).push(variable.path)
    }
  }

  const subjectPaths = placeholders(version.subject)
  const subjectValues = new Map<string, string>()
  for (const path of subjectPaths) {
    const got = lookup(values, path)
    const declared = version.variables.find((v) => v.path === path)
    if (got.found) subjectValues.set(path, got.value)
    else if (got.reason === "missing" && declared?.fallback !== undefined) {
      subjectValues.set(path, declared.fallback)
    } else if (!declared) {
      ;(got.reason === "missing" ? missing : invalid).push(path)
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, missing: unique(missing), invalid: unique(invalid) }
  }

  const pattern = markerPattern(version.nonce)
  const html =
    version.html?.replace(pattern, (_w, _prefix, index: string, url: string) => {
      const value = resolved[Number(index)] ?? ""
      return escapeHtml(url === "u" ? safeUrl(value) : value)
    }) ?? null
  const text =
    version.text?.replace(pattern, (_w, prefix: string, index: string) => {
      const value = resolved[Number(index)] ?? ""
      return prefix.startsWith("I") ? value.toUpperCase() : value
    }) ?? null
  const subject =
    version.subject?.replace(
      SUBJECT_PLACEHOLDER,
      (_w, triple?: string, double?: string) =>
        oneLine(subjectValues.get(placeholderPath(triple, double)) ?? ""),
    ) ?? null

  return { ok: true, filled: { html, text, subject } }
}

/**
 * `{{{ path }}}` - or the older `{{ path }}` - in a subject line, and in
 * hand-written HTML and text.
 *
 * ⚠ THREE BRACES ARE THE SPELLING THE EDITOR WRITES; TWO STILL WORK, because
 * every template published before the switch uses them. Only BALANCED pairs
 * match, so `{{ a }}}` does not swallow a literal brace. The name is in group
 * 1 or group 2 - read it with `placeholderPath`.
 *
 * ⚠ THREE BRACES ARE NOT "UNESCAPED" HERE, as they are in Handlebars. Every
 * value is escaped for where it lands, however many braces surround it; a
 * template author cannot opt a caller's input out of escaping.
 *
 * ⚠ A SUBJECT IS A HEADER, SO A VALUE FILLED INTO IT LOSES ITS LINE BREAKS. A
 * CR or LF there is header injection - a caller's variable adding a `Bcc:` to
 * somebody else's mail - and the mail library's own folding is not something
 * to lean on for a security property (#189).
 */
export const SUBJECT_PLACEHOLDER =
  /\{\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}\}|\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g

/** The variable a `SUBJECT_PLACEHOLDER` match names, whichever spelling it used. */
export function placeholderPath(
  triple: string | undefined,
  double: string | undefined,
): string {
  return (triple ?? double)!
}

export function placeholders(s: string | null): string[] {
  if (!s) return []
  return unique(
    [...s.matchAll(SUBJECT_PLACEHOLDER)].map((m) => placeholderPath(m[1], m[2])),
  )
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ")
}

/** React's own five: `escapeTextForBrowser`. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!)
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
}

/**
 * ⚠ BROWSERS IGNORE TABS, NEWLINES AND LEADING CONTROL CHARACTERS IN A SCHEME,
 * so `java\tscript:` is `javascript:`. They are removed before the check, the
 * same normalisation React applies.
 */
export function safeUrl(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are the point
  const scheme = value.replace(/[\u0000-\u001F\u007F\s]+/g, "").toLowerCase()
  return /^(javascript|vbscript):/.test(scheme) ? "#" : value
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}
