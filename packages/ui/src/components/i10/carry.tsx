"use client"

import { animate } from "motion/react"
import { motionTokens } from "../lib/motion-tokens"

/**
 * Carries a value from where it was typed to where it is shown next: the
 * domain in the box travelling into the answered step's card, the email on a
 * sign-in's first step into the "· Change" chip on the second - and back.
 *
 * ⚠ THE SAME TEXT, MOVED - NOT ONE COPY FADING OUT WHILE ANOTHER FADES IN.
 * Mark the field and the text that shows it with the same `data-carry` key.
 * When one view gives way to the other, a copy of the text is lifted out of
 * the page at the old place and flown to the new one on Arc's panel spring,
 * while both originals hide; it lands on the real one and disappears into it.
 * Mark the field itself or any wrapper around it - the input inside is found.
 *
 * ⚠ THE COPY CHASES THE TARGET'S LIVE POSITION EVERY FRAME. The page moves
 * while this happens - a box changes height, a list slides by layout
 * animation, a column scrolls - so aiming at where the target was at the
 * start lands it a few pixels off. The end is read again on every frame, and
 * the start moves with `scope`, the thing both ends belong to.
 *
 * ⚠ THE COPY LIVES ON `document.body`, so the views' own fades and clips
 * never touch it: it is fully visible the whole way, as the value always is.
 *
 * Call it in a layout effect, after the new view has rendered and before the
 * browser paints, while the old one is still on screen where it was. Returns
 * a function that stops every flight and puts both ends back.
 */
export function carryBetween(
  scope: HTMLElement,
  from: ParentNode,
  to: ParentNode,
): () => void {
  const targets = carries(to)
  const stops = carries(from).flatMap((source) => {
    const target = targets.find((t) => t.dataset.carry === source.dataset.carry)
    return target ? [fly(scope, source, target)] : []
  })
  return () => stops.forEach((stop) => stop())
}

function carries(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>("[data-carry]")].map((el) =>
    el.matches("input, textarea")
      ? el
      : (el.querySelector<HTMLElement>("input, textarea") ?? el),
  )
}

const isField = (el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

/** Where a value's text starts and how big it is: left edge, vertical middle. */
function anchor(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  const size = parseFloat(cs.fontSize)
  if (isField(el)) {
    const top = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
    const bottom =
      r.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom)
    return {
      x:
        r.left +
        parseFloat(cs.borderLeftWidth) +
        parseFloat(cs.paddingLeft) -
        el.scrollLeft,
      y: (top + bottom) / 2,
      size,
    }
  }
  return { x: r.left, y: r.top + r.height / 2, size }
}

function hide(el: HTMLElement) {
  if (isField(el)) {
    const { color, caretColor } = el.style
    const fill = el.style.getPropertyValue("-webkit-text-fill-color")
    el.style.color = "transparent"
    el.style.caretColor = "transparent"
    el.style.setProperty("-webkit-text-fill-color", "transparent")
    return () => {
      el.style.color = color
      el.style.caretColor = caretColor
      el.style.setProperty("-webkit-text-fill-color", fill)
    }
  }
  const { visibility } = el.style
  el.style.visibility = "hidden"
  return () => {
    el.style.visibility = visibility
  }
}

function fly(scope: HTMLElement, source: HTMLElement, target: HTMLElement): () => void {
  // The copy is drawn like the answer's text, whichever way it travels.
  const donor = isField(target) ? source : target
  const text = isField(donor) ? donor.value : (donor.textContent ?? "")
  const start = anchor(source)
  if (!text.trim() || start.size === 0 || source.getBoundingClientRect().width === 0)
    return () => {}

  const look = getComputedStyle(donor)
  const copy = document.createElement("span")
  copy.textContent = text
  copy.setAttribute("aria-hidden", "true")
  Object.assign(copy.style, {
    position: "fixed",
    left: "0",
    top: "0",
    margin: "0",
    zIndex: "60",
    pointerEvents: "none",
    whiteSpace: "pre",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: `${Math.max(donor.getBoundingClientRect().width, 1)}px`,
    transformOrigin: "0 0",
    willChange: "transform",
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    fontWeight: look.fontWeight,
    fontFeatureSettings: look.fontFeatureSettings,
    letterSpacing: look.letterSpacing,
    lineHeight: look.lineHeight,
    color: look.color,
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(copy)
  const base = parseFloat(look.fontSize) || start.size
  const height = copy.offsetHeight

  /*
   * ⚠ THE START MOVES WITH THE STEP. Opening one step closes another, and a
   * scrolling column that gets shorter clamps its scroll at once - the step
   * jumps, and a start held in screen coordinates was left behind where the
   * source used to be. Both ends belong to `scope`, so both follow it.
   */
  const origin = scope.getBoundingClientRect()
  const shown = [hide(source), hide(target)]
  const place = (p: number) => {
    const end = anchor(target)
    const now = scope.getBoundingClientRect()
    const sx = start.x + now.left - origin.left
    const sy = start.y + now.top - origin.top
    const scale = (start.size + (end.size - start.size) * p) / base
    const x = sx + (end.x - sx) * p
    const y = sy + (end.y - sy) * p - (height * scale) / 2
    copy.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
  }
  place(0)

  let over = false
  const finish = () => {
    if (over) return
    over = true
    shown.forEach((show) => show())
    copy.remove()
  }
  const flight = animate(0, 1, { ...motionTokens.spring.smooth, onUpdate: place })
  void flight.then(finish)
  return () => {
    flight.stop()
    finish()
  }
}
