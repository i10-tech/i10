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
 * `{{ name }}`, exactly as a test email fills them.
 *
 * ⚠ THE REAL EMAIL, NOT A PICTURE OF IT, in the same sandboxed, CSP-locked
 * frame as every preview, drawn at an email's width and scaled down.
 *
 * ⚠ FETCHED ONLY ONCE THE CARD IS ON SCREEN, and remembered for the session
 * by template and last edit: nothing about a draft changes without
 * `updated_at` moving.
 */
const cache = new Map<string, Promise<string | null>>()

/** An email's usual width; the frame is drawn at this and scaled to fit. */
const EMAIL_WIDTH = 600

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
            html={html}
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
