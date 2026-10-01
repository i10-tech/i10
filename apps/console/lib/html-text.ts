/**
 * A plain-text version of an HTML email, for templates written as HTML.
 *
 * ⚠ NOT DECORATION. Several spam filters score a message with no text part,
 * and some readers only ever see this. The visual editor makes its own; this
 * is for the Code view, where nobody should have to write the email twice.
 *
 * ⚠ BROWSER-ONLY (DOMParser), and the HTML is parsed into an inert document:
 * nothing in it loads or runs.
 */
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "table",
  "tr",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "center",
])

export function htmlToText(html: string): string {
  if (!html.trim()) return ""
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const el of Array.from(
    doc.querySelectorAll("style, script, head, title, [data-i10-preview]"),
  )) {
    el.remove()
  }
  // Hidden preheaders and tracking pixels say nothing to a reader.
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    if (/display\s*:\s*none/i.test(el.getAttribute("style") ?? "")) el.remove()
  }

  const out: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push((node.textContent ?? "").replace(/\s+/g, " "))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === "br") return void out.push("\n")
    if (tag === "img") {
      const alt = el.getAttribute("alt")
      if (alt) out.push(alt)
      return
    }
    if (tag === "hr") return void out.push("\n\n---\n\n")
    if (tag === "li") out.push("\n- ")
    if (tag === "td" || tag === "th") out.push(" ")
    const block = BLOCK.has(tag)
    if (block) out.push("\n\n")
    for (const child of Array.from(el.childNodes)) walk(child)
    if (tag === "a") {
      const href = el.getAttribute("href") ?? ""
      const text = (el.textContent ?? "").trim()
      if (
        href &&
        !href.startsWith("mailto:") &&
        href !== text &&
        !href.startsWith("#")
      ) {
        out.push(` [${href}]`)
      }
    }
    if (block) out.push("\n\n")
  }
  walk(doc.body)

  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
