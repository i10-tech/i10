"use client"

import styles from "./shimmer.module.css"

export const shimmerClass = styles.shimmer!

const queued = new Set<HTMLElement>()

/*
 * ⚠ EVERY SHIMMER RUNS ON THE PAGE'S CLOCK AND THE VIEWPORT'S RULER
 * (2026-11-18). A CSS animation starts when its element mounts, and a
 * skeleton's bars are remounted on the way to the page (the click-time
 * skeleton, then loading.tsx) and again as the ghosts of the resolve: each
 * restart threw the band back to the left edge. Started at the timeline's
 * origin, every element is at the same point of the sweep however late it
 * mounted. Its band is laid from the viewport's left edge, so the slices line
 * up into one band across the page.
 *
 * ⚠ READ ALL, THEN WRITE ALL. Setting `--shimmer-x` invalidates layout, so
 * measuring each element as its ref attaches would lay the page out once per
 * bar. The refs of one commit are collected and settled together, in a
 * microtask, still before the browser paints.
 */
function settle() {
  const elements = [...queued].filter((el) => el.isConnected)
  queued.clear()
  const lefts = elements.map((el) => el.getBoundingClientRect().left)
  elements.forEach((el, i) => place(el, lefts[i]!))
}

/** Lay the band of an element whose viewport `left` is already known. */
export function place(el: HTMLElement, left: number) {
  el.style.setProperty("--shimmer-x", `${left}px`)
  for (const animation of el.getAnimations({ subtree: true })) animation.startTime = 0
}

/** A ref for any element with `shimmerClass`. */
export function shimmerRef(el: HTMLElement | null) {
  if (!el) return
  if (queued.size === 0) queueMicrotask(settle)
  queued.add(el)
}

/** A plain shimmering block, for a placeholder that is not a Bone. */
export function Shimmer({ className }: { className?: string }) {
  return <div ref={shimmerRef} aria-hidden="true" className={className ? `${shimmerClass} ${className}` : shimmerClass} />
}
