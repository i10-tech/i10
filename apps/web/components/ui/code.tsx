import type { ReactNode } from "react"

/*
 * A deliberately small highlighter for the handful of snippets on the site.
 * It knows strings, comments, keywords, numbers, calls and punctuation - enough
 * to read like an editor without shipping a grammar engine to the browser.
 */
const KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "const",
  "let",
  "await",
  "async",
  "new",
  "return",
  "if",
  "else",
  "function",
  "true",
  "false",
  "null",
  "def",
  "with",
  "as",
  "package",
  "func",
  "var",
  "use",
  "require",
  "end",
  "do",
])

const TOKEN =
  /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([{}()[\].,;:=<>+\-*/!?|&$\\])/g

export function highlight(
  code: string,
  lang: "ts" | "sh" | "py" | "go" | "rb" | "php" = "ts",
): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of code.matchAll(TOKEN)) {
    const index = m.index ?? 0
    if (index > last) out.push(code.slice(last, index))
    const [text, comment, str, num, call, word, punct] = m
    let cls = ""
    if (comment && (lang !== "ts" || comment.startsWith("//"))) cls = "text-fg-4 italic"
    else if (comment) {
      // `#` in TypeScript is a private field, not a comment.
      out.push(comment)
      last = index + text.length
      continue
    } else if (str) cls = "text-[oklch(0.84_0.12_150)]"
    else if (num) cls = "text-[oklch(0.8_0.12_60)]"
    else if (call) cls = "text-[oklch(0.8_0.11_250)]"
    else if (word)
      cls = KEYWORDS.has(word) ? "text-[oklch(0.76_0.14_300)]" : "text-fg-2"
    else if (punct) cls = "text-fg-4"
    out.push(
      <span key={i++} className={cls}>
        {text}
      </span>,
    )
    last = index + text.length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
