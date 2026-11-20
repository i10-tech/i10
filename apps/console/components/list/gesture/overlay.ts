import * as React from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { animate } from "motion/react"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { FolderGlyph } from "@/components/templates/folder-art"
import type { Point, Rect } from "./decide"

/**
 * What a gesture draws: the selection box, and the copy of what a lift carries.
 *
 * ⚠ EVERYTHING HERE LIVES ON <body>, NOT IN THE PAGE. A `fixed` element inside
 * the page's transformed wrapper is placed relative to that wrapper. Each piece
 * is moved by a single `transform`; React never sees it.
 *
 * ⚠ THE CURSOR'S POSITION AND THE SPRINGS NEVER SHARE AN ELEMENT. The outer
 * element follows the pointer 1:1 with no easing, and the springs (fly in, fly
 * back, shrink, drop) run on elements nested inside it.
 */

/** The long side of a copy at rest, in pixels. */
const ART = 64
/** Where the 64px square sits against the cursor, so the cursor stays visible. */
const AT = { x: 12, y: 10 }
const CENTRE = { x: AT.x + ART / 2, y: AT.y + ART / 2 }
const LABEL_GAP = 6
const STAGGER = 0.02
/** How each copy behind the grabbed one rests: a few pixels and degrees off. */
const FAN = [
  { x: 5, y: 3, r: 4 },
  { x: -5, y: 5, r: -5 },
  { x: 9, y: 8, r: 9 },
]
/** The most copies drawn behind the grabbed one. */
export const STACK_BEHIND = FAN.length

const spring = { ...motionTokens.spring.snappy }
const fade = { duration: 0.12 }

function make(className: string, parent?: Element): HTMLDivElement {
  const el = document.createElement("div")
  el.className = className
  el.setAttribute("aria-hidden", "true")
  parent?.appendChild(el)
  return el
}

export type Box = {
  /** Place the box, given in viewport pixels already clipped to the scroller. */
  place: (r: Rect) => void
  remove: () => void
}

export function createBox(): Box {
  const el = make(
    "pointer-events-none fixed top-0 left-0 z-50 rounded-[3px] border border-primary/60 bg-primary/10",
  )
  el.style.willChange = "transform"
  el.style.transform = "translate3d(-9999px,0,0)"
  document.body.appendChild(el)
  return {
    place(r) {
      el.style.transform = `translate3d(${r.left}px,${r.top}px,0)`
      el.style.width = `${Math.max(0, r.right - r.left)}px`
      el.style.height = `${Math.max(0, r.bottom - r.top)}px`
    },
    remove: () => el.remove(),
  }
}

export type Kind = "folder" | "template"

/** One carried card, copied: the element that flies, at the size it rests at. */
export type Art = {
  el: HTMLElement
  w: number
  h: number
  /** Where the card's art is on screen now; null when the card is not. */
  rect: Rect | null
  dispose?: () => void
}

const rectOf = (el: Element): Rect => {
  const b = el.getBoundingClientRect()
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
}

const centreOf = (r: Rect): Point => ({
  x: r.left + (r.right - r.left) / 2,
  y: r.top + (r.bottom - r.top) / 2,
})

const ART_SELECTOR = "[data-drag-art]"

/** Where a card's art is on screen: the art itself, else the whole card. */
export function artRect(card: Element | null): Rect | null {
  if (!card) return null
  return rectOf(card.querySelector(ART_SELECTOR) ?? card)
}

const onScreen = (r: Rect) =>
  r.right > 0 &&
  r.bottom > 0 &&
  r.left < window.innerWidth &&
  r.top < window.innerHeight

/**
 * The copy of a card's art that a lift carries.
 *
 * ⚠ CLONED, NOT REDRAWN. What flies is the DOM the card shows (`data-drag-art`),
 * so it can never drift from the card. When there is nothing real to copy (a
 * skeleton, a snapshot still loading, a card off screen) a plain paper or the
 * folder glyph stands in: a lift never shows an empty box.
 */
export function copyArt(card: Element | null, kind: Kind): Art {
  const seen = artRect(card)
  const rect = seen && onScreen(seen) ? seen : null
  const source = card?.querySelector<HTMLElement>(ART_SELECTOR) ?? null
  if (source && source.offsetWidth > 0 && (kind === "folder" || pictured(source))) {
    return cloneArt(source, kind, rect)
  }
  return standIn(kind, rect)
}

const pictured = (source: HTMLElement) => {
  const img = source.querySelector("img")
  return !!img && img.complete && img.naturalWidth > 0
}

function cloneArt(source: HTMLElement, kind: Kind, rect: Rect | null): Art {
  const nw = source.offsetWidth
  const nh = source.offsetHeight
  const r = ART / Math.max(nw, nh)
  const el = make("absolute top-0 left-0")
  el.style.width = `${nw * r}px`
  el.style.height = `${nh * r}px`
  if (kind === "template") {
    el.className +=
      " overflow-hidden rounded-[5px] bg-white shadow-md ring-1 ring-border"
  }

  // ⚠ A FIXED-SIZE STAGE THAT IS A CONTAINER. The art is fluid (`cqw`, shares
  // of its own width), so it is laid out at the size it has on the card and
  // scaled down with a transform: every border and shadow shrinks with it.
  const stage = make("@container absolute top-0 left-0 origin-top-left", el)
  stage.style.width = `${nw}px`
  stage.style.height = `${nh}px`
  stage.style.transform = `scale(${r})`

  const copy = source.cloneNode(true) as HTMLElement
  Object.assign(copy.style, {
    position: "absolute",
    left: "0",
    top: "0",
    right: "auto",
    bottom: "auto",
    margin: "0",
    width: `${nw}px`,
    height: `${nh}px`,
  })
  if (kind === "template") {
    copy.style.boxShadow = "none"
    copy.style.borderRadius = "0"
  }
  strip(copy)
  stage.appendChild(copy)
  return { el, w: nw * r, h: nh * r, rect }
}

const REFERENCING = ["filter", "mask", "clip-path", "fill", "stroke"]

/**
 * Makes the copy cheap and self-contained.
 *
 * ⚠ NO `backdrop-filter` ON THE COPY: it re-blurs what is behind it on every
 * frame the copy moves. ⚠ ITS IDS ARE RENAMED, so the `url(#id)` filters of the
 * clone point at the clone's own definitions and not at the card's, which may
 * be gone while the copy is still flying.
 */
function strip(root: HTMLElement) {
  const all = [root, ...root.querySelectorAll<HTMLElement>("*")]
  for (const node of all) {
    node.style.backdropFilter = "none"
    node.style.setProperty("-webkit-backdrop-filter", "none")
  }
  const renamed = all.filter((node) => node.id)
  if (renamed.length === 0) return
  for (const node of all) {
    for (const name of REFERENCING) {
      const value = node.getAttribute(name)
      if (!value?.includes("url(#")) continue
      node.setAttribute(
        name,
        renamed.reduce(
          (v, { id }) => v.replaceAll(`url(#${id})`, `url(#${id}-drag)`),
          value,
        ),
      )
    }
  }
  for (const node of renamed) node.id = `${node.id}-drag`
}

function standIn(kind: Kind, rect: Rect | null): Art {
  const el = make("absolute top-0 left-0")
  if (kind === "template") {
    el.className += " rounded-[5px] bg-background shadow-md ring-1 ring-border"
    el.style.width = `${ART}px`
    el.style.height = `${ART * 0.75}px`
    return { el, w: ART, h: ART * 0.75, rect }
  }
  const h = ART * 0.8
  el.style.width = `${ART}px`
  el.style.height = `${h}px`
  const root = createRoot(el)
  flushSync(() =>
    root.render(React.createElement(FolderGlyph, { className: "size-full" })),
  )
  return { el, w: ART, h, rect, dispose: () => queueMicrotask(() => root.unmount()) }
}

export type Lift = {
  follow: (p: Point) => void
  /** Shrink into `target`'s centre, then call `done`. */
  drop: (target: Rect, done: () => void) => void
  /** Fly every copy back to the art it came from (the grabbed one's first), then call `done`. */
  cancel: (back: (Rect | null)[], done: () => void) => void
  remove: () => void
}

export function createLift({
  title,
  count,
  main,
  behind,
  pointer,
  reduced,
  touch,
}: {
  title: string
  /** More than one: the grabbed copy wears the count. */
  count: number
  /** The grabbed card's copy, which is drawn in front. */
  main: Art
  /** Up to STACK_BEHIND of the other carried cards' copies. */
  behind: Art[]
  pointer: Point
  reduced: boolean
  touch: boolean
}): Lift {
  const root = make("pointer-events-none fixed top-0 left-0 z-50")
  root.style.willChange = "transform"
  root.style.transform = `translate3d(${pointer.x}px,${pointer.y}px,0)`
  const drop = make("absolute top-0 left-0", root)
  document.body.appendChild(root)

  const arts = [main, ...behind]
  const restOf = (art: Art, off = { x: 0, y: 0, r: 0 }) => ({
    x: CENTRE.x - art.w / 2 + off.x,
    y: CENTRE.y - art.h / 2 + off.y,
    r: off.r,
  })
  // A copy's scale is that of its card's art on screen, so it starts the size
  // it was; clamped so a stand-in over a whole card does not fly in huge.
  const scaleFrom = (art: Art, rect: Rect) =>
    Math.min(4, Math.max(0.2, (rect.right - rect.left) / art.w))
  // Where a copy's own top-left is, in the lift's coordinates, to sit on `rect`.
  const placeOn = (art: Art, rect: Rect, at: Point) => {
    const c = centreOf(rect)
    return { x: c.x - at.x - art.w / 2, y: c.y - at.y - art.h / 2 }
  }

  arts.forEach((art, i) => {
    const rest = i === 0 ? restOf(art) : restOf(art, FAN[i - 1])
    const scale = i === 0 && touch ? 1.06 : 1
    const delay = i * STAGGER
    art.el.style.zIndex = String(-i)
    drop.appendChild(art.el)
    if (reduced || !art.rect) {
      art.el.style.opacity = "0"
      animate(
        art.el,
        {
          x: [rest.x, rest.x],
          y: [rest.y, rest.y],
          rotate: [rest.r, rest.r],
          scale: [scale, scale],
          opacity: [0, 1],
        },
        { ...fade, delay: reduced ? 0 : delay },
      )
      return
    }
    const from = placeOn(art, art.rect, pointer)
    const s = scaleFrom(art, art.rect)
    art.el.style.transform = `translate(${from.x}px,${from.y}px) scale(${s})`
    animate(
      art.el,
      {
        x: [from.x, rest.x],
        y: [from.y, rest.y],
        rotate: [0, rest.r],
        scale: [s, scale],
        ...(i === 0 ? {} : { opacity: [0.6, 1] }),
      },
      { ...spring, delay },
    )
  })

  const label = make(
    "absolute w-max max-w-[140px] -translate-x-1/2 truncate rounded-md bg-background px-1.5 py-0.5 text-xs font-medium text-foreground shadow-sm ring-1 ring-border",
    drop,
  )
  label.textContent = title
  label.style.left = `${CENTRE.x}px`
  label.style.top = `${CENTRE.y + main.h / 2 + LABEL_GAP}px`
  const tags = [label]
  if (count > 1) {
    const badge = make(
      "absolute grid h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary px-1 text-[11px] leading-none font-medium text-primary-foreground tabular-nums ring-2 ring-background",
      drop,
    )
    badge.textContent = String(count)
    badge.style.left = `${CENTRE.x + main.w / 2}px`
    badge.style.top = `${CENTRE.y - main.h / 2}px`
    tags.push(badge)
  }
  for (const tag of tags) {
    tag.style.opacity = "0"
    animate(tag, { opacity: [0, 1] }, { ...fade, delay: reduced ? 0 : 0.08 })
  }

  let removed = false
  let at = pointer
  const remove = () => {
    removed = true
    root.remove()
    for (const art of arts) art.dispose?.()
  }

  return {
    follow(p) {
      at = p
      root.style.transform = `translate3d(${p.x}px,${p.y}px,0)`
    },
    drop(target, done) {
      const { x: px, y: py } = at
      const t = centreOf(target)
      const finish = () => {
        remove()
        done()
      }
      if (reduced) {
        void animate(drop, { opacity: 0 }, fade).finished.then(finish)
        return
      }
      drop.style.transformOrigin = `${CENTRE.x}px ${CENTRE.y}px`
      void animate(
        drop,
        { x: t.x - (px + CENTRE.x), y: t.y - (py + CENTRE.y), scale: 0.2, opacity: 0 },
        { duration: 0.25, ease: [...motionTokens.ease.inOut] },
      ).finished.then(finish)
    },
    cancel(back, done) {
      if (removed) return done()
      if (reduced) {
        void animate(drop, { opacity: 0 }, fade).finished.then(() => {
          remove()
          done()
        })
        return
      }
      const fadeAt = { duration: 0.2, delay: 0.1 }
      // ⚠ RELATIVE TO WHERE THE CURSOR IS NOW, not where the lift began: the
      // outer element has followed the pointer since.
      arts.forEach((art, i) => {
        const to = back[i]
        if (to) {
          const p = placeOn(art, to, at)
          animate(art.el, { ...p, scale: scaleFrom(art, to), rotate: 0 }, spring)
        }
        animate(art.el, { opacity: 0 }, to ? fadeAt : { duration: 0.15 })
      })
      for (const tag of tags) animate(tag, { opacity: 0 }, fade)
      window.setTimeout(() => {
        remove()
        done()
      }, 300)
    },
    remove,
  }
}
