"use client"

import * as React from "react"
import { createPortal } from "react-dom"

type Box = { left: number; top: number; width: number; height: number }

/**
 * Drag-to-select, the way Finder and Explorer do it: press on empty space,
 * drag, and everything the box touches is selected - live, as it grows.
 *
 * ⚠ ONLY FROM EMPTY SPACE. A press on an item, a button, a link or a field is
 * left alone, so clicking, ticking and dragging items behave exactly as
 * before; the box starts in the gaps between and around them.
 *
 * ⚠ ⇧ OR ⌘ ADDS TO WHAT WAS SELECTED; otherwise the box replaces it. A plain
 * click on empty space, with no drag, clears the selection.
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
}): Box | null {
  const [box, setBox] = React.useState<Box | null>(null)
  const latest = React.useRef({ selected, onChange })
  React.useEffect(() => {
    latest.current = { selected, onChange }
  })

  React.useEffect(() => {
    const found = root.current
    if (!found) return
    const el: HTMLElement = found
    function onDown(event: PointerEvent) {
      if (event.button !== 0 || event.pointerType === "touch") return
      const target = event.target as HTMLElement
      if (
        target.closest(
          "[data-select-key], a, button, input, textarea, select, label, [role=menu], [role=dialog], [contenteditable=true]",
        )
      )
        return
      const additive = event.shiftKey || event.metaKey || event.ctrlKey
      const base = additive ? new Set(latest.current.selected) : new Set<string>()
      const scroller = scrollParent(el)
      // Page coordinates, so the box stays put while the page scrolls.
      const start = { x: event.clientX, y: event.clientY + (scroller?.scrollTop ?? 0) }
      let pointer = { x: event.clientX, y: event.clientY }
      let dragging = false
      let raf = 0

      const update = () => {
        const scrollTop = scroller?.scrollTop ?? 0
        const y0 = start.y - scrollTop
        const left = Math.min(start.x, pointer.x)
        const top = Math.min(y0, pointer.y)
        const rect = {
          left,
          top,
          width: Math.abs(pointer.x - start.x),
          height: Math.abs(pointer.y - y0),
        }
        setBox(rect)
        const hit = new Set(base)
        for (const item of Array.from(
          el.querySelectorAll<HTMLElement>("[data-select-key]"),
        )) {
          const r = item.getBoundingClientRect()
          const touches =
            r.right > rect.left &&
            r.left < rect.left + rect.width &&
            r.bottom > rect.top &&
            r.top < rect.top + rect.height
          const key = item.dataset.selectKey!
          if (touches) hit.add(key)
        }
        latest.current.onChange(hit)
      }
      // Near the top or bottom edge, the page scrolls so the box can grow.
      const autoscroll = () => {
        if (scroller) {
          const r = scroller.getBoundingClientRect()
          const edge = 48
          const dy =
            pointer.y < r.top + edge
              ? -Math.ceil((r.top + edge - pointer.y) / 4)
              : pointer.y > r.bottom - edge
                ? Math.ceil((pointer.y - (r.bottom - edge)) / 4)
                : 0
          if (dy !== 0) {
            scroller.scrollTop += dy
            update()
          }
        }
        raf = requestAnimationFrame(autoscroll)
      }

      function onMove(e: PointerEvent) {
        pointer = { x: e.clientX, y: e.clientY }
        if (!dragging) {
          if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) < 4)
            return
          dragging = true
          document.body.style.userSelect = "none"
          raf = requestAnimationFrame(autoscroll)
        }
        update()
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        cancelAnimationFrame(raf)
        document.body.style.userSelect = ""
        setBox(null)
        // A click on empty space, no drag: clear, as a desktop does.
        if (!dragging && !additive) latest.current.onChange(new Set())
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    }
    el.addEventListener("pointerdown", onDown)
    return () => el.removeEventListener("pointerdown", onDown)
  }, [root])

  return box
}

/**
 * The box itself, drawn over the page while dragging.
 *
 * ⚠ IN <body>: a `fixed` box inside the page's transformed wrapper would be
 * placed relative to that wrapper, away from the pointer.
 */
export function MarqueeBox({ box }: { box: Box | null }) {
  if (!box || (box.width < 2 && box.height < 2)) return null
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 rounded-[3px] border border-primary/60 bg-primary/10"
      style={box}
    />,
    document.body,
  )
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
