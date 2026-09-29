import { CLOSE, OPEN, marker, markerPattern } from "./markers.js"
import { positionAt } from "./context.js"
import type { Variable } from "./variables.js"

/**
 * Deciding, from three renders, whether a template only INSERTS its variables.
 *
 * ⚠ THIS IS THE GATE THAT KEEPS CUSTOMER CODE OFF THE SEND PATH. A version
 * whose output depends on its variables' values beyond where they are inserted
 * cannot be stored as a skeleton and filled later, and filling it anyway would
 * send an email that differs from what the template says - silently. So those
 * are refused at upload, with the reason. Rendering them per send is a
 * deliberate non-feature for now; see docs/decisions/templates.md.
 *
 * The three renders:
 *
 *   a      every variable a marker under nonce A
 *   b      the same under nonce B
 *   empty  every variable the empty string
 *
 * and what each comparison catches:
 *
 *   markers intact in a and b    a variable transformed before insertion:
 *                                `toUpperCase()`, `slice`, a formatter
 *   a and b equal, markers aside the output depending on a value or changing
 *                                between renders: comparisons against the
 *                                marker, randomness, the clock's seconds
 *   a minus markers equals empty a variable used as a condition or measured:
 *                                `{name && …}`, `{name || "there"}`, `.length`
 *
 * ⚠ ONE SHAPE ESCAPES ALL THREE: a comparison against a literal,
 * `plan === "pro" ? … : …`, takes the same branch for every marker and for the
 * empty string. The render cannot see it; the docs say so, and it is the case a
 * future static check or per-send rendering would have to close.
 */

export interface Render {
  html: string
  text: string
}

export interface Skeleton {
  html: string
  text: string
  nonce: string
  /** Only the variables the output actually uses, in index order. */
  variables: Variable[]
}

export type Verified =
  { ok: true; skeleton: Skeleton } | { ok: false; problems: string[] }

export function verifyRenders(input: {
  variables: readonly Variable[]
  nonceA: string
  nonceB: string
  a: Render
  b: Render
  empty: Render
  /** Top-level props the template read, as the sandbox reported them. */
  accessed?: readonly string[]
}): Verified {
  const { variables, nonceA, nonceB, a, b, empty } = input
  const problems: string[] = []

  const declared = new Set(variables.map((v) => v.path.split(".")[0]!))
  const undeclared = (input.accessed ?? []).filter(
    (key) => !declared.has(key) && key !== "children",
  )
  if (undeclared.length > 0) {
    problems.push(
      `The template reads ${list(undeclared)} but \`PreviewProps\` has no value for ` +
        `${undeclared.length === 1 ? "it" : "them"}. Every variable needs a sample value in ` +
        "`PreviewProps`, which is also how we know what a send must provide.",
    )
  }

  for (const [render, nonce] of [
    [a, nonceA],
    [b, nonceB],
  ] as const) {
    const stray = strayMarker(render.html, nonce, variables.length, false)
    const strayText = strayMarker(render.text, nonce, variables.length, true)
    if (stray !== null || strayText !== null) {
      problems.push(
        "A variable is changed before it is inserted - by `toUpperCase()`, `slice`, a " +
          "formatter or similar. Insert variables as they are, and format them before sending. " +
          `Near: ${excerpt(stray ?? strayText ?? "")}`,
      )
      break
    }
  }
  if (problems.length > 0) return { ok: false, problems }

  const normalA = normalize(a, nonceA)
  const normalB = normalize(b, nonceB)
  const html = firstDifference(normalA.html, normalB.html)
  const text = firstDifference(normalA.text, normalB.text)
  if (html !== null || text !== null) {
    problems.push(
      "The output depends on a variable's value, not only on where it is inserted - a " +
        "comparison, a loop or a computed value - or it changes from one render to the next " +
        "(random values, the current time). " +
        `Near: ${excerpt(html ?? text ?? "")}`,
    )
    return { ok: false, problems }
  }

  // ⚠ BEFORE THE EMPTY-RENDER CHECK, because its answer is more specific. React
  // omits a style declaration whose value is empty, so a variable in `style`
  // also fails that check - and "it is in a style attribute" is the reason
  // somebody can act on.
  const placed = placeMarkers(a.html, nonceA, variables)
  if (!placed.ok) return placed

  const withoutMarkers = stripSeparators(a.html.replace(markerPattern(nonceA), ""))
  const conditional = firstDifference(withoutMarkers, stripSeparators(empty.html))
  if (conditional !== null) {
    problems.push(
      'A variable is used as a condition or measured - `{name && …}`, `{name || "there"}`, ' +
        "`.length` or similar. A template is rendered once, so every variable must always be " +
        `inserted the same way. Near: ${excerpt(conditional)}`,
    )
    return { ok: false, problems }
  }

  const used = new Set<number>(placed.used)
  for (const match of a.text.matchAll(markerPattern(nonceA))) used.add(Number(match[2]))

  return {
    ok: true,
    skeleton: renumber(
      { html: placed.html, text: a.text, nonce: nonceA, variables: [...variables] },
      used,
    ),
  }
}

/**
 * Marks every marker in a URL attribute, and refuses the positions no value
 * may occupy.
 */
function placeMarkers(
  html: string,
  nonce: string,
  variables: readonly Variable[],
): { ok: true; html: string; used: number[] } | { ok: false; problems: string[] } {
  const lower = html.toLowerCase()
  const problems: string[] = []
  const used: number[] = []

  const out = html.replace(
    markerPattern(nonce),
    (whole, _prefix, index: string, _u, at: number) => {
      const i = Number(index)
      used.push(i)
      const position = positionAt(html, lower, at)
      if (position.kind === "forbidden") {
        problems.push(
          `\`${variables[i]?.path ?? index}\` is inserted into ${position.where}, where a value ` +
            "cannot be made safe. Move it into text or an ordinary attribute.",
        )
        return whole
      }
      return marker(nonce, i, position.kind === "attribute" && position.url)
    },
  )

  return problems.length > 0
    ? { ok: false, problems: [...new Set(problems)] }
    : { ok: true, html: out, used }
}

/**
 * Drops variables the output never uses, and renumbers the rest from zero.
 *
 * ⚠ AN UNUSED SAMPLE VALUE MUST NOT BECOME A REQUIRED VARIABLE. `PreviewProps`
 * often carries more than a template prints, and a send refused for leaving out
 * something the email never shows would be an error with no remedy.
 */
function renumber(skeleton: Skeleton, used: ReadonlySet<number>): Skeleton {
  const keep = [...used].sort((x, y) => x - y)
  const next = new Map(keep.map((old, i) => [old, i]))
  const swap = (s: string) =>
    s.replace(
      markerPattern(skeleton.nonce),
      (_w, prefix: string, index: string, u: string) => {
        return `${OPEN}${prefix}_${next.get(Number(index))}${u}${CLOSE}`
      },
    )
  return {
    html: swap(skeleton.html),
    text: swap(skeleton.text),
    nonce: skeleton.nonce,
    variables: keep.map((i) => skeleton.variables[i]!),
  }
}

/**
 * The first bracket that is not part of a valid marker, with its surroundings.
 * Null when every bracket belongs to one.
 */
function strayMarker(
  s: string,
  nonce: string,
  count: number,
  allowUpper: boolean,
): string | null {
  const valid = markerPattern(nonce)
  const spans: Array<[number, number]> = []
  for (const match of s.matchAll(valid)) {
    const upper = match[1]!.startsWith("I")
    const index = Number(match[2])
    if ((upper && !allowUpper) || match[3] === "u" || index >= count) continue
    spans.push([match.index, match.index + match[0].length])
  }

  let span = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== OPEN && ch !== CLOSE) continue
    while (span < spans.length && spans[span]![1] <= i) span++
    const inside = span < spans.length && spans[span]![0] <= i
    if (!inside) return s.slice(Math.max(0, i - 30), i + 30)
  }
  return null
}

function normalize(render: Render, nonce: string): Render {
  const swap = (s: string) =>
    s.replace(markerPattern(nonce), (_w, prefix: string, index: string) =>
      prefix.startsWith("I") ? `\uE000U${index}\uE000` : `\uE000${index}\uE000`,
    )
  return { html: swap(render.html), text: swap(render.text) }
}

/**
 * React separates adjacent text nodes with `<!-- -->`, and whether it emits one
 * beside an empty string is its business, not a difference in the template.
 */
function stripSeparators(html: string): string {
  return html.replaceAll("<!-- -->", "")
}

/** The text around the first position where two strings differ, or null. */
function firstDifference(x: string, y: string): string | null {
  if (x === y) return null
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return x.slice(Math.max(0, i - 30), i + 30)
}

function excerpt(s: string): string {
  const clean = s
    .replace(/\uE000U?(\d+)\uE000/g, "{variable $1}")
    .replace(/\s+/g, " ")
    .trim()
  return `\`${clean}\``
}

function list(items: readonly string[]): string {
  const quoted = items.map((i) => `\`${i}\``)
  return quoted.length <= 1
    ? (quoted[0] ?? "")
    : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`
}
