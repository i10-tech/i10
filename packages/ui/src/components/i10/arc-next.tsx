"use client"

import Link from "next/link"
import { useEffect, type ReactNode } from "react"
import { ArcProvider } from "../lib/arc-provider"

/**
 * Arc renders plain `<a>` and `<img>` unless told otherwise. This hands it
 * Next's Link once, at the root, so every Arc link (breadcrumbs, ButtonLink,
 * pagination) is a client-side navigation. Images stay plain `<img>`: avatars
 * come from Clerk and other hosts that next/image would have to allow-list.
 *
 * A client component of its own because a server layout cannot pass
 * functions (the Link component) as props across the boundary.
 */
export function ArcNext({ children }: { children: ReactNode }) {
  useInputModality()
  return <ArcProvider link={Link}>{children}</ArcProvider>
}

/**
 * Arc's rule is that pointer focus never draws a ring, and it relies on the
 * browser's `:focus-visible` to tell the two apart. Chrome's guess goes wrong
 * after any key press: click a tab after typing in a field and the tab shows
 * the keyboard ring (reported on the domain page's Records / Configuration
 * tabs, "sometimes"). So the last input is tracked here, and while it is a
 * pointer the ring is turned off through Arc's own `--focus-outline` knob
 * (see arc.css). The next real navigation key brings it back.
 */
function useInputModality() {
  useEffect(() => {
    const root = document.documentElement
    const pointer = () => {
      root.dataset.input = "pointer"
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      delete root.dataset.input
    }
    window.addEventListener("pointerdown", pointer, true)
    window.addEventListener("keydown", keyboard, true)
    return () => {
      window.removeEventListener("pointerdown", pointer, true)
      window.removeEventListener("keydown", keyboard, true)
    }
  }, [])
}
