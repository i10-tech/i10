"use client"

import * as React from "react"

/** Pixels of movement before a press on empty space becomes a selection box. */
const THRESHOLD = 4
/** Within this distance of the scroller's top or bottom edge the page scrolls. */
const EDGE = 48
const MAX_SCROLL_PER_FRAME = 40

/**
 * A press that lands on any of these is not the start of a box: items are
 * dragged (natively) or opened, and controls do their own job.
 */
const NOT_EMPTY =
  "[data-select-key], a, button, input, textarea, select, label, summary, [role=menu], [role=dialog], [role=toolbar], [role=checkbox], [contenteditable=true], [data-list-toolbar], [data-no-marquee]"

type Item = { key: string; left: number; top: number; right: number; bottom: number }

/**
 * Drag-to-select, the way Finder and Explorer do it: press on empty space,
 * drag, and everything the box touches is selected - live, as it grows.
 *
 * ⚠ THE PRESS DECIDES WHAT THE DRAG IS. On empty space anywhere under `root`
 * (the gaps, the padding, below the last row) it becomes a box after
 * THRESHOLD px. On an item, a control or a link it is never a box: the item is
 * dragged by the browser's own drag and drop, and a press that does not move
 * is a click. There is no moment where one gesture could be either.
 *
 * ⚠ NOTHING HERE RENDERS. Moves are batched into one animation frame, the box
 * is one element moved with `transform` (appended to <body>, since a `fixed`
 * box inside the page's transformed wrapper is placed relative to that
 * wrapper), the items' rects are measured once when the drag starts, and
 * `onChange` is called only when the set of selected keys actually changes.
 * Positions are kept in the scroller's CONTENT coordinates, so scrolling,
 * by wheel or by the edge auto-scroll, does not invalidate them.
 *
 * ⇧ or ⌘ adds to what was selected; otherwise the box replaces it. A plain
 * click on empty space, no drag, clears the selection. Esc puts back what was
 * selected before the drag.
 *
 * Items are any elements under `root` carrying `data-select-key`.
 */
export function useMarquee({
  root,
  selected,
  onChange,
}: {
  root: React.RefObject<HTMLElement | null>
  selected: Set<string>
  onChange: (next: Set<string>) => void
}): void {
  const latest = React.useRef({ selected, onChange })
  React.useEffect(() => {
    latest.current = { selected, onChange }
  })

  React.useEffect(() => {
    const found = root.current
    if (!found) return
    const el: HTMLElement = found
    let abort: (() => void) | null = null

    function onDown(event: PointerEvent) {
      if (abort) return
      if (event.button !== 0 || !event.isPrimary || event.pointerType === "touch")
        return
      if ((event.target as Element).closest(NOT_EMPTY)) return

      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      const before = new Set(latest.current.selected)
      const base = additive ? before : new Set<string>()
      const scroller = scrollParent(el)
      const down = { x: event.clientX, y: event.clientY }
      let pointer = down
      let dragging = false
      let raf = 0
      let stale = true
      let items: Item[] = []
      let view = { left: 0, top: 0, right: 0, bottom: 0 }
      let start = { x: 0, y: 0 }
      let last = before
      let box: HTMLDivElement | null = null

      const offset = () =>
        scroller
          ? { x: scroller.scrollLeft, y: scroller.scrollTop }
          : { x: window.scrollX, y: window.scrollY }

      function measure() {
        const r = scroller?.getBoundingClientRect()
        view = r
          ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        const off = offset()
        items = Array.from(el.querySelectorAll<HTMLElement>("[data-select-key]")).map(
          (item) => {
            const b = item.getBoundingClientRect()
            return {
              key: item.dataset.selectKey!,
              left: b.left - view.left + off.x,
              top: b.top - view.top + off.y,
              right: b.right - view.left + off.x,
              bottom: b.bottom - view.top + off.y,
            }
          },
        )
        stale = false
      }

      function emit(next: Set<string>) {
        if (next.size === last.size && [...next].every((k) => last.has(k))) return
        last = next
        latest.current.onChange(next)
      }

      function schedule() {
        if (dragging && !raf) raf = requestAnimationFrame(frame)
      }

      function frame() {
        raf = 0
        if (stale) measure()
        // Near the top or bottom edge the page scrolls so the box can grow.
        let scrolled = false
        const depth =
          pointer.y < view.top + EDGE
            ? pointer.y - (view.top + EDGE)
            : pointer.y > view.bottom - EDGE
              ? pointer.y - (view.bottom - EDGE)
              : 0
        if (depth !== 0) {
          const step =
            Math.sign(depth) *
            Math.min(MAX_SCROLL_PER_FRAME, Math.ceil(Math.abs(depth) / 4))
          const was = offset().y
          if (scroller) scroller.scrollTop += step
          else window.scrollBy(0, step)
          scrolled = offset().y !== was
        }

        const off = offset()
        const px = pointer.x - view.left + off.x
        const py = pointer.y - view.top + off.y
        const x0 = Math.min(start.x, px)
        const x1 = Math.max(start.x, px)
        const y0 = Math.min(start.y, py)
        const y1 = Math.max(start.y, py)

        if (box) {
          // Clipped to what the scroller shows, so it never paints over the chrome.
          const l = Math.max(x0 - off.x + view.left, view.left)
          const t = Math.max(y0 - off.y + view.top, view.top)
          const r = Math.min(x1 - off.x + view.left, view.right)
          const b = Math.min(y1 - off.y + view.top, view.bottom)
          box.style.transform = `translate3d(${l}px,${t}px,0)`
          box.style.width = `${Math.max(0, r - l)}px`
          box.style.height = `${Math.max(0, b - t)}px`
        }

        const hit = new Set(base)
        for (const item of items) {
          if (item.right > x0 && item.left < x1 && item.bottom > y0 && item.top < y1)
            hit.add(item.key)
        }
        emit(hit)

        if (scrolled) schedule()
      }

      function begin() {
        dragging = true
        measure()
        const off = offset()
        start = { x: down.x - view.left + off.x, y: down.y - view.top + off.y }
        box = document.createElement("div")
        box.setAttribute("aria-hidden", "true")
        box.className =
          "pointer-events-none fixed top-0 left-0 z-50 rounded-[3px] border border-primary/60 bg-primary/10"
        box.style.willChange = "transform"
        document.body.appendChild(box)
        document.body.style.userSelect = "none"
        window.getSelection()?.removeAllRanges()
        try {
          el.setPointerCapture(event.pointerId)
        } catch {
          // The pointer is already gone; the up handler ends the gesture.
        }
      }

      function onMove(e: PointerEvent) {
        if (e.pointerId !== event.pointerId) return
        pointer = { x: e.clientX, y: e.clientY }
        if (!dragging) {
          if (Math.hypot(pointer.x - down.x, pointer.y - down.y) < THRESHOLD) return
          begin()
        }
        schedule()
      }

      function finish(cancelled: boolean) {
        abort = null
        el.removeEventListener("pointermove", onMove)
        el.removeEventListener("pointerup", onUp)
        el.removeEventListener("pointercancel", onCancel)
        el.removeEventListener("selectstart", noSelect)
        window.removeEventListener("keydown", onKey, true)
        ;(scroller ?? window).removeEventListener("scroll", schedule)
        observer?.disconnect()
        cancelAnimationFrame(raf)
        box?.remove()
        document.body.style.userSelect = ""
        if (el.hasPointerCapture(event.pointerId))
          el.releasePointerCapture(event.pointerId)
        if (cancelled) {
          if (dragging) emit(before)
        } else if (!dragging && !additive && before.size > 0) {
          // A click on empty space, no drag: clear, as a desktop does.
          latest.current.onChange(new Set())
        }
        dragging = false
      }
      function onUp(e: PointerEvent) {
        if (e.pointerId === event.pointerId) finish(false)
      }
      function onCancel(e: PointerEvent) {
        if (e.pointerId === event.pointerId) finish(true)
      }
      function onKey(e: KeyboardEvent) {
        if (e.key !== "Escape" || !dragging) return
        // Esc ends the box and nothing else: not a bar behind it clearing.
        e.stopPropagation()
        finish(true)
      }
      const noSelect = (e: Event) => e.preventDefault()

      // A resize while the box is out makes the measured rects stale.
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
              stale = true
              schedule()
            })
      observer?.observe(el)

      el.addEventListener("pointermove", onMove)
      el.addEventListener("pointerup", onUp)
      el.addEventListener("pointercancel", onCancel)
      el.addEventListener("selectstart", noSelect)
      window.addEventListener("keydown", onKey, true)
      ;(scroller ?? window).addEventListener("scroll", schedule, { passive: true })
      abort = () => finish(true)
    }

    el.addEventListener("pointerdown", onDown)
    return () => {
      el.removeEventListener("pointerdown", onDown)
      abort?.()
    }
  }, [root])
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      p.scrollHeight > p.clientHeight
    )
      return p
  }
  return null
}
