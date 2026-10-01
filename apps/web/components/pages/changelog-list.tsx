"use client"

import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import { useEffect, useMemo, useState } from "react"
import { cn } from "cn"
import { changelog, formatDate, type ChangelogEntry } from "@/lib/changelog"
import { ScrollTrigger } from "@/lib/gsap"

type Tag = ChangelogEntry["tag"]

const TAG_HUE: Record<Tag, string> = {
  Templates: "var(--hue-template)",
  Sending: "var(--hue-send)",
  Storage: "var(--hue-deliver)",
  Console: "var(--hue-mail)",
  Deliverability: "var(--hue-domain)",
  Security: "var(--hue-hook)",
}

/*
 * Linear's changelog: days down the left, sticky while their entries scroll
 * past, and a filter that re-flows the list instead of reloading it. Entries
 * leaving collapse their height, so the ones below slide up rather than jump.
 */
export function ChangelogList() {
  const [filter, setFilter] = useState<Tag | "All">("All")
  const tags = useMemo(
    () => ["All", ...new Set(changelog.map((e) => e.tag))] as (Tag | "All")[],
    [],
  )

  // The page changes height when the list re-flows; every trigger below it
  // (the footer's reveals among them) was measured against the old height.
  useEffect(() => {
    const t = setTimeout(() => ScrollTrigger.refresh(), 450)
    return () => clearTimeout(t)
  }, [filter])

  const days = useMemo(() => {
    const shown = changelog.filter((e) => filter === "All" || e.tag === filter)
    const map = new Map<string, ChangelogEntry[]>()
    for (const e of shown) map.set(e.date, [...(map.get(e.date) ?? []), e])
    return [...map.entries()]
  }, [filter])

  return (
    <div>
      <div
        role="tablist"
        aria-label="Filter by area"
        className="flex flex-wrap gap-1.5"
      >
        {tags.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={filter === t}
            onClick={() => setFilter(t)}
            className={cn(
              "relative h-8 cursor-pointer rounded-full px-3.5 text-[13px] transition-colors duration-200",
              filter === t ? "text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {filter === t ? (
              <motion.span
                layoutId="changelog-filter"
                className="absolute inset-0 rounded-full bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]"
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              />
            ) : null}
            <span className="relative flex items-center gap-2">
              {t !== "All" ? (
                <span
                  aria-hidden
                  className="size-[5px]"
                  style={{ background: TAG_HUE[t] }}
                />
              ) : null}
              {t}
            </span>
          </button>
        ))}
      </div>

      <LayoutGroup>
        <div className="mt-12 min-h-[60vh]">
          <AnimatePresence initial={false} mode="popLayout">
            {days.map(([date, entries]) => (
              <motion.section
                layout
                key={date}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="grid gap-6 border-t border-line py-10 md:grid-cols-[200px_1fr] md:gap-12"
              >
                <div className="md:sticky md:top-[calc(var(--nav-h)+2rem)] md:self-start">
                  <time
                    dateTime={date}
                    className="font-mono text-[12px] tracking-wide text-fg-3 uppercase"
                  >
                    {formatDate(date)}
                  </time>
                </div>
                <div className="flex flex-col gap-10">
                  <AnimatePresence initial={false} mode="popLayout">
                    {entries.map((e) => (
                      <motion.article
                        layout
                        key={e.title}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <span className="type-label flex items-center gap-2 text-fg-4">
                          <span
                            aria-hidden
                            className="size-[5px]"
                            style={{ background: TAG_HUE[e.tag] }}
                          />
                          {e.tag}
                          {e.pr ? (
                            <span className="text-fg-4/70">· #{e.pr}</span>
                          ) : null}
                        </span>
                        <h2 className="mt-3 text-[22px] leading-[30px] font-[560] tracking-[-0.02em] text-fg">
                          {e.title}
                        </h2>
                        <p className="mt-2 max-w-[38rem] text-[15px] leading-[25px] text-fg-3">
                          {e.summary}
                        </p>
                      </motion.article>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.section>
            ))}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    </div>
  )
}
