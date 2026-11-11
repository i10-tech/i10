import { createHash } from "node:crypto"

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** The text two mails are compared on: case and whitespace do not count. */
export function dedupText(subject: string, text: string): string {
  return collapseWhitespace(`${subject}\n${text}`).toLowerCase()
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "(c)",
  reg: "(r)",
  hellip: "...",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return " "
      try {
        return String.fromCodePoint(code)
      } catch {
        return " "
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * A readable plain-text view of an HTML body. It is a regex strip, not an HTML
 * parser, which is the point: nothing in the input is ever interpreted, only
 * removed. Links keep their visible text and drop the target.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
  const withBreaks = withoutBlocks
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
  const stripped = withBreaks.replace(/<[^>]*>/g, " ")
  return decodeEntities(stripped)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** The lower-cased domain of an address or `Name <addr>` header, if any. */
export function domainOf(address: string | undefined): string | undefined {
  if (address === undefined) return undefined
  const angle = /<([^<>]*)>/.exec(address)
  const candidate = angle?.[1] ?? address
  const at = candidate.lastIndexOf("@")
  if (at === -1) return undefined
  const domain = candidate
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-].*$/, "")
    .replace(/\.+$/, "")
  return domain.includes(".") ? domain : undefined
}
