"use client"

import * as React from "react"
import { cn } from "cn"
import { RAIL_COOKIE } from "@/lib/rail-cookie"

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
const Collapsed = React.createContext<{ collapsed: boolean; toggle: () => void }>({
  collapsed: false,
  toggle: () => {},
})

/**
 * Whether the desktop rail is the icon-only rail (#153).
 *
 * ⚠ `false` OUTSIDE A RAIL, WHICH IS THE MOBILE SHEET. The sheet renders the
 * same `SidebarNav`, and a phone has no use for a collapsed rail - it already
 * hides the whole thing behind a button.
 */
export function useRail() {
  return React.useContext(Collapsed)
}

/**
 * ⚠ A COOKIE, NOT `localStorage`, SO THE SERVER RENDERS THE RIGHT WIDTH. The
 * layout reads it and passes `defaultCollapsed`; storage only the browser can
 * read would paint a 240px rail on every load and then snap it shut, which is
 * the exact flash a remembered preference is meant to remove.
 */
function remember(collapsed: boolean) {
  document.cookie = `${RAIL_COOKIE}=${collapsed ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`
}

export function Rail({
  className,
  children,
  defaultCollapsed = false,
}: React.ComponentProps<"aside"> & { defaultCollapsed?: boolean }) {
  const ref = React.useRef<HTMLElement>(null)
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed)

  const toggle = React.useCallback(() => {
    setCollapsed((was) => {
      remember(!was)
      return !was
    })
  }, [])

  /*
   * ⚠ ⌘B / CTRL+B, THE SHORTCUT EDITORS AND shadcn's SIDEBAR USE, AND NEVER
   * WHILE TYPING. In a text field Ctrl+B is bold, or nothing, and stealing it
   * there would make the rail jump while somebody writes a template subject.
   */
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey)) return
      if (event.shiftKey || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select"))
      )
        return
      event.preventDefault()
      toggle()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [toggle])

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

  const value = React.useMemo(() => ({ collapsed, toggle }), [collapsed, toggle])

  return (
    <Collapsed.Provider value={value}>
      <aside
        ref={ref}
        data-collapsed={collapsed}
        className={cn(
          // ⚠ `group/rail`, SO ANYTHING INSIDE CAN HIDE ITSELF WITH A CLASS
          // (`group-data-[collapsed=true]/rail:hidden`) rather than every
          // component growing a `collapsed` prop it passes down.
          "group/rail overflow-hidden",
          "transition-[width] duration-(--duration-move) ease-(--ease-quint-out)",
          collapsed ? "w-14" : "w-60",
          className,
        )}
      >
        {children}
      </aside>
    </Collapsed.Provider>
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
