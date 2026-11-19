"use client"

import * as React from "react"
import { animate, useReducedMotion } from "motion/react"
import { HeightFrame } from "../skeleton/skeleton"
import styles from "./bone.module.css"
import { place, shimmerClass, shimmerRef } from "../shimmer/shimmer"

/*
 * A bone is one piece of data on a page that loads: while loading it draws a
 * bar the size of the content's line, and when the content arrives the bar
 * stretches into the content's box while the content sharpens in.
 * See docs/decisions/skeletons.md, sections 5 and 6.
 *
 * ⚠ A SKELETON AND ITS PAGE ARE DIFFERENT INSTANCES (loading.tsx, then the
 * page), so a bone cannot keep its own DOM across the swap. A loading bone
 * leaves its bars' boxes in `departing` as it unmounts; a content bone that
 * mounts in the same commit claims them. Bars nobody claims are painted by a
 * body layer and faded. All of it is imperative: no React renders per frame,
 * and only transform, opacity and filter move.
 */

const BAR = 0.6
const STEP = 40
const SPREAD = 320
const CONTENT_MS = 230
const FADE_MS = 160
/** How long a departed bar waits for its content before it is forgotten. */
const HOLD = 200
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

interface Box { x: number; y: number; w: number; h: number }
interface Departed { boxes: Box[]; radii: string[]; wave: string; at: number }

const departing = new Map<string, Departed>()
const lastDeparture = new Map<string, number>()

interface Job {
  key: string
  wave: string
  unit: string | null
  el: HTMLElement
  lines: number
  claim: Departed | undefined
  cancelled: boolean
  target?: Box
  /** The bone's own box is empty: its content is out of flow. See `sharpen`. */
  hollow?: boolean
}
const queue = new Map<string, Job[]>()
/** Waves whose loaded page mounted since the last flush. */
const arrived = new Set<string>()
let scheduled = false

// ── Scopes ──────────────────────────────────────────────────────────────

interface Scope { path: string; loading: boolean; wave: string; unit: string | null }
const ScopeContext = React.createContext<Scope>({ path: "", loading: false, wave: "", unit: null })

/**
 * A group of bones that load together. Nested scopes share the outermost
 * scope's wave (one reading-order stagger); `independent` starts its own, which
 * runs in parallel; `unit` makes everything inside stagger as one step (a row).
 */
export function BoneScope({
  id,
  loading,
  unit = false,
  independent = false,
  children,
}: {
  id: string
  /** Defaults to the parent scope's. */
  loading?: boolean
  unit?: boolean
  independent?: boolean
  children: React.ReactNode
}) {
  const parent = React.useContext(ScopeContext)
  const path = parent.path ? `${parent.path}/${id}` : id
  const isLoading = loading ?? parent.loading
  const wave = !parent.wave || independent ? path : parent.wave
  const unitPath = unit ? path : parent.unit
  const value = React.useMemo<Scope>(
    () => ({ path, loading: isLoading, wave, unit: unitPath }),
    [path, isLoading, wave, unitPath],
  )
  // A wave's page arriving retires the bars it left, even when no content
  // takes their place (three rows remembered, the list now empty).
  React.useLayoutEffect(() => {
    if (wave !== path || isLoading) return
    arrived.add(wave)
    schedule()
  }, [wave, path, isLoading])
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

// ── Registry ────────────────────────────────────────────────────────────

function readBars(root: HTMLElement): { boxes: Box[]; radii: string[] } {
  const boxes: Box[] = []
  const radii: string[] = []
  for (const bar of root.querySelectorAll<HTMLElement>("[data-bone-bar]")) {
    const r = bar.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const style = getComputedStyle(bar)
    boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height })
    radii.push(style.borderRadius)
  }
  return { boxes, radii }
}

function depart(key: string, wave: string, root: HTMLElement) {
  const { boxes, radii } = readBars(root)
  if (boxes.length === 0) return
  const at = performance.now()
  departing.set(key, { boxes, radii, wave, at })
  lastDeparture.set(wave, at)
  schedule()
}

function take(key: string): Departed | undefined {
  const d = departing.get(key)
  if (!d) return undefined
  departing.delete(key)
  return performance.now() - d.at <= HOLD ? d : undefined
}

function schedule() {
  if (scheduled) return
  scheduled = true
  queueMicrotask(flush)
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

let layer: HTMLElement | null = null
function ghostLayer(): HTMLElement {
  if (layer?.isConnected) return layer
  layer = document.createElement("div")
  layer.className = styles.layer!
  layer.setAttribute("aria-hidden", "true")
  document.body.append(layer)
  return layer
}

function ghost(box: Box, radius: string) {
  const el = document.createElement("span")
  el.className = `${styles.ghost} ${shimmerClass}`
  Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, borderRadius: radius })
  ghostLayer().append(el)
  // It carries the bar's shimmer on, so a bar caught mid-band keeps its band.
  place(el, box.x)
  return el
}

const onScreen = (b: Box) => b.y + b.h > 0 && b.y < window.innerHeight && b.x + b.w > 0 && b.x < window.innerWidth

/** A start, run on the frame after its first state painted (see `run`). */
type Start = () => void

/** A bar nothing replaced: it fades where it stood. */
function fadeAway(d: Departed, starts: Start[]) {
  d.boxes.forEach((box, i) => {
    if (!onScreen(box)) return
    const el = ghost(box, d.radii[i] ?? "9999px")
    starts.push(() => {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out", fill: "forwards" }).onfinish = () => el.remove()
    })
  })
}

/** The content's own box: its text or elements, on the line box the bone holds. */
function contentBox(el: HTMLElement): Box {
  const own = el.getBoundingClientRect()
  const range = document.createRange()
  range.selectNodeContents(el)
  const inner = range.getBoundingClientRect()
  if (inner.width === 0 && inner.height === 0) return { x: own.left, y: own.top, w: own.width, h: own.height }
  const elements = el.firstElementChild !== null
  const ink = elements ? inkSpan(el, own) : null
  // Elements that draw nothing (a segment with no description keeps its empty
  // line): no width, so the bar fades where it stands (see `stretch`).
  if (elements && !ink) return { x: own.left, y: own.top, w: 0, h: own.height }
  return {
    x: ink?.left ?? inner.left,
    w: ink ? ink.right - ink.left : inner.width,
    y: elements ? inner.top : own.top,
    h: elements ? inner.height : own.height,
  }
}

/*
 * ⚠ ACROSS, A BAR STRETCHES TO WHAT IS DRAWN, NOT TO THE BOXES (2026-11-18).
 * Content is usually a block - `<p className="truncate">` - and a block is as
 * wide as its column, so a title bar grew to the whole card or cell while its
 * text sat at the left: the bar overshot the words and smeared as it faded.
 * What is drawn is the text, and the leaves that paint (an icon, a pill with a
 * fill, a checkbox's square); a painted box stands for everything inside it.
 * Truncated text lays out past its box, so the span is clipped to the bone's.
 */
function inkSpan(el: HTMLElement, own: DOMRect): { left: number; right: number } | null {
  let left = Infinity
  let right = -Infinity
  const range = document.createRange()
  const add = (r: DOMRect) => {
    if (r.width === 0 || r.height === 0) return
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent?.trim()) return
      range.selectNodeContents(node)
      add(range.getBoundingClientRect())
      return
    }
    if (!(node instanceof Element)) return
    if (node instanceof SVGElement || node instanceof HTMLImageElement) return add(node.getBoundingClientRect())
    const style = getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden") return
    if (paints(style)) return add(node.getBoundingClientRect())
    node.childNodes.forEach(visit)
  }
  el.childNodes.forEach(visit)
  if (left > right) return null
  if (own.width > 0) {
    left = Math.max(left, own.left)
    right = Math.min(right, own.right)
  }
  return left < right ? { left, right } : null
}

const paints = (style: CSSStyleDeclaration) =>
  !/^transparent$|,\s*0\)$|\/\s*0\)$/.test(style.backgroundColor) ||
  (style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0)

/** Where the bars start and end, line by line. */
function stretch(job: Job, reduced: boolean, delay: number, starts: Start[]) {
  const { claim, target } = job
  if (!claim || !target) return
  const rowH = target.h / job.lines
  claim.boxes.forEach((from, i) => {
    const row = Math.min(i, job.lines - 1)
    const last = job.lines > 1 && row === job.lines - 1
    const to: Box = { x: target.x, y: target.y + row * rowH, w: last ? Math.min(target.w, from.w) : target.w, h: rowH }
    if (!onScreen(to) && !onScreen(from)) return
    const radius = claim.radii[i] ?? "9999px"
    if (reduced || to.w < 1 || to.h < 1) {
      const el = ghost(from, radius)
      starts.push(() => {
        el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay, easing: "ease-out", fill: "both" }).onfinish = () => el.remove()
      })
      return
    }
    const el = ghost(from, radius)
    // The box itself moves, not a scale of it, so the pill's ends stay round.
    // The layer is contained, so this never lays out the page.
    const at = (p: number) => {
      const x = from.x + (to.x - from.x) * p
      el.style.left = `${x}px`
      el.style.setProperty("--shimmer-x", `${x}px`)
      el.style.top = `${from.y + (to.y - from.y) * p}px`
      el.style.width = `${from.w + (to.w - from.w) * p}px`
      el.style.height = `${from.h + (to.h - from.h) * p}px`
    }
    starts.push(() => {
      // Critically damped: the bar settles into the box and never overshoots it.
      animate(0, 1, {
        type: "spring",
        visualDuration: 0.3,
        bounce: 0,
        delay: delay / 1000,
        onUpdate: at,
        onComplete: () => el.remove(),
      })
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, delay, easing: EASE, fill: "both" })
    })
  })
}

/*
 * ⚠ NO BLUR ON A HOLLOW BONE (2026-11-17). A filter makes its element the
 * containing block of every absolutely positioned descendant. A bone with no
 * box of its own (its content is `absolute`, placed against an ancestor) would
 * lay that content out against a 0px box for the whole sharpen, then snap it
 * to its real size when the filter goes: the template card's sheet drew as an
 * 8px strip and then jumped. Opacity changes no containing block, so a hollow
 * bone only fades. A bone that should blur gives itself the box (`absolute
 * inset-0`, `h-full`).
 */
function sharpen(job: Job, reduced: boolean, delay: number, starts: Start[]) {
  const { el } = job
  const frames = reduced || job.hollow
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0px)" }]
  // Until it starts, the content stays at the opacity 0 its bone set.
  starts.push(() => {
    if (job.cancelled) return
    const a = el.animate(frames, { duration: reduced ? 120 : CONTENT_MS, delay, easing: EASE, fill: "both" })
    el.style.opacity = ""
    a.onfinish = () => a.cancel()
    active.get(el)?.cancel()
    active.set(el, a)
  })
}
const active = new WeakMap<HTMLElement, Animation>()

/*
 * ⚠ THE RESOLVE'S CLOCKS START ONE FRAME AFTER ITS FIRST STATE PAINTS
 * (2026-11-09). An animation's clock runs through whatever holds the frame: the
 * commit that swaps a page in (100-250ms in dev), then the first frame of the
 * resolve itself, which paints every ghost bar and blurs every block (267ms on
 * Segments). Started at either point, the 230ms sharpen was over before it was
 * seen, and the page read as a hard cut. So `run` draws the first state on one
 * frame - the bars where the skeleton's stood, the content held at opacity 0 -
 * and the clocks start on the next, after that state is on screen.
 */
function flush() {
  scheduled = false
  requestAnimationFrame(run)
}

function run() {
  const starts: Start[] = []
  const reduced = reducedMotion()
  const waves = new Set<string>(arrived)
  arrived.clear()
  for (const [wave, all] of queue) {
    const jobs = all.filter((j) => !j.cancelled && j.el.isConnected)
    if (jobs.length === 0) continue
    waves.add(wave)
    jobs.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    // Measure everything first, then write, so reads never follow a write.
    const tops = new Map<string, number>()
    for (const job of jobs) {
      job.target = contentBox(job.el)
      const own = job.el.getBoundingClientRect()
      job.hollow = own.width === 0 || own.height === 0
      if (job.unit !== null) tops.set(job.unit, Math.min(tops.get(job.unit) ?? Infinity, own.top))
    }
    /*
     * Reading order; the whole spread is capped. A unit (a row, a card) steps
     * as one, and ⚠ UNITS SIDE BY SIDE STEP TOGETHER (2026-11-18): a grid's
     * cards are a unit each, and stepping them one by one swept the row left to
     * right, a card at a time. Cards in one row are separate panels, which
     * resolve at once, as the reference's two cards do; the rows step.
     */
    const slots = new Map<string, number>()
    const order = jobs.map((j) => {
      const k = j.unit === null ? `bone:${j.key}` : `row:${Math.round(tops.get(j.unit)!)}`
      if (!slots.has(k)) slots.set(k, slots.size)
      return slots.get(k)!
    })
    const step = slots.size > 1 ? Math.min(STEP, SPREAD / (slots.size - 1)) : 0
    jobs.forEach((job, i) => {
      const delay = order[i]! * step
      sharpen(job, reduced, delay, starts)
      stretch(job, reduced, delay, starts)
    })
  }
  queue.clear()
  const now = performance.now()
  for (const [key, d] of departing) {
    // Its page arrived: fade, however long the commit held the frame.
    if (waves.has(d.wave)) {
      departing.delete(key)
      fadeAway(d, starts)
    } else if (now - d.at > HOLD) departing.delete(key)
  }
  if (starts.length > 0) requestAnimationFrame(() => starts.forEach((start) => start()))
}

function enqueue(job: Job) {
  const jobs = queue.get(job.wave) ?? []
  jobs.push(job)
  queue.set(job.wave, jobs)
  schedule()
}

/** Whether the enclosing scope is loading, for a piece that must decide before it renders a Bone. */
export function useBoneLoading(): boolean {
  return React.useContext(ScopeContext).loading
}

// ── Bone ────────────────────────────────────────────────────────────────

export interface BoneProps {
  /** Unique within its scope. The loading bar and the content it becomes share it. */
  id: string
  /** Defaults to the scope's. */
  loading?: boolean
  /** "text": pill bars sized to the line. "box": a fixed box (badge, button). "circle": an avatar. */
  shape?: "text" | "box" | "circle"
  /** Text lines; the last of several is shorter. */
  lines?: number
  /** The content's line height in px; the text bar is 60% of it, centred. */
  lineHeight?: number
  /** Bar width: px or a CSS length. Text defaults to 70%. Inline bones need px. */
  width?: number | string
  /**
   * Box height in px or a CSS length; a circle's diameter (defaults to width).
   * A percentage fills the bone, so give the bone a height (`size-full`).
   */
  height?: number | string
  /** Corner radius of a box. */
  radius?: number | string
  /** Px between the box and the bar, for content with a hit area bigger than its drawing (a checkbox). */
  inset?: number
  /** Which side the bar sits on, for right-aligned content. */
  align?: "start" | "end"
  /** Shrink to the content (inline-flex) instead of filling the line. */
  inline?: boolean
  as?: "span" | "div"
  className?: string
  children?: React.ReactNode
}

const px = (v: number | string) => (typeof v === "number" ? `${v}px` : v)

export function Bone({
  id,
  loading: loadingProp,
  shape = "text",
  lines = 1,
  lineHeight = 20,
  width,
  height,
  radius = 8,
  inset = 0,
  align = "start",
  inline = false,
  as = "span",
  className,
  children,
}: BoneProps) {
  const scope = React.useContext(ScopeContext)
  const loading = loadingProp ?? scope.loading
  const key = scope.path ? `${scope.path}/${id}` : id
  const wave = scope.wave || key
  const root = React.useRef<HTMLElement>(null)
  const was = React.useRef(loading)
  const claim = React.useRef<Departed | undefined>(undefined)
  const rel = React.useRef<Departed | undefined>(undefined)

  // While loading, remember the bars relative to the bone, for an in-place resolve.
  React.useLayoutEffect(() => {
    const el = root.current
    if (!loading || !el) return
    const own = el.getBoundingClientRect()
    const { boxes, radii } = readBars(el)
    rel.current = { boxes: boxes.map((b) => ({ ...b, x: b.x - own.left, y: b.y - own.top })), radii, wave, at: 0 }
  })

  // Leaving the page while loading: hand the bars to whatever replaces them.
  const latest = React.useRef({ loading, key, wave })
  React.useLayoutEffect(() => { latest.current = { loading, key, wave } })
  React.useLayoutEffect(
    () => () => {
      const el = root.current
      if (latest.current.loading && el) depart(latest.current.key, latest.current.wave, el)
    },
    [],
  )

  // Content arriving: claim the bars that stood here and play the resolve.
  React.useLayoutEffect(() => {
    const el = root.current
    if (loading) {
      was.current = true
      claim.current = undefined
      return
    }
    if (!el) return
    let found = claim.current
    if (!found && was.current && rel.current) {
      // The same bone, toggled in place.
      const own = el.getBoundingClientRect()
      found = { ...rel.current, boxes: rel.current.boxes.map((b) => ({ ...b, x: b.x + own.left, y: b.y + own.top })), at: performance.now() }
    }
    found ??= take(key)
    claim.current = found
    was.current = false
    const swapping = performance.now() - (lastDeparture.get(wave) ?? -Infinity) <= HOLD
    if (!found && !swapping) return
    el.style.opacity = "0"
    const job: Job = { key, wave, unit: scope.unit, el, lines, claim: found, cancelled: false }
    enqueue(job)
    return () => {
      job.cancelled = true
      el.style.opacity = ""
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  // Middle, not baseline: a bar has no text to hang from, and the content it becomes does.
  // ⚠ `minWidth: 0` LETS TRUNCATED TEXT INSIDE SHRINK. A bone is often a flex
  // child (a table's cell link), and a flex child never shrinks below its
  // content, so a long subject ran over the next column (2026-11-09).
  const rootStyle: React.CSSProperties = inline
    ? { display: "inline-flex", verticalAlign: "middle", minWidth: 0 }
    : { display: "block", minWidth: 0 }
  const Tag = as
  if (!loading) {
    return (
      <Tag ref={root as never} data-bone={key} data-state="content" className={className} style={rootStyle}>
        {children}
      </Tag>
    )
  }

  const solid = shape !== "text"
  const w = width ?? (solid ? undefined : "70%")
  const box = solid ? (height ?? (typeof width === "number" ? width : 16)) : Math.round(lineHeight * BAR)
  const h = typeof box === "number" ? box - 2 * inset : inset ? `calc(${box} - ${2 * inset}px)` : box
  const count = solid ? 1 : Math.max(1, lines)
  const round = shape === "circle" ? "50%" : shape === "box" ? px(radius) : "9999px"
  return (
    <Tag ref={root as never} data-bone={key} data-state="loading" className={className} style={rootStyle}>
      {Array.from({ length: count }, (_, i) => {
        const shorter = !solid && count > 1 && i === count - 1
        return (
          // ⚠ AN INSET BONE HOLDS ITS WHOLE BOX, NOT ONLY ITS BAR (2026-11-18). The
          // bar is the checkbox's 18px square; the checkbox is a 36px hit area.
          // Without the box the tick column was 18px narrower while loading, so
          // every column of the table jumped right when the rows arrived.
          <span key={i} className={styles.line} style={{ height: solid ? box : lineHeight, width: inset ? px(w ?? box) : undefined, justifyContent: inset ? "center" : align === "end" ? "flex-end" : undefined }}>
            <span
              data-bone-bar=""
              ref={shimmerRef}
              className={`${styles.bar} ${shimmerClass}`}
              style={{ width: shorter && w !== undefined ? `calc(${px(w)} * 0.6)` : typeof w === "number" ? w - 2 * inset : w, height: h, borderRadius: round }}
            />
          </span>
        )
      })}
    </Tag>
  )
}

// ── Region ──────────────────────────────────────────────────────────────

const regions = new Map<string, { h: number; at: number }>()

/**
 * A stretch of page whose height follows its content - the table that grows
 * from three skeleton rows to ten. Across the loading swap the new region
 * eases from the height the skeleton had.
 */
export function BoneRegion({ id, loading: loadingProp, className, children }: { id: string; loading?: boolean; className?: string; children: React.ReactNode }) {
  const scope = React.useContext(ScopeContext)
  const loading = loadingProp ?? scope.loading
  const key = `${scope.path || "region"}/${id}`
  const reduce = useReducedMotion()
  const box = React.useRef<HTMLDivElement>(null)
  const latest = React.useRef({ loading, key })
  React.useLayoutEffect(() => { latest.current = { loading, key } })
  React.useLayoutEffect(
    () => () => {
      if (latest.current.loading && box.current) regions.set(latest.current.key, { h: box.current.getBoundingClientRect().height, at: performance.now() })
    },
    [],
  )
  const mountHeight = () => {
    const r = regions.get(key)
    regions.delete(key)
    return r && !loading && performance.now() - r.at <= HOLD ? r.h : undefined
  }
  return (
    <div ref={box}>
      <HeightFrame className={className} busy={loading} reduce={reduce} mountHeight={mountHeight}>
        {children}
      </HeightFrame>
    </div>
  )
}
