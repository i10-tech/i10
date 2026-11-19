"use client"

import * as React from "react"
import { motion } from "motion/react"
import { cn } from "cn"
import { asInEditor, inlineAssets, snapshotSvg } from "@/lib/email-snapshot"
import { fetchAsset } from "@/lib/template-asset-client"
import { workspaceKey } from "@/lib/workspace-key"
import { Shimmer } from "@repo/ui/components/shimmer/shimmer"

/**
 * The top of a template's email as a picture, on the template cards, the list
 * rows and the folder papers (#248): one pipeline, so they all look the same.
 *
 * ⚠ THE DRAFT, NOT ONLY WHAT IS LIVE. A card is how somebody finds the
 * template they were editing; showing last week's published version of it
 * would show them the wrong email. Variables show their fallbacks, or their
 * `{{{ name }}}`, exactly as a test email fills them.
 *
 * ⚠ AN IMAGE, NOT AN IFRAME. The papers move, and on a 4x slowed CPU a grid of
 * 90 iframe papers fell to a median 50ms frame while hovering; images measured
 * the same as the line drawing. The email's HTML goes into an SVG
 * `foreignObject` with its remote images and fonts inlined by the asset proxy
 * (lib/email-snapshot.ts), and the browser rasterizes that once.
 *
 * ⚠ ONE SNAPSHOT PER EDIT, AT AN EMAIL'S WIDTH AND A TALL FIXED HEIGHT, shown
 * by every consumer with `object-fit: cover` from the top.
 *
 * ⚠ FETCHED ONLY ONCE THE CARD IS ON SCREEN (cards and rows), and remembered
 * for the session by template and last edit: nothing about a draft changes
 * without `updated_at` moving.
 *
 * ⚠ FETCHED AS A GET THE BROWSER KEEPS. The URL names the edit and the
 * workspace, and the route answers `immutable` when it is proven current
 * (app/api/template-preview), so a revisit fetches nothing at all.
 */
const cache = new Map<string, Promise<string | null>>()
/** The finished snapshot's blob URL, or null when there is nothing to show. */
const made = new Map<string, string | null>()
const making = new Map<string, Promise<string | null>>()

const keyOf = (templateId: string, stamp: string) => `${templateId}:${stamp}`

const routeUrl = (templateId: string, stamp: string) =>
  `/api/template-preview/${encodeURIComponent(templateId)}?` +
  new URLSearchParams({ v: stamp, w: workspaceKey() })

function fetchHtml(templateId: string, stamp: string): Promise<string | null> {
  const key = keyOf(templateId, stamp)
  let pending = cache.get(key)
  if (!pending) {
    pending = fetch(routeUrl(templateId, stamp))
      .then(async (r) =>
        r.ok ? (((await r.json()) as { html?: string | null }).html ?? null) : null,
      )
      .catch(() => null)
    cache.set(key, pending)
  }
  return pending
}

/** The snapshot of one edit: its HTML, its assets, then the image. */
function snapshotOnce(templateId: string, stamp: string): Promise<string | null> {
  const key = keyOf(templateId, stamp)
  let pending = making.get(key)
  if (!pending) {
    pending = fetchHtml(templateId, stamp)
      .then(async (html) => {
        if (!html) return null
        const inlined = await inlineAssets(asInEditor(html), fetchAsset)
        return URL.createObjectURL(
          new Blob([snapshotSvg(inlined)], { type: "image/svg+xml" }),
        )
      })
      .catch(() => null)
      .then((url) => {
        made.set(key, url)
        return url
      })
    making.set(key, pending)
  }
  return pending
}

/**
 * Makes a card's picture before the card is drawn.
 *
 * ⚠ SO THE CARD RESOLVES WITH ITS PICTURE. Fetched only once the card was on
 * screen, the picture arrived after the skeleton had resolved and faded in on
 * its own, a beat behind the folders beside it. The list preloads the cards
 * it will show and resolves when they are here (templates-view.tsx).
 */
export function preloadSnapshot(templateId: string, stamp: string): Promise<void> {
  return snapshotOnce(templateId, stamp).then(
    () => {},
    () => {},
  )
}

/** The pictures a list preloads: about two screens of a grid. */
const PRELOAD = 12
/**
 * The longest a list holds its skeleton for pictures. Past it the cards
 * resolve and a late picture fades in on its own, as before.
 */
const PRELOAD_WAIT_MS = 800

interface Picture {
  id: string
  updated_at: string
}

/**
 * Whether the pictures of the first cards a list shows are here, so the list
 * can resolve with them: folders and templates together, in one resolve.
 *
 * ⚠ THE FOLDERS' PAPERS COME FIRST, as the folders do in the grid, and share
 * the one budget with the templates: a page of folders must not hold the list
 * for thirty pictures.
 *
 * ⚠ TRUE AT ONCE WHEN THEY ARE MADE, so a second visit holds nothing.
 */
export function usePreviewsReady(
  templates:
    readonly { id: string; updated_at: string; folder_id: string | null }[] | undefined,
  folderId: string | null,
  folders?: readonly { preview?: readonly Picture[] }[],
): boolean {
  const first = React.useMemo(() => {
    if (!templates) return undefined
    const papers: Picture[] = (folders ?? []).flatMap((f) => f.preview ?? [])
    const own: Picture[] = templates.filter((t) => t.folder_id === folderId)
    return [...papers, ...own].slice(0, PRELOAD)
  }, [templates, folderId, folders])
  const cached =
    first !== undefined && first.every((t) => made.has(keyOf(t.id, t.updated_at)))
  const [waited, setWaited] = React.useState(false)

  React.useEffect(() => {
    if (!first || cached || waited) return
    let live = true
    const done = () => {
      if (live) setWaited(true)
    }
    const timer = setTimeout(done, PRELOAD_WAIT_MS)
    void Promise.all(first.map((t) => preloadSnapshot(t.id, t.updated_at))).then(done)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [first, cached, waited])

  return first !== undefined && (cached || waited)
}

/**
 * A template's email as an image.
 *
 * With a `fallback` (the papers' line drawing) it shows under the picture
 * while it loads and when there is nothing; without one, a shimmer while it
 * loads and a blank sheet when the template has no HTML, as Resend shows a new
 * template.
 */
export function TemplateSnapshot({
  templateId,
  stamp,
  fallback,
  className,
  lazy = false,
}: {
  templateId: string
  /** The template's `updated_at`: a new one makes a new picture. */
  stamp: string
  fallback?: React.ReactNode
  className?: string
  /** Wait until the box is near the screen before fetching anything. */
  lazy?: boolean
}) {
  const box = React.useRef<HTMLDivElement>(null)
  const key = keyOf(templateId, stamp)
  // A preloaded picture is drawn on the first render: the card's own resolve
  // fades it in, so it must not wait a round trip and then fade on its own.
  const [preloaded] = React.useState(() => made.has(key))
  const [, setDone] = React.useState<string>()
  const url = made.get(key)

  React.useEffect(() => {
    if (made.has(key)) return
    let current = true
    const start = () => {
      void snapshotOnce(templateId, stamp).then(() => current && setDone(key))
    }
    const el = box.current
    if (!lazy || !el) {
      start()
      return () => {
        current = false
      }
    }
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        seen.disconnect()
        start()
      },
      { rootMargin: "200px" },
    )
    seen.observe(el)
    return () => {
      current = false
      seen.disconnect()
    }
  }, [templateId, stamp, key, lazy])

  return (
    <div
      ref={box}
      className={cn(
        "relative size-full overflow-hidden",
        !fallback && "bg-white",
        className,
      )}
    >
      {fallback && <div className="absolute inset-0">{fallback}</div>}
      {url ? (
        // biome-ignore lint: a blob URL, nothing for next/image to optimise
        <motion.img
          alt=""
          src={url}
          // ⚠ NOT DRAGGABLE. A picture of an email is not a file to drag out;
          // a drag that starts on it must be the card's (drop on a folder).
          draggable={false}
          initial={preloaded ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 size-full bg-white object-cover object-top select-none [-webkit-user-drag:none]"
        />
      ) : url === undefined && !fallback ? (
        <Shimmer className="absolute inset-0 bg-neutral-100" />
      ) : null}
    </div>
  )
}
