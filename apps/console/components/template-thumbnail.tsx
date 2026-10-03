"use client"

import * as React from "react"
import { motion } from "motion/react"
import { cn } from "cn"
import { EmailFrame } from "@/components/email-frame"
import { templateDraftPreview } from "@/lib/actions"

/**
 * The top of a template's email, drawn small on a sheet of paper (#248), the
 * way Resend's template cards show one.
 *
 * ⚠ THE DRAFT, NOT ONLY WHAT IS LIVE. A card is how somebody finds the
 * template they were editing; showing last week's published version of it
 * would show them the wrong email. Variables show their fallbacks, or their
 * `{{{ name }}}`, exactly as a test email fills them.
 *
 * ⚠ THE REAL EMAIL, NOT A PICTURE OF IT, in the same sandboxed, CSP-locked
 * frame as every preview, drawn at an email's width and scaled down.
 *
 * ⚠ FETCHED ONLY ONCE THE CARD IS ON SCREEN, and remembered for the session
 * by template and last edit: nothing about a draft changes without
 * `updated_at` moving.
 */
const cache = new Map<string, Promise<string | null>>()

/**
 * The width the email is drawn at, then scaled to fit.
 *
 * ⚠ WIDER THAN THE EMAIL. An email is a 600px column, and the editor shows it
 * as one with white space either side; drawn in a 600px frame, it filled the
 * sheet edge to edge and its text looked bigger than in the editor.
 */
const EMAIL_WIDTH = 760

export function TemplateThumbnail({
  templateId,
  stamp,
  imagesFrom,
  label,
  className,
}: {
  templateId: string
  /** The template's `updated_at`: a new one fetches a new picture. */
  stamp: string
  imagesFrom: string | null
  label: string
  className?: string
}) {
  const box = React.useRef<HTMLDivElement>(null)
  const [html, setHtml] = React.useState<string | null | undefined>(undefined)
  const [scale, setScale] = React.useState(0)
  const [height, setHeight] = React.useState(300)

  React.useEffect(() => {
    const el = box.current
    if (!el) return
    const size = new ResizeObserver(([entry]) => {
      setScale((entry?.contentRect.width ?? 0) / EMAIL_WIDTH)
      setHeight(entry?.contentRect.height ?? 300)
    })
    size.observe(el)
    let current = true
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        seen.disconnect()
        const key = `${templateId}:${stamp}`
        let pending = cache.get(key)
        if (!pending) {
          pending = templateDraftPreview(templateId).then((r) =>
            r.ok ? (r.data.html ?? null) : null,
          )
          cache.set(key, pending)
        }
        void pending.then((h) => current && setHtml(h))
      },
      { rootMargin: "200px" },
    )
    seen.observe(el)
    return () => {
      current = false
      size.disconnect()
      seen.disconnect()
    }
  }, [templateId, stamp])

  const shown = React.useMemo(() => (html ? asInEditor(html) : html), [html])

  return (
    <div
      ref={box}
      className={cn("relative h-full w-full overflow-hidden bg-white", className)}
    >
      {html && scale > 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0"
        >
          <EmailFrame
            inert
            html={shown!}
            title={label}
            imagesFrom={imagesFrom}
            className="absolute top-0 left-0 origin-top-left"
            style={{
              width: EMAIL_WIDTH,
              height: Math.ceil(height / scale),
              transform: `scale(${scale})`,
            }}
          />
        </motion.div>
      ) : html === null ? (
        // Nothing written yet: a blank sheet, as Resend shows a new template.
        <div className="absolute inset-0" />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-neutral-100" />
      )}
    </div>
  )
}

/**
 * Variables left unfilled, drawn as the editor's chip: `{{{name}}}` in blue
 * monospace with its braces dimmed - not raw braces in the body text.
 *
 * ⚠ TEXT ONLY. A variable in a link's address stays as written; only what a
 * reader would see is restyled, and only for this picture.
 */
function asInEditor(html: string): string {
  if (typeof DOMParser === "undefined" || !/\{\{/.test(html)) return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement?.tagName
    if (parent === "STYLE" || parent === "SCRIPT" || parent === "TITLE") continue
    if (VARIABLE.test(n.textContent ?? "")) texts.push(n as Text)
    VARIABLE.lastIndex = 0
  }
  for (const node of texts) {
    const value = node.textContent ?? ""
    const parts = doc.createDocumentFragment()
    let at = 0
    for (const m of value.matchAll(VARIABLE)) {
      parts.append(value.slice(at, m.index))
      const chip = doc.createElement("span")
      chip.setAttribute("style", CHIP)
      const brace = (t: string) => {
        const b = doc.createElement("span")
        b.setAttribute("style", "opacity:.55")
        b.textContent = t
        return b
      }
      chip.append(brace("{{{"), (m[1] ?? m[2])!, brace("}}}"))
      parts.append(chip)
      at = m.index + m[0].length
    }
    parts.append(value.slice(at))
    node.replaceWith(parts)
  }
  return "<!doctype html>" + doc.documentElement.outerHTML
}

const VARIABLE = /\{\{\{\s*([A-Za-z_][\w.]*)\s*\}\}\}|\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g

/** The editor's chip (editor.css `.i10-variable`), as inline style. */
const CHIP =
  "display:inline-block;padding:0 .3em;margin:0 .06em;border-radius:5px;" +
  "background:rgba(59,130,246,.1);box-shadow:inset 0 0 0 1px rgba(59,130,246,.25);" +
  "color:#2563eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "font-size:.82em;line-height:1.45;white-space:nowrap"
