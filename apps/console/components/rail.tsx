"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * The desktop rail's box, and the one thing it does besides hold the rail:
 * a wheel over it never reaches the document.
 *
 * ⚠ WHY A LISTENER AND NOT `overscroll-behavior`. The rail fits, so it is not a
 * scroll container, and a wheel over it falls through to the root - which on
 * macOS rubber-bands even though it cannot scroll: the whole rail lifted and
 * dropped back like a page footer. `overscroll-behavior` only acts on a box
 * that scrolls; set on the root it did stop this, but it also changed how the
 * page pane felt, and the pane must stay exactly as it was. So the rail
 * swallows a wheel it cannot use itself, and nothing else changes.
 *
 * ⚠ IT STILL LETS THE NAV SCROLL WHEN THE NAV CAN. On a very short window the
 * navigation scrolls as a last resort; a wheel the nav can still move in that
 * direction is left alone.
 */
export function Rail({ className, children }: React.ComponentProps<"aside">) {
  const ref = React.useRef<HTMLElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      let node = event.target instanceof Element ? event.target : null
      while (node && node !== el) {
        if (node instanceof HTMLElement && canScroll(node, event.deltaY)) return
        node = node.parentElement
      }
      // ⚠ NON-PASSIVE, OR preventDefault IS IGNORED. Only the rail pays for it.
      event.preventDefault()
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  return (
    <aside ref={ref} className={cn(className)}>
      {children}
    </aside>
  )
}

function canScroll(node: HTMLElement, deltaY: number) {
  if (node.scrollHeight <= node.clientHeight) return false
  const overflow = getComputedStyle(node).overflowY
  if (overflow !== "auto" && overflow !== "scroll") return false
  return deltaY < 0
    ? node.scrollTop > 0
    : node.scrollTop + node.clientHeight < node.scrollHeight - 1
}
