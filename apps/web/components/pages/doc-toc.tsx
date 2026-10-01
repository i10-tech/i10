"use client"

import { motion } from "motion/react"
import { useEffect, useState } from "react"
import { cn } from "cn"

/*
 * A table of contents that follows the reader: the section whose heading last
 * crossed the upper third of the viewport is current, and one marker slides
 * between entries (Stripe's docs, Mintlify's sidebar) instead of each entry
 * lighting up on its own.
 */
export function DocToc({ items }: { items: { id: string; title: string }[] }) {
  const [active, setActive] = useState(items[0]?.id)

  useEffect(() => {
    const els = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null)
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: "-20% 0px -65% 0px" },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [items])

  return (
    <nav aria-label="On this page" className="flex flex-col">
      <span className="type-label mb-4 text-fg-4">On this page</span>
      <ul className="relative flex flex-col border-l border-line">
        {items.map((item) => (
          <li key={item.id} className="relative">
            {active === item.id ? (
              <motion.span
                layoutId="toc-marker"
                aria-hidden
                className="absolute inset-y-1 -left-px w-px bg-fg"
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              />
            ) : null}
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? "location" : undefined}
              className={cn(
                "block py-1.5 pl-4 text-[13px] leading-5 transition-colors duration-200",
                active === item.id ? "text-fg" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {item.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
