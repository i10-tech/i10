/**
 * Where in an HTML document a position falls, as far as filling a variable
 * there is concerned.
 *
 * ⚠ THIS READS OUR RENDERER'S OUTPUT AND HTML A CUSTOMER WROTE, NOT ARBITRARY
 * HTML. React serialises attributes with double quotes and escapes both text
 * and attribute values, so a scan of the characters before a position is
 * enough to answer "text, attribute value, or somewhere a value must never
 * go". It is not a parser, and it only has to be right about the positions a
 * marker can occupy.
 */

export type Position =
  | { kind: "text" }
  /** Inside a double-quoted attribute value. `url` for attributes that navigate or load. */
  | { kind: "attribute"; name: string; url: boolean }
  /** Somewhere no value may go: a tag or attribute name, a comment, `<style>`, `<script>`. */
  | { kind: "forbidden"; where: string }

/**
 * ⚠ URL ATTRIBUTES ARE TRACKED SO A SEND CAN REFUSE `javascript:` IN THEM.
 * React blocks `javascript:` URLs when it renders; substitution happens after
 * rendering, so without this a variable in an `href` would reintroduce exactly
 * what React removed.
 */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "background",
  "poster",
  "cite",
  "xlink:href",
])

const ATTRIBUTE_VALUE = /\s([^\s"'=<>/]+)\s*=\s*"[^"]*$/

export function positionAt(html: string, lower: string, at: number): Position {
  const lastOpen = html.lastIndexOf("<", at)
  const lastClose = html.lastIndexOf(">", at)

  if (lastOpen > lastClose) {
    const tag = html.slice(lastOpen, at)
    if (tag.startsWith("<!--")) return { kind: "forbidden", where: "an HTML comment" }
    const attribute = ATTRIBUTE_VALUE.exec(tag)
    if (!attribute) return { kind: "forbidden", where: "a tag or attribute name" }
    const name = attribute[1]!.toLowerCase()
    if (name === "style") return { kind: "forbidden", where: "a style attribute" }
    if (name.startsWith("on"))
      return { kind: "forbidden", where: `an event handler (${name})` }
    return { kind: "attribute", name, url: URL_ATTRIBUTES.has(name) }
  }

  if (lower.lastIndexOf("<!--", at) > lower.lastIndexOf("-->", at)) {
    return { kind: "forbidden", where: "an HTML comment" }
  }
  for (const element of ["style", "script"] as const) {
    if (lower.lastIndexOf(`<${element}`, at) > lower.lastIndexOf(`</${element}`, at)) {
      return { kind: "forbidden", where: `a <${element}> element` }
    }
  }
  return { kind: "text" }
}
