"use client"

import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState } from "react"
import { BrandIcon, brandTitle, type BrandName } from "@/components/brand/brand-icon"
import { prefersReducedMotion } from "@/lib/gsap"

/*
 * Clerk's logo strip, with honest content: i10 has no customer logos to show
 * yet, so the cells cycle through what it works WITH - frameworks, runtimes,
 * languages and the DNS providers onboarding knows how to guide.
 *
 * One cell changes at a time, left to right, with Clerk's swap: the old logo
 * blurs out small, the new one pops in past full size and settles.
 */
const CELLS: BrandName[][] = [
  ["next", "remix", "nuxt", "svelte", "astro"],
  ["node", "bun", "deno", "hono", "express"],
  ["typescript", "python", "go", "ruby", "php"],
  ["laravel", "rails", "django", "supabase", "prisma"],
  ["cloudflare", "godaddy", "namecheap", "porkbun", "hetzner", "ovh", "ionos", "gandi"],
]

export function WorksWith() {
  const [indexes, setIndexes] = useState(() => CELLS.map(() => 0))

  useEffect(() => {
    if (prefersReducedMotion()) return
    let cell = 0
    const id = setInterval(() => {
      const target = cell % CELLS.length
      setIndexes((prev) => prev.map((v, i) => (i === target ? (v + 1) % CELLS[i]!.length : v)))
      cell += 1
    }, 1400)
    return () => clearInterval(id)
  }, [])

  return (
    <section data-nav-tone="dark" className="relative">
      <div className="container-site">
        <div data-reveal className="grid grid-cols-2 border-y border-line md:grid-cols-[1.4fr_repeat(5,1fr)]">
          <div className="col-span-2 flex items-center border-line px-1 py-6 md:col-span-1 md:border-r md:py-0 md:pr-6">
            <p className="max-w-[15rem] text-[14px] leading-[21px] text-fg-2">
              Works with the stack you already run. <span className="text-fg-4">Anything that speaks HTTP.</span>
            </p>
          </div>
          {/* On phones: the sentence spans the first row, cells pair up below it
              (the sentence is child 1, so the left-hand cells are the EVEN
              children), and the fifth cell takes a full row of its own. */}
          {CELLS.map((brands, i) => {
            const name = brands[indexes[i] ?? 0]!
            return (
              <div
                key={i}
                className="group relative flex h-24 items-center justify-center border-line max-md:border-t max-md:even:not-last:border-r max-md:last:col-span-2 md:border-r md:last:border-r-0"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={name}
                    initial={{ opacity: 0, scale: 0.9, filter: "blur(6px)" }}
                    animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                    exit={{ opacity: 0, scale: 0.94, filter: "blur(6px)" }}
                    transition={{ duration: 0.42, ease: [0.175, 0.885, 0.32, 1.1] }}
                    className="flex items-center gap-2.5 text-fg-3 transition-colors duration-300 group-hover:text-fg"
                  >
                    <BrandIcon name={name} size={20} />
                    <span className="text-[14px] font-[520] tracking-[-0.01em]">{brandTitle(name).replace(".js", "")}</span>
                  </motion.span>
                </AnimatePresence>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
