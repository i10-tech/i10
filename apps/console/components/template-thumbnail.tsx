"use client"

import * as React from "react"
import { EmailFrame } from "@/components/email-frame"
import { previewTemplateVersion } from "@/lib/actions"

/**
 * The top of a template's live version, drawn small (#248).
 *
 * ⚠ THE REAL EMAIL, NOT A PICTURE OF IT. The live version is filled with its
 * samples by the API - exactly as a send would fill it - and drawn in the same
 * sandboxed, CSP-locked frame as every preview, at an email's real width and
 * scaled down. Nothing to store, nothing to regenerate, never out of date.
 *
 * ⚠ FETCHED ONLY ONCE THE CARD IS ON SCREEN, and remembered for the session
 * by template and version: a version never changes, so neither does its
 * thumbnail.
 */
const cache = new Map<string, Promise<string | null>>()

/** An email's usual width; the frame is drawn at this and scaled to fit. */
const EMAIL_WIDTH = 600

export function TemplateThumbnail({
  templateId,
  version,
  imagesFrom,
  label,
}: {
  templateId: string
  /** The live version's number; 0 when there is none. */
  version: number
  imagesFrom: string | null
  label: string
}) {
  const box = React.useRef<HTMLDivElement>(null)
  const [html, setHtml] = React.useState<string | null>(null)
  const [scale, setScale] = React.useState(0)

  React.useEffect(() => {
    const el = box.current
    if (!el || version === 0) return
    const size = new ResizeObserver(([entry]) =>
      setScale((entry?.contentRect.width ?? 0) / EMAIL_WIDTH),
    )
    size.observe(el)
    let current = true
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        seen.disconnect()
        const key = `${templateId}:${version}`
        let pending = cache.get(key)
        if (!pending) {
          pending = previewTemplateVersion(templateId, version).then((r) =>
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
  }, [templateId, version])

  return (
    <div
      ref={box}
      className="relative aspect-[4/3] overflow-hidden border-b bg-muted/40"
    >
      {version === 0 ? (
        <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          Not published yet
        </p>
      ) : html && scale > 0 ? (
        <EmailFrame
          inert
          html={html}
          title={label}
          imagesFrom={imagesFrom}
          className="absolute top-0 left-0 origin-top-left"
          // Drawn at an email's width, as tall as the 4:3 card, then scaled.
          style={{
            width: EMAIL_WIDTH,
            height: (EMAIL_WIDTH * 3) / 4,
            transform: `scale(${scale})`,
          }}
        />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-muted/60" />
      )}
    </div>
  )
}
