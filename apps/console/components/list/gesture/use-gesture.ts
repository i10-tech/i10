"use client"

import * as React from "react"
import {
  TUNING,
  crossedHysteresis,
  decide,
  freshMemory,
  type Carry,
  type Destination,
  type Frame,
  type Item,
  type Memory,
  type Plan,
  type PressTarget,
  type Rect,
  type Sample,
  type Target,
  planPress,
} from "./decide"
import { isFolderKey } from "@/lib/template-tree"
import {
  STACK_BEHIND,
  artRect,
  copyArt,
  createBox,
  createLift,
  type Box,
  type Lift,
} from "./overlay"

/**
 * A press on any of these is the control's own: nothing here starts a gesture.
 * Links are not in it: a card is a link, and a press on a card is a gesture.
 */
const CONTROL =
  "button, input, textarea, select, summary, label, [role=menu], [role=dialog], [role=toolbar], [role=menuitem], [contenteditable=true], [data-no-gesture]"

const CARD = "[data-select-key]"
const DROP = "[data-drop-to]"

type Options = {
  /** The list: the cards and drop targets are found inside it. */
  root: React.RefObject<HTMLElement | null>
  selected: Set<string>
  /** What a lift from `origin` carries; null when there is nothing to carry. */
  carryFor: (origin: string, carry: "selection" | "origin") => Carry | null
  /** The name of the card pressed; the lift labels its copy with it, and a badge counts when more come along. */
  titleFor: (origin: string) => string
  onSelect: (next: Set<string>) => void
  /** The keys that are lifted right now, or null. */
  onLift: (keys: Set<string> | null) => void
  /** The drop target to highlight (`root` for All templates), or null. */
  onOver: (target: string | null) => void
  onDrop: (keys: string[], to: string | null) => void
}

/**
 * One pointer gesture for the whole list: a box, a checkbox sweep, or a lift of
 * templates and folders onto a folder. `decide` (pure) says what the gesture
 * would do if it ended now; this hook measures, previews that and commits it on
 * release.
 *
 * ⚠ IT LISTENS ON THE WHOLE PAGE, NOT ONLY THE LIST, from just under the page
 * header (title, description, actions: text people select) to the bottom, so a
 * box starts in the toolbar's empty space, the margins and below a short list
 * too. Only the controls are left alone (CONTROL).
 *
 * ⚠ NOTHING HERE RENDERS PER POINTER MOVE. Moves are batched into one animation
 * frame, rects are measured once per gesture in the scroller's CONTENT
 * coordinates (so scrolling never invalidates them), and React hears only when
 * the selection, the lifted set or the highlighted target actually changes.
 *
 * ⚠ A PRESS THAT NEVER CROSSES THE HYSTERESIS IS A CLICK, and is left alone. A
 * press that did cross it swallows the click that follows, so a card is not
 * opened by being dragged.
 */
export function useGesture(options: Options): void {
  const latest = React.useRef(options)
  React.useEffect(() => {
    latest.current = options
  })
  const { root } = options

  React.useEffect(() => {
    const found = root.current
    if (!found) return
    const list: HTMLElement = found
    const el = list.closest<HTMLElement>("[data-slot=page]") ?? list
    let abort: (() => void) | null = null
    let touchActive = false

    // The browser's own link and image drag would fight every gesture here.
    const noNativeDrag = (e: Event) => e.preventDefault()
    // A held finger on a card is a long press to the OS, a context menu to the page.
    const noMenu = (e: Event) => {
      if (touchActive) e.preventDefault()
    }
    const noScroll = (e: TouchEvent) => {
      if (touchActive && e.cancelable) e.preventDefault()
    }
    el.addEventListener("dragstart", noNativeDrag)
    el.addEventListener("contextmenu", noMenu)
    el.addEventListener("touchmove", noScroll, { passive: false })

    function onDown(event: PointerEvent) {
      if (abort) return
      if (event.button !== 0 || !event.isPrimary) return
      const header = el.querySelector<HTMLElement>("[data-slot=page-header]")
      if (header && event.clientY < header.getBoundingClientRect().bottom) return
      const o = latest.current
      const touch = event.pointerType === "touch"
      const press = classify(event.target as Element, o.selected)
      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      const plan = planPress({ target: press, additive, touch })
      if (plan.kind === "ignore") return
      start(event, plan, touch, additive)
    }

    function start(
      event: PointerEvent,
      plan: Exclude<Plan, { kind: "ignore" }>,
      touch: boolean,
      additive: boolean,
    ) {
      const origin = plan.kind === "lift" ? plan.origin : null
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const before = new Set(latest.current.selected)
      const scroller = scrollParent(el)
      const down = { x: event.clientX, y: event.clientY }
      const samples: Sample[] = [{ ...down, t: performance.now() }]
      let pointer = down
      // "idle" until the hysteresis (and, for a finger, the hold) is passed.
      let state: "pressed" | "active" | "done" = "pressed"
      let raf = 0
      let stale = true
      let items: Item[] = []
      let targets: Target[] = []
      let view: Rect = { left: 0, top: 0, right: 0, bottom: 0 }
      let startAt = { x: 0, y: 0 }
      let carry: Carry | null = null
      let memory: Memory = freshMemory(startAt)
      let destination: Destination = { kind: "none", reason: "BelowHysteresis" }
      let lastSelect = before
      let lastOver: string | null = null
      let box: Box | null = null
      let lift: Lift | null = null
      /** The keys whose copies are drawn: the grabbed one, then up to STACK_BEHIND more. */
      let shown: string[] = []
      let holdTimer = 0
      let swallowTimer = 0

      const offset = () =>
        scroller
          ? { x: scroller.scrollLeft, y: scroller.scrollTop }
          : { x: window.scrollX, y: window.scrollY }
      const toContent = (p: { x: number; y: number }) => {
        const off = offset()
        return { x: p.x - view.left + off.x, y: p.y - view.top + off.y }
      }

      function measure() {
        const r = scroller?.getBoundingClientRect()
        view = r
          ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        const off = offset()
        const rectOf = (node: Element): Rect => {
          const b = node.getBoundingClientRect()
          return {
            left: b.left - view.left + off.x,
            top: b.top - view.top + off.y,
            right: b.right - view.left + off.x,
            bottom: b.bottom - view.top + off.y,
          }
        }
        items = Array.from(list.querySelectorAll<HTMLElement>(CARD)).map((n) => ({
          key: n.dataset.selectKey!,
          rect: rectOf(n),
        }))
        targets = Array.from(list.querySelectorAll<HTMLElement>(DROP)).map((n) => {
          const id = n.dataset.dropTo!
          return { key: id, to: id === "root" ? null : id, rect: rectOf(n) }
        })
        stale = false
      }

      function emitSelect(next: Set<string>) {
        if (next.size === lastSelect.size && [...next].every((k) => lastSelect.has(k)))
          return
        lastSelect = next
        latest.current.onSelect(next)
      }
      function emitOver(next: string | null) {
        if (next === lastOver) return
        lastOver = next
        latest.current.onOver(next)
      }

      const schedule = () => {
        if (state === "active" && !raf) raf = requestAnimationFrame(frame)
      }

      function frameInput(released: boolean): Frame {
        const p = toContent(pointer)
        const press = startAt
        return {
          plan: plan as Frame["plan"],
          press,
          pointer: p,
          samples,
          released,
          items,
          targets,
          carry,
          base: plan.kind === "lift" ? new Set() : before,
        }
      }

      function preview(d: Destination) {
        if (d.kind === "select") emitSelect(d.keys)
        else emitSelect(before)
        emitOver(d.kind === "move" ? (d.to ?? "root") : null)
      }

      function frame() {
        raf = 0
        if (stale) measure()
        // Near the top or bottom edge the page scrolls so the gesture can reach.
        const depth =
          pointer.y < view.top + TUNING.EDGE
            ? pointer.y - (view.top + TUNING.EDGE)
            : pointer.y > view.bottom - TUNING.EDGE
              ? pointer.y - (view.bottom - TUNING.EDGE)
              : 0
        if (depth !== 0) {
          const step =
            Math.sign(depth) *
            Math.min(TUNING.MAX_SCROLL_PER_FRAME, Math.ceil(Math.abs(depth) / 4))
          if (scroller) scroller.scrollTop += step
          else window.scrollBy(0, step)
        }

        // ⚠ A STILL POINTER SENDS NO EVENTS, so the frame stamps its own sample:
        // without it a pause would never be seen, and velocity would stay at the
        // last move's speed for as long as the hand rested.
        const now = performance.now()
        samples.push({ ...pointer, t: now })
        while (samples.length > 2 && now - samples[0]!.t > 200) samples.shift()
        const input = frameInput(false)
        const out = decide(input, memory)
        memory = out.memory
        destination = out.destination
        lift?.follow(pointer)

        if (box) {
          const off = offset()
          const x0 = Math.min(startAt.x, input.pointer.x)
          const x1 = Math.max(startAt.x, input.pointer.x)
          const y0 = Math.min(startAt.y, input.pointer.y)
          const y1 = Math.max(startAt.y, input.pointer.y)
          // Clipped to what the scroller shows, so it never paints over the chrome.
          box.place({
            left: Math.max(x0 - off.x + view.left, view.left),
            top: Math.max(y0 - off.y + view.top, view.top),
            right: Math.min(x1 - off.x + view.left, view.right),
            bottom: Math.min(y1 - off.y + view.top, view.bottom),
          })
        }
        preview(destination)
        schedule()
      }

      function begin(): boolean {
        state = "active"
        measure()
        startAt = toContent(down)
        memory = freshMemory(startAt)
        if (plan.kind === "lift") {
          carry = latest.current.carryFor(plan.origin, plan.carry)
          if (!carry) {
            stop(true)
            return false
          }
          latest.current.onLift(new Set(carry.keys))
          shown = [
            plan.origin,
            ...carry.keys.filter((key) => key !== plan.origin),
          ].slice(0, 1 + STACK_BEHIND)
          const [main, ...behind] = shown.map((key) =>
            copyArt(cardOf(key), isFolderKey(key) ? "folder" : "template"),
          )
          lift = createLift({
            title: latest.current.titleFor(plan.origin),
            count: carry.keys.length,
            main: main!,
            behind,
            pointer,
            reduced,
            touch,
          })
        }
        if (plan.kind === "box") box = createBox()
        document.body.style.userSelect = "none"
        window.getSelection()?.removeAllRanges()
        try {
          el.setPointerCapture(event.pointerId)
        } catch {
          // The pointer is already gone; the up handler ends the gesture.
        }
        armSwallow()
        touchActive = touch
        observer?.observe(list)
        ;(scroller ?? window).addEventListener("scroll", schedule, { passive: true })
        window.addEventListener("keydown", onKey, true)
        return true
      }

      // The click that follows a real gesture must not open the card under it.
      function armSwallow() {
        const swallow = (e: Event) => {
          e.preventDefault()
          e.stopPropagation()
        }
        window.addEventListener("click", swallow, true)
        const end = () => {
          swallowTimer = window.setTimeout(
            () => window.removeEventListener("click", swallow, true),
            60,
          )
        }
        window.addEventListener("pointerup", end, { once: true, capture: true })
        window.addEventListener("pointercancel", end, { once: true, capture: true })
      }

      function cardOf(key: string): HTMLElement | null {
        return list.querySelector<HTMLElement>(`[data-select-key="${CSS.escape(key)}"]`)
      }

      function cleanVisuals() {
        cancelAnimationFrame(raf)
        raf = 0
        box?.remove()
        box = null
        document.body.style.userSelect = ""
        touchActive = false
        observer?.disconnect()
        ;(scroller ?? window).removeEventListener("scroll", schedule)
        window.removeEventListener("keydown", onKey, true)
      }

      function detach() {
        window.clearTimeout(holdTimer)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        el.removeEventListener("selectstart", noSelect)
        if (el.hasPointerCapture(event.pointerId))
          el.releasePointerCapture(event.pointerId)
        abort = null
      }

      // Every copy flies back to the art it was lifted from.
      function flyBack(l = lift) {
        lift = null
        l?.cancel(
          shown.map((key) => artRect(cardOf(key))),
          () => latest.current.onLift(null),
        )
      }

      // End the gesture without committing: everything flies or snaps back.
      function stop(keepListeners = false) {
        const wasActive = state === "active"
        state = "done"
        cleanVisuals()
        if (wasActive) {
          emitSelect(before)
          emitOver(null)
          flyBack()
        }
        if (!keepListeners) detach()
      }

      function commit() {
        const input = frameInput(true)
        const out = decide(input, memory)
        const d = out.destination
        state = "done"
        cleanVisuals()
        detach()
        const l = lift
        lift = null
        if (d.kind === "move" && l) {
          emitSelect(before)
          const targetEl = list.querySelector<HTMLElement>(
            `[data-drop-to="${CSS.escape(d.target)}"]`,
          )
          const rect = targetEl?.getBoundingClientRect()
          const finish = () => {
            emitOver(null)
            latest.current.onLift(null)
            latest.current.onDrop(d.keys, d.to)
          }
          if (rect) {
            window.setTimeout(() => targetEl && bounce(targetEl, reduced), 150)
            l.drop(rect, finish)
          } else {
            l.remove()
            finish()
          }
          return
        }
        if (d.kind === "select") emitSelect(d.keys)
        else emitSelect(before)
        emitOver(null)
        if (l) flyBack(l)
      }

      function onMove(e: PointerEvent) {
        if (e.pointerId !== event.pointerId || state === "done") return
        pointer = { x: e.clientX, y: e.clientY }
        const now = performance.now()
        samples.push({ ...pointer, t: now })
        while (samples.length > 2 && now - samples[0]!.t > 200) samples.shift()
        if (state === "pressed") {
          if (touch && origin) {
            // A finger that moves before the hold is up is scrolling.
            if (
              Math.hypot(pointer.x - down.x, pointer.y - down.y) > TUNING.TOUCH_SLOP
            ) {
              state = "done"
              detach()
            }
            return
          }
          if (!crossedHysteresis(down, pointer)) return
          if (!begin()) return
        }
        schedule()
      }
      function onUp(e: PointerEvent) {
        if (e.pointerId !== event.pointerId) return
        if (state === "active") return commit()
        const wasClick = state === "pressed"
        detach()
        state = "done"
        if (wasClick && plan.kind === "box" && !additive && before.size > 0 && !touch) {
          // A click on empty space, no drag: clear, as a desktop does.
          if (event.target && !(event.target as Element).closest(CARD)) {
            latest.current.onSelect(new Set())
          }
        }
      }
      function onCancel(e: PointerEvent) {
        if (e.pointerId !== event.pointerId) return
        if (state === "active") stop()
        else detach()
      }
      function onKey(e: KeyboardEvent) {
        if (e.key !== "Escape" || state !== "active") return
        // Esc ends the gesture and nothing else: not a bar behind it clearing.
        e.stopPropagation()
        // The button is still down: listeners stay until it goes up, so the
        // rest of the drag is ignored and not turned into something else.
        stop(true)
      }
      const noSelect = (e: Event) => e.preventDefault()

      // A resize while the gesture is out makes the measured rects stale.
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
              stale = true
              schedule()
            })

      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      el.addEventListener("selectstart", noSelect)
      abort = () => {
        if (state === "active") stop()
        else detach()
        window.clearTimeout(swallowTimer)
      }

      // A finger lifts a card only after resting on it.
      if (touch && origin) {
        holdTimer = window.setTimeout(() => {
          if (state !== "pressed") return
          touchActive = true
          begin()
          schedule()
        }, TUNING.TOUCH_HOLD_MS)
      }
    }

    el.addEventListener("pointerdown", onDown)
    return () => {
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("dragstart", noNativeDrag)
      el.removeEventListener("contextmenu", noMenu)
      el.removeEventListener("touchmove", noScroll)
      abort?.()
    }
  }, [root])
}

/** What the pointer went down on, for `planPress`. */
function classify(target: Element, selected: Set<string>): PressTarget {
  const card = target.closest<HTMLElement>(CARD)
  const box = target.closest("[role=checkbox]")
  if (card && box && card.contains(box)) {
    const key = card.dataset.selectKey!
    return { kind: "checkbox", key, ticked: selected.has(key) }
  }
  if (target.closest(CONTROL)) return { kind: "control" }
  if (card) {
    const key = card.dataset.selectKey!
    return { kind: "card", key, selected: selected.has(key) }
  }
  return { kind: "empty" }
}

/** The folder takes the drop with a small bounce. */
function bounce(node: HTMLElement, reduced: boolean) {
  if (reduced) return
  node.animate(
    [
      { transform: "scale(1.06)" },
      { transform: "scale(0.99)", offset: 0.6 },
      { transform: "scale(1)" },
    ],
    { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  )
}

/**
 * The pane the page scrolls in. It counts even while nothing overflows: the
 * box must still clip to it (not paint over the rail) on a short list.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === "auto" || overflowY === "scroll") return p
  }
  return null
}
