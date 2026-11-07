/**
 * The product's one programmatic scroll: a glide that brings an element into
 * view on a critically damped spring and re-reads its target every frame.
 *
 * ⚠ IT RIDES THE GROWTH, WHICH A NATIVE SMOOTH SCROLL CANNOT. What it scrolls to
 * is usually still opening (a Reveal springing to its height). A native smooth
 * scroll aims at where things are when it is asked, so it either waited for the
 * panel to settle (a pause, then a scroll) or stopped at the old bottom and was
 * asked again (two scrolls with a stall between, measured 2026-11-04). This one
 * moves as the page grows and finishes when the page does.
 *
 * - `start` puts the element's top at its `scroll-margin-top` (a setup step
 *   read from its heading down).
 * - `nearest` scrolls only as far as it takes to show the whole element, or
 *   its top if it is taller than the view (a form opening under its row).
 *
 * Any wheel, touch, key or press from the person stops it. Returns a stop
 * function.
 */
export type GlideBlock = "start" | "nearest"

// The person taking the scroll over, including dragging the scrollbar.
const INTERRUPTS = ["wheel", "touchstart", "keydown", "pointerdown"] as const

const STIFFNESS = 170
const DAMPING = 2 * Math.sqrt(STIFFNESS)
/** A panel opening below has not grown yet on the first frames; keep riding it. */
const MIN_MS = 480
const GIVE_UP_MS = 1500

/** The element that scrolls `el`: its nearest scrolling ancestor, or the page. */
function scrollerOf(el: HTMLElement): HTMLElement {
  let pane = el.parentElement
  while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY))
    pane = pane.parentElement
  return (pane ?? document.scrollingElement ?? document.documentElement) as HTMLElement
}

/**
 * Keep the view still while a panel inside `el`'s scroller closes.
 *
 * ⚠ CLOSING MUST NOT MOVE WHAT IS ABOVE THE PANEL (2026-11-04). After a glide
 * opened a panel the page sits scrolled down; folding it made the page shorter
 * than that position, so the browser pulled the scroll back every frame and the
 * row the person was looking at ("Not set up") slid 50px down the screen, late,
 * after the fold had begun out of sight.
 *
 * ⚠ A MIN-HEIGHT ON THE PAGE'S CONTENT BOX, NOT PADDING OR A SPACER. The pane
 * holds one fixed-height flex child that its content overflows: padding on the
 * pane, or a spacer after that child, changed nothing (measured: 500px of
 * either left scrollHeight where it was). Holding the content box at least as
 * tall as what is on screen leaves the browser nothing to clamp, from the
 * first folded frame. Scrolling up lowers it again, so the spare room is only
 * ever below the end of the page; a new page brings a new box without it.
 * Returns a release function.
 */
let heldFloor: (() => void) | null = null

export function holdScrollFloor(el: HTMLElement): () => void {
  const scroller = scrollerOf(el)
  const content = scroller.firstElementChild
  if (scroller === document.scrollingElement || !(content instanceof HTMLElement))
    return () => {}
  // One floor at a time: a second panel closing takes over the first one's.
  heldFloor?.()

  let floor = scroller.scrollTop + scroller.clientHeight
  content.style.minHeight = `${floor}px`
  const release = () => {
    if (heldFloor === release) heldFloor = null
    scroller.removeEventListener("scroll", onScroll)
    content.style.minHeight = ""
  }
  const onScroll = () => {
    const bottom = scroller.scrollTop + scroller.clientHeight
    if (bottom < floor) {
      floor = bottom
      content.style.minHeight = `${floor}px`
    }
    if (scroller.scrollTop <= 0) release()
  }
  scroller.addEventListener("scroll", onScroll, { passive: true })
  heldFloor = release
  return release
}

export function glideIntoView(
  el: HTMLElement,
  block: GlideBlock = "start",
): () => void {
  const scroller = scrollerOf(el)
  const style = getComputedStyle(el)
  const marginTop = parseFloat(style.scrollMarginTop) || 0
  const marginBottom = parseFloat(style.scrollMarginBottom) || 0

  // ⚠ THE POSITION IS OURS, NOT READ BACK: the browser rounds scrollTop, and
  // near the end each frame's step rounds to nothing, which reads as stopped.
  let position = scroller.scrollTop
  let velocity = 0
  let last = performance.now()
  const started = last
  let frame = 0

  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of INTERRUPTS) window.removeEventListener(type, stop)
  }
  for (const type of INTERRUPTS) window.addEventListener(type, stop, { passive: true })

  const targetOf = (actual: number) => {
    const view =
      scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const toTop = actual + box.top - view.top - marginTop
    if (block === "start") return toTop
    const toBottom = actual + box.bottom - view.bottom + marginBottom
    // Already in view: stay. Below: just far enough. Taller than the view: its top.
    if (box.top - marginTop >= view.top && box.bottom + marginBottom <= view.bottom)
      return actual
    return Math.min(toTop, Math.max(toBottom, actual))
  }

  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 1 / 30)
    last = now
    const actual = scroller.scrollTop
    const target = Math.max(0, targetOf(actual))
    const room = scroller.scrollHeight - scroller.clientHeight
    velocity += (STIFFNESS * (target - position) - DAMPING * velocity) * dt
    position += velocity * dt
    // At the bottom of a page that is still growing: hold there and carry only
    // the speed the growth allows, so the glide does not lunge when it stops.
    if (position > room) {
      velocity = dt > 0 ? Math.max(0, Math.min(velocity, (room - actual) / dt)) : 0
      position = room
    }
    scroller.scrollTop = position
    const settled = Math.abs(target - position) < 0.5 && Math.abs(velocity) < 5
    const elapsed = now - started
    if (settled && target <= room && elapsed > MIN_MS) {
      scroller.scrollTop = target
      stop()
      return
    }
    if (elapsed > (target > room ? GIVE_UP_MS : GIVE_UP_MS * 2)) {
      stop()
      return
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return stop
}
