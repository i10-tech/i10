"use client"

import type * as React from "react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { cn } from "cn"

/**
 * The page arriving, instead of the page being replaced.
 *
 * ⚠ THERE IS NO EXIT ANIMATION, AND LEAVING IT OUT IS THE WHOLE DESIGN. The
 * obvious spelling is `<AnimatePresence mode="wait">`, which fades the old page
 * out and only then brings the new one in — and it makes every navigation in the
 * product slower by exactly the length of the exit, on purpose, forever. The
 * brief for this is motion somebody feels rather than notices; an interface that
 * charges 150ms for each click has crossed from "feels considered" to "feels
 * sluggish", and that is the single most common way a motion pass makes a
 * product worse.
 *
 * So the outgoing page is simply gone — which is what the browser was doing
 * anyway — and the incoming one rises six pixels and fades up. The hard cut is
 * removed from the half of the transition the eye is actually looking at.
 *
 * ⚠ IT IS KEYED ON THE PATHNAME, WHICH REMOUNTS THE PAGE ON EVERY NAVIGATION.
 * That is what re-runs `initial`; without it React reconciles the new page into
 * the old wrapper and nothing animates at all. The cost is that page-level
 * client state does not survive a route change, which is correct here — these
 * are different screens, not tabs.
 *
 * ⚠ AND THE FIRST PAINT DOES NOT ANIMATE, WHICH IS WHAT `AnimatePresence
 * initial={false}` IS FOR. A page that fades itself in on a cold load is a load
 * animation nobody asked for, and under SSR it is worse than pointless: the
 * server would send markup at `opacity: 0` and the content would be invisible
 * until JavaScript arrived to reveal it.
 *
 * ⚠ THIS WAS FIRST WRITTEN AS A `useRef` READ AND WRITTEN DURING RENDER, AND
 * THE REACT COMPILER WAS RIGHT TO REFUSE IT. A render can be thrown away and
 * re-run — that is the whole point of concurrent rendering — and the second
 * attempt would find the ref already set to `false`, so the FIRST real paint
 * would animate after all. It is a bug that only appears under load, which is
 * the worst kind to go looking for. `AnimatePresence` already tracks exactly
 * this, correctly, so the hand-rolled version was both wrong and unnecessary.
 *
 * ⚠ THE CHILD DECLARES NO `exit`, SO THERE IS NOTHING TO WAIT FOR. With no exit
 * animation `AnimatePresence` removes the outgoing page in the same commit,
 * which is the behaviour described above — it is being used here as a
 * first-render guard, not as a way to animate things out.
 */

/**
 * ⚠ A SPRING FOR THE TRAVEL AND A HARD CAP ON THE FADE. The six pixels get
 * `--ease-spring-soft`'s solver so the page settles rather than stopping dead;
 * the opacity gets a plain 140ms tween, because an overshoot on opacity means
 * going past fully-opaque and coming back, which is invisible work. Same rule
 * as the spring tokens in styles/tokens.css.
 */
const ENTER: Transition = {
  y: { type: "spring", stiffness: 420, damping: 40, mass: 1 },
  opacity: { duration: 0.14, ease: "easeOut" },
}

export function PageTransition({
  pathname,
  children,
  className,
}: {
  /**
   * What counts as "a different page".
   *
   * ⚠ PASSED IN RATHER THAN READ FROM `usePathname` HERE, so a caller can
   * decide what a navigation means. A list page that puts its filters in the
   * query string does NOT want the whole screen to re-enter every time somebody
   * changes a filter — that is the same page with different rows, and animating
   * it would turn a refinement into a page load.
   */
  pathname: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={pathname}
        className={cn("flex min-h-0 flex-1 flex-col", className)}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={ENTER}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
