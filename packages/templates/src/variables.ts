/**
 * A template's variables: named by dotted path, filled by the caller at send.
 *
 * ⚠ EVERY VALUE IS A STRING BY THE TIME IT REACHES THE TEMPLATE. A TSX
 * template is rendered once, with markers, and a send substitutes into that
 * output; so the only operation a template may perform on a variable is to put
 * it somewhere. Numbers and booleans are accepted from callers and stringified,
 * exactly as React would print them.
 *
 * ⚠ AND LISTS ARE REFUSED, NOT FLATTENED. `items.map(...)` is logic over a
 * variable - its output depends on how many items there are - which a single
 * render cannot capture. Supporting it means rendering per send, which was
 * decided against for now; see docs/decisions/templates.md.
 */

export interface Variable {
  /** `name`, or `user.name` for a nested value. */
  path: string
  /** The template's own sample value, from `PreviewProps`. Empty when it has none. */
  preview: string
  /**
   * What a send that leaves the variable out gets instead, as Resend's
   * template variables have it. Absent means leaving it out refuses the send.
   *
   * ⚠ A VALUE OF THE WRONG TYPE IS STILL REFUSED. The fallback stands in for
   * a variable that is not there, never for one that is there and unusable.
   */
  fallback?: string
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_DEPTH = 4
export const MAX_VARIABLES = 100

export type Flattened =
  { ok: true; variables: Variable[] } | { ok: false; error: string }

/**
 * The variables a template declares, from its `PreviewProps`.
 *
 * `PreviewProps` is React Email's own convention for sample data, so a template
 * written for its preview server already says what it needs.
 */
export function flattenPreview(preview: unknown): Flattened {
  if (preview === undefined || preview === null) return { ok: true, variables: [] }
  if (!isPlainObject(preview)) {
    return { ok: false, error: "`PreviewProps` must be an object of sample values." }
  }

  const variables: Variable[] = []
  const walk = (
    value: Record<string, unknown>,
    prefix: string,
    depth: number,
  ): string | null => {
    for (const [key, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (!KEY.test(key)) {
        return `\`${path}\` is not a valid variable name. Use letters, digits and underscores.`
      }
      if (Array.isArray(v)) {
        return (
          `\`${path}\` is a list. Lists are not supported yet: a template is rendered once, ` +
          "so its output cannot depend on how many items there are. Pass the list pre-rendered as a string."
        )
      }
      if (isPlainObject(v)) {
        if (depth >= MAX_DEPTH)
          return `\`${path}\` is nested more than ${MAX_DEPTH} levels deep.`
        const nested = walk(v, path, depth + 1)
        if (nested) return nested
        continue
      }
      if (v === null || v === undefined) {
        variables.push({ path, preview: "" })
      } else if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        variables.push({ path, preview: String(v) })
      } else {
        return `\`${path}\` must be a string, a number or a boolean.`
      }
      if (variables.length > MAX_VARIABLES) {
        return `A template may have at most ${MAX_VARIABLES} variables.`
      }
    }
    return null
  }

  const error = walk(preview, "", 1)
  return error ? { ok: false, error } : { ok: true, variables }
}

/**
 * The props object a render receives: every variable's path set to `valueOf`.
 */
export function buildProps(
  variables: readonly Variable[],
  valueOf: (variable: Variable, index: number) => string,
): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  variables.forEach((variable, index) => {
    const parts = variable.path.split(".")
    let node = root
    for (const part of parts.slice(0, -1)) {
      const next = node[part]
      if (isPlainObject(next)) node = next
      else node = node[part] = {}
    }
    node[parts[parts.length - 1]!] = valueOf(variable, index)
  })
  return root
}

export type Looked =
  { found: true; value: string } | { found: false; reason: "missing" | "invalid" }

/** One variable's value out of a caller's `variables`, stringified. */
export function lookup(values: unknown, path: string): Looked {
  let node: unknown = values
  for (const part of path.split(".")) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) {
      return { found: false, reason: "missing" }
    }
    node = node[part]
  }
  if (node === null || node === undefined) return { found: false, reason: "missing" }
  if (typeof node === "string") return { found: true, value: node }
  if (typeof node === "number" && Number.isFinite(node))
    return { found: true, value: String(node) }
  if (typeof node === "boolean") return { found: true, value: String(node) }
  return { found: false, reason: "invalid" }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as unknown
  return proto === Object.prototype || proto === null
}
