"use client"

import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react"
import { cn } from "cn"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"

/*
 * Headline reveals, two flavours:
 *
 *  - "lines": words rise out of their own masks, one line after another (the
 *    Linear/Vercel move). Lines are found at run time by grouping words on
 *    their measured top edge, so they are the lines the reader actually sees.
 *  - "scatter": each word fades up with a random delay, the way anthropic.com
 *    builds its hero - the sentence assembles rather than types.
 *
 * ⚠ THE SPLIT IS DONE IN REACT, NOT WITH GSAP's SplitText. SplitText rebuilds
 * the element's DOM - on split, on every re-split after a font loads, and on
 * revert (which restores innerHTML, i.e. brand-new nodes) - and React keeps
 * references to the nodes it rendered. The first time React then updated or
 * removed one of them it threw "removeChild: the node to be removed is not a
 * child of this node". Here React owns every node and GSAP only sets styles.
 */
export function SplitReveal({
  as = "div",
  mode = "lines",
  onScroll = true,
  delay = 0,
  className,
  children,
}: {
  as?: "div" | "h1" | "h2" | "h3" | "p" | "span"
  mode?: "lines" | "scatter"
  onScroll?: boolean
  delay?: number
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // One element type for the ref's sake; the tag itself still varies.
  const Tag = as as "div"

  useGSAP(
    () => {
      const el = ref.current
      if (!el) return
      const words = Array.from(el.querySelectorAll<HTMLElement>(".sw-i"))
      gsap.set(el, { autoAlpha: 1 })
      // Back to plain inline text once played, so selection paints as one
      // run per line (see [data-split-done] in globals.css).
      const done = () => {
        gsap.set(words, { clearProps: "transform,opacity,filter" })
        el.dataset.splitDone = ""
      }
      if (prefersReducedMotion() || !words.length) {
        done()
        return
      }

      const scrollTrigger = onScroll
        ? { trigger: el, start: "top 86%", once: true }
        : undefined
      const tl = gsap.timeline({ scrollTrigger, onComplete: done })

      if (mode === "scatter") {
        words.forEach((word) => {
          tl.fromTo(
            word,
            { opacity: 0, y: "0.35em", filter: "blur(8px)" },
            { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.95, ease: "site.out" },
            delay + Math.random() * 0.4,
          )
        })
        return
      }

      // Group words into visual lines by their top edge.
      const tops = new Map<number, number>()
      const lineOf = words.map((w) => {
        const top = Math.round(w.parentElement!.offsetTop)
        if (!tops.has(top)) tops.set(top, tops.size)
        return tops.get(top)!
      })
      words.forEach((word, i) => {
        tl.fromTo(
          word,
          { yPercent: 115, rotate: 3 },
          { yPercent: 0, rotate: 0, duration: 1.15, ease: "site.out" },
          delay + (lineOf[i] ?? 0) * 0.09,
        )
      })
    },
    { scope: ref, dependencies: [mode, onScroll, delay] },
  )

  return (
    <Tag ref={ref} data-split={mode} className={cn(className)}>
      {splitWords(children)}
    </Tag>
  )
}

/*
 * Walk the children: text becomes one masked span per word (spaces kept as
 * real text between them, so the line breaks exactly where it would have);
 * elements keep their own tag and props and have their children walked.
 */
export function splitWords(node: ReactNode, path = "w"): ReactNode {
  return Children.map(node, (child, index) => {
    const key = `${path}-${index}`
    if (typeof child === "string" || typeof child === "number") {
      const parts = String(child).split(/(\s+)/)
      return parts.map((part, i) =>
        /^\s+$/.test(part) || part === "" ? (
          part
        ) : (
          <span key={`${key}-${i}`} className="sw">
            <span className="sw-i">{part}</span>
          </span>
        ),
      )
    }
    if (isValidElement(child)) {
      const element = child as ReactElement<{ children?: ReactNode }>
      if (element.type === "br") return element
      return cloneElement(element, { key }, splitWords(element.props.children, key))
    }
    return child
  })
}
