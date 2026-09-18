"use client"

import type * as React from "react"
import { MotionConfig } from "motion/react"

/**
 * Motion's global settings, in one place.
 *
 * ⚠ `reducedMotion="user"` IS THE ENTIRE REASON THIS COMPONENT EXISTS, AND IT
 * IS NOT MOTION'S DEFAULT. Out of the box the library animates regardless of
 * `prefers-reduced-motion`; with this set it drops transforms and keeps opacity
 * for anybody whose system asks it to. The stylesheet already honours the same
 * preference for CSS transitions — see the `prefers-reduced-motion` block in
 * styles/tokens.css — and having one half of the interface respect it while the
 * other half does not is worse than neither, because the half that still moves
 * is the half nobody tested.
 *
 * ⚠ IT IS A CLIENT COMPONENT WRAPPING SERVER-RENDERED CHILDREN, WHICH COSTS
 * NOTHING. `children` arrives as an already-rendered prop, so putting this at
 * the root of a layout does not pull the page into the client bundle — only
 * this file and Motion's context are client-side.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
