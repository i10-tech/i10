/**
 * The gesture engine's brain: no DOM, no React, nothing that moves.
 *
 * Modelled on SpringBoard's home screen gesture. A press becomes a gesture after
 * HYSTERESIS; then on every frame `decide` recomputes the gesture's FINAL
 * DESTINATION, with a named reason, from the samples so far. The screen previews
 * that destination live and only release commits it.
 *
 * ⚠ ALL COORDINATES PASSED TO `decide` ARE IN ONE SPACE (the scroller's content
 * space), except `samples`, which are viewport pixels with timestamps: velocity
 * must not include the page scrolling under a still pointer.
 */

/** Every tuning number, in one place. Start values are iOS 26.4 SpringBoard's. */
export const TUNING = {
  /** Mouse movement, in px, before a press becomes a gesture. */
  HYSTERESIS: 5,
  /** Touch: how long a finger must rest before it lifts, in ms. */
  TOUCH_HOLD_MS: 350,
  /** Touch: movement during the hold, in px, that cancels it (it is a scroll). */
  TOUCH_SLOP: 8,
  /** Velocity is measured over the samples of this many ms, not the last delta. */
  VELOCITY_WINDOW_MS: 70,
  /** Deceleration rate of the flick projection (UIScrollView's normal rate). */
  DECELERATION_RATE: 0.998,
  /** A release faster than this, in px/s, may be a flick onto a target. */
  FLICK_MIN_VELOCITY: 200,
  /** Leaving an armed or hovered target takes this many px outside its rect. */
  LEAVE_MARGIN: 12,
  /** Edge auto-scroll: distance from the scroller's top or bottom edge, in px, where the page scrolls. */
  EDGE: 48,
  /** Edge auto-scroll: the most px scrolled in one frame. */
  MAX_SCROLL_PER_FRAME: 40,
} as const

export type Point = { x: number; y: number }
export type Sample = Point & { t: number }
export type Rect = { left: number; top: number; right: number; bottom: number }
export type Item = { key: string; rect: Rect }
export type Target = { key: string; to: string | null; rect: Rect }

/** What the pointer went down on, as the DOM reports it. */
export type PressTarget =
  | { kind: "control" }
  | { kind: "empty" }
  | { kind: "checkbox"; key: string; ticked: boolean }
  | {
      kind: "card"
      key: string
      /** The card is ticked. */
      selected: boolean
    }

/** What a press turns into once it crosses the hysteresis. */
export type Plan =
  | { kind: "ignore" }
  | { kind: "sweep"; to: boolean }
  | { kind: "box"; additive: boolean }
  | { kind: "lift"; origin: string; carry: "selection" | "origin" }

export type PressInput = {
  target: PressTarget
  /** ⇧, ⌘ or Ctrl was held. */
  additive: boolean
  touch: boolean
}

/**
 * ⚠ THE PRESS DECIDES WHAT THE GESTURE CAN BE, as in Finder. A card, template
 * or folder, is lifted; ticked, it carries the whole selection. Empty space
 * boxes, a checkbox sweeps, and a modifier on a card boxes from right there.
 */
export function planPress(input: PressInput): Plan {
  const { target, additive, touch } = input
  if (target.kind === "control") return { kind: "ignore" }
  if (target.kind === "checkbox") return { kind: "sweep", to: !target.ticked }
  if (target.kind === "empty") {
    return touch ? { kind: "ignore" } : { kind: "box", additive }
  }
  if (additive && !touch) return { kind: "box", additive: true }
  return {
    kind: "lift",
    origin: target.key,
    carry: target.selected ? "selection" : "origin",
  }
}

export type Destination =
  | { kind: "none"; reason: string }
  | { kind: "select"; keys: Set<string>; reason: string }
  | { kind: "move"; keys: string[]; to: string | null; target: string; reason: string }

/** What a lift carries and what it may not be dropped on. */
export type Carry = {
  /** Selection keys carried: a template's id, or `folder:<id>`. */
  keys: string[]
  /** Where each carried item is now (its folder, or null at the top). */
  homes: (string | null)[]
  /**
   * Folders that cannot take the load: every carried folder and every folder
   * inside one. Dropping a folder there would put it inside itself.
   */
  blocked: Set<string>
}

/** Whether `target` takes this load: never inside what is carried, never where all of it already is. */
export function dropAllowed(carry: Carry, target: Target): boolean {
  if (target.to !== null && carry.blocked.has(target.to)) return false
  return !carry.homes.every((home) => home === target.to)
}

/** Everything `decide` knows about one frame. */
export type Frame = {
  plan: Exclude<Plan, { kind: "ignore" }>
  press: Point
  pointer: Point
  /** Viewport samples, newest last. */
  samples: Sample[]
  /** The button is up: this frame is the commit. */
  released: boolean
  items: Item[]
  targets: Target[]
  carry: Carry | null
  /** The selection the gesture adds to (or replaces, when empty). */
  base: Set<string>
}

/** What `decide` remembers from frame to frame. */
export type Memory = {
  /** The target the lift has latched onto. */
  armed: string | null
  visited: Set<string>
  last: Point | null
}

export function freshMemory(press: Point): Memory {
  return { armed: null, visited: new Set(), last: press }
}

export function inside(rect: Rect, p: Point, margin = 0): boolean {
  return (
    p.x >= rect.left - margin &&
    p.x <= rect.right + margin &&
    p.y >= rect.top - margin &&
    p.y <= rect.bottom + margin
  )
}

export function boxOf(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  }
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom
}

/** Whether the segment a-b crosses the rect (Liang-Barsky). */
export function segmentHits(rect: Rect, a: Point, b: Point): boolean {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return (
    clip(-dx, a.x - rect.left) &&
    clip(dx, rect.right - a.x) &&
    clip(-dy, a.y - rect.top) &&
    clip(dy, rect.bottom - a.y)
  )
}

export function crossedHysteresis(down: Point, now: Point): boolean {
  return Math.hypot(now.x - down.x, now.y - down.y) >= TUNING.HYSTERESIS
}

/** Pointer velocity in px/s over the last VELOCITY_WINDOW_MS of samples. */
export function velocityOf(samples: Sample[]): Point {
  const last = samples[samples.length - 1]
  if (!last) return { x: 0, y: 0 }
  let first = last
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]!
    if (last.t - s.t > TUNING.VELOCITY_WINDOW_MS) break
    first = s
  }
  const dt = last.t - first.t
  if (dt <= 0) return { x: 0, y: 0 }
  return { x: ((last.x - first.x) / dt) * 1000, y: ((last.y - first.y) / dt) * 1000 }
}

/** Where a pointer with velocity `v` px/s would coast to: UIScrollView's projection. */
export function project(v: number): number {
  const r = TUNING.DECELERATION_RATE
  return ((v / 1000) * r) / (1 - r)
}

const speedOf = (v: Point) => Math.hypot(v.x, v.y)

function targetAt(frame: Frame, p: Point, armed: string | null): Target | null {
  const { carry, targets } = frame
  if (!carry) return null
  const ok = targets.filter((t) => dropAllowed(carry, t))
  if (armed) {
    const keep = ok.find((t) => t.key === armed)
    // Latched: it takes LEAVE_MARGIN px outside to let go.
    if (keep && inside(keep.rect, p, TUNING.LEAVE_MARGIN)) return keep
  }
  return ok.find((t) => inside(t.rect, p)) ?? null
}

function touched(frame: Frame, box: Rect): Set<string> {
  const keys = new Set<string>()
  for (const item of frame.items) if (overlaps(item.rect, box)) keys.add(item.key)
  return keys
}

function moveTo(frame: Frame, target: Target, reason: string): Destination {
  return {
    kind: "move",
    keys: frame.carry!.keys,
    to: target.to,
    target: target.key,
    reason,
  }
}

/** The flick's landing, when a fast release coasts onto a target. */
function flickTarget(frame: Frame): Target | null {
  const v = velocityOf(frame.samples)
  if (speedOf(v) < TUNING.FLICK_MIN_VELOCITY) return null
  const landing = {
    x: frame.pointer.x + project(v.x),
    y: frame.pointer.y + project(v.y),
  }
  return targetAt(frame, landing, null)
}

/**
 * The gesture's final destination if the button went up now, plus what to
 * remember for the next frame.
 */
export function decide(
  frame: Frame,
  memory: Memory,
): { destination: Destination; memory: Memory } {
  const next: Memory = { ...memory, last: frame.pointer }
  const { plan, pointer, press } = frame

  if (plan.kind === "sweep") {
    const visited = new Set(next.visited)
    const from = memory.last ?? press
    for (const item of frame.items) {
      if (segmentHits(item.rect, from, pointer)) visited.add(item.key)
    }
    const origin = frame.items.find((i) => inside(i.rect, press))
    if (origin) visited.add(origin.key)
    next.visited = visited
    const keys = new Set(frame.base)
    for (const key of visited) {
      if (plan.to) keys.add(key)
      else keys.delete(key)
    }
    return {
      destination: {
        kind: "select",
        keys,
        reason: plan.to ? "SweepTick" : "SweepUntick",
      },
      memory: next,
    }
  }

  if (plan.kind === "box") {
    // A plain box starts afresh and selects what it covers, selected before or
    // not. ⚠ WITH ⇧ OR ⌘ IT TOGGLES WHAT IT COVERS, as Finder's ⌘-drag does:
    // the rest stays, a card already selected is unselected, any other added.
    const hit = touched(frame, boxOf(press, pointer))
    if (!plan.additive) {
      return { destination: { kind: "select", keys: hit, reason: "Box" }, memory: next }
    }
    const keys = new Set(frame.base)
    for (const k of hit) {
      if (frame.base.has(k)) keys.delete(k)
      else keys.add(k)
    }
    return { destination: { kind: "select", keys, reason: "Box" }, memory: next }
  }

  const hit = targetAt(frame, pointer, memory.armed)
  if (hit) {
    next.armed = hit.key
    return { destination: moveTo(frame, hit, "MoveByDrop"), memory: next }
  }
  next.armed = null
  if (frame.released) {
    const flick = flickTarget(frame)
    if (flick) return { destination: moveTo(frame, flick, "MoveByFlick"), memory: next }
  }
  return { destination: { kind: "none", reason: "NotOverTarget" }, memory: next }
}
