"use client"

import * as React from "react"
import { ImageOff, Image as ImageIcon } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { cn } from "cn"

/**
 * An email, rendered where it cannot reach us (#189).
 *
 * ⚠ THREE LAYERS, EACH FOR SOMETHING THE OTHERS DO NOT DO.
 *
 *   sandbox=""   no scripts, no forms, no top-level navigation, and a unique
 *                opaque origin: the email cannot touch the console's cookies,
 *                storage or DOM. Never add tokens to it; `allow-scripts` with
 *                `allow-same-origin` would let the frame remove its own sandbox.
 *   CSP <meta>   the sandbox does NOT stop subresources. Without a policy every
 *                remote image loads, which fires the sender's tracking pixels
 *                and hands the viewer's IP to whoever hosts them. The policy
 *                allows inline styles and `data:` images, and remote images
 *                only when the viewer asks.
 *   refresh      a `<meta http-equiv="refresh">` navigates the frame itself,
 *                which neither the sandbox nor a CSP prevents, and could put a
 *                phishing page inside the console. It is removed from THIS
 *                copy only.
 *
 * ⚠ ONLY THE DISPLAY COPY IS TOUCHED. What is sent is exactly what the customer
 * gave us; isolating what we display is the rule, never altering what we
 * deliver.
 */
export function EmailFrame({
  html,
  title,
  className,
  imagesFrom = null,
  inert = false,
  style,
}: {
  html: string
  title: string
  className?: string
  /**
   * An origin whose images always load: our own template images host
   * (#244, #248). Everything else remote waits for the viewer to ask.
   */
  imagesFrom?: string | null
  /**
   * A thumbnail: no controls, no pointer, no focus, hidden from assistive
   * technology - the card around it is the link, and says what it is.
   */
  inert?: boolean
  style?: React.CSSProperties
}) {
  const [remote, setRemote] = React.useState(false)
  const hasRemote = React.useMemo(
    () => remoteImagesIn(html, imagesFrom),
    [html, imagesFrom],
  )
  const doc = React.useMemo(
    () => displayCopy(html, remote, imagesFrom),
    [html, remote, imagesFrom],
  )

  if (inert) {
    return (
      <iframe
        sandbox=""
        srcDoc={doc}
        title={title}
        aria-hidden
        tabIndex={-1}
        style={style}
        className={cn("pointer-events-none block border-0 bg-white", className)}
        referrerPolicy="no-referrer"
        // Not `loading="lazy"`: a thumbnail is only mounted once its card is
        // on screen, and deferring it twice only delays the paint.
      />
    )
  }

  return (
    <div className={cn("relative", className)}>
      <iframe
        // ⚠ SEE THE BLOCK COMMENT. Do not add tokens to this attribute.
        sandbox=""
        srcDoc={doc}
        title={title}
        className="block h-full min-h-[28rem] w-full bg-white"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
      {hasRemote && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="absolute top-2 right-2 bg-background/90 backdrop-blur-sm"
          onClick={() => setRemote((on) => !on)}
          aria-pressed={remote}
        >
          {remote ? <ImageOff /> : <ImageIcon />}
          {remote ? "Hide remote images" : "Load remote images"}
        </Button>
      )}
    </div>
  )
}

const REMOTE_IMAGE =
  /\b(?:src|background)\s*=\s*["']?\s*(https?:[^"'\s>]+)|url\(\s*["']?(https?:[^"')\s]+)/gi

/** Whether the email loads any image from somewhere other than `own`. */
export function remoteImagesIn(html: string, own: string | null): boolean {
  for (const m of html.matchAll(REMOTE_IMAGE)) {
    const url = m[1] ?? m[2] ?? ""
    if (!own || !url.startsWith(`${own}/`)) return true
  }
  return false
}

const DOCTYPE = /^\s*<!doctype[^>]*>/i

const REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi

/**
 * The HTML as the frame shows it: a policy first, and no meta refresh.
 *
 * ⚠ THE POLICY GOES FIRST, BEFORE `<html>` - BUT AFTER ANY DOCTYPE. A `<meta>`
 * there is parsed into the implied `<head>` before anything of the email's, and
 * if the email declares its own policy too, the browser enforces both: a policy
 * can only narrow. Anything before the doctype would put the document into
 * quirks mode and change how the email lays out.
 */
export function displayCopy(
  html: string,
  remoteImages: boolean,
  imagesFrom: string | null = null,
): string {
  const own =
    imagesFrom && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(imagesFrom)
      ? ` ${imagesFrom}`
      : ""
  const img = remoteImages ? "data: cid: https: http:" : `data: cid:${own}`
  const policy = [
    "default-src 'none'",
    `img-src ${img}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ")
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
  const body = html.replace(REFRESH, "")
  const doctype = DOCTYPE.exec(body)
  return doctype
    ? `${doctype[0]}${meta}${body.slice(doctype[0].length)}`
    : `${meta}${body}`
}
