import { escapeHtml } from "./substitute.js"

/**
 * An inbox preview line, written into an email as React Email's `<Preview>`
 * writes it: a hidden block at the top of the body, padded so the client does
 * not carry on into the email's own first words.
 *
 * ⚠ IDEMPOTENT. A block this wrote before is replaced, never added to; a
 * draft restored from a published version already carries one, and
 * publishing it again must not show two.
 *
 * ⚠ `{{{ name }}}` SURVIVES ESCAPING, so a preview line can use a variable and
 * the version's skeleton finds it like any other.
 */
const MARK = "data-i10-preview"
const BLOCK = new RegExp(`<div ${MARK}[^>]*>[\\s\\S]*?</div>`, "g")
/** Zero-width non-joiners and non-breaking spaces, as `<Preview>` pads. */
const PADDING = "‌ ‍‎‏﻿".repeat(50)

export function withPreviewText(html: string, preview: string | null): string {
  const without = html.replace(BLOCK, "")
  const line = preview?.trim()
  if (!line) return without
  const block =
    `<div ${MARK} style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">` +
    `${escapeHtml(line)}${PADDING}</div>`
  const body = /<body\b[^>]*>/i.exec(without)
  if (!body) return block + without
  const at = body.index + body[0].length
  return without.slice(0, at) + block + without.slice(at)
}
