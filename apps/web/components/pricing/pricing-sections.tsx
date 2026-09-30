"use client"

import { useState } from "react"
import { cn } from "cn"
import { ButtonLink } from "@/components/ui/button-link"
import { ADD_ONS, COMPARE, FAQ } from "@/lib/pricing"

export function AddOns() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {ADD_ONS.map((a) => (
        <div key={a.name} data-reveal className="flex flex-col rounded-[18px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)]">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[16px] font-[540] text-fg">{a.name}</p>
            <p className="font-mono text-[12px] text-fg-2">{a.price}</p>
          </div>
          <p className="mt-3 max-w-[46ch] text-[14px] leading-[22px] text-fg-3">{a.body}</p>
          <ButtonLink href="/contact" variant="ghost" arrow className="mt-6 w-fit">
            {a.cta}
          </ButtonLink>
        </div>
      ))}
    </div>
  )
}

const PLANS = ["Free", "Pro", "Scale", "Enterprise"]

/*
 * The comparison table. The plan names stick under the nav while the rows
 * scroll, so a value is never more than a glance from its column.
 */
export function CompareTable() {
  return (
    <div className="relative">
      <div className="sticky top-[calc(var(--nav-h)+1rem)] z-10 grid grid-cols-[1.6fr_repeat(4,1fr)] rounded-[12px] bg-surface-2/90 px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)] backdrop-blur-xl max-md:grid-cols-[1.2fr_repeat(4,1fr)]">
        <span className="type-label self-center text-fg-4">Compare plans</span>
        {PLANS.map((p) => (
          <span key={p} className="text-center text-[13px] font-[540] text-fg">
            {p}
          </span>
        ))}
      </div>
      {COMPARE.map((section) => (
        <div key={section.section} className="mt-10">
          <p className="px-4 text-[15px] font-[560] tracking-[-0.01em] text-fg">{section.section}</p>
          <div className="mt-3 border-t border-line">
            {section.rows.map((row) => (
              <div
                key={row.label}
                className="grid grid-cols-[1.6fr_repeat(4,1fr)] items-center border-b border-line-faint px-4 py-3 transition-colors hover:bg-white/[0.015] max-md:grid-cols-[1.2fr_repeat(4,1fr)]"
              >
                <span className="text-[13.5px] text-fg-2">{row.label}</span>
                {row.values.map((v, i) => (
                  <span key={i} className="flex justify-center text-center text-[13px] text-fg-2">
                    {v === true ? (
                      <svg viewBox="0 0 16 16" width="15" height="15" aria-label="Included" className="text-delivered">
                        <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : v === false ? (
                      <span aria-label="Not included" className="text-fg-4">
                        -
                      </span>
                    ) : (
                      v
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/*
 * FAQ rows open with the grid-rows trick (0fr to 1fr), which animates to the
 * content's real height without measuring it.
 */
export function Faq() {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <ul className="border-t border-line">
      {FAQ.map((item, i) => {
        const isOpen = open === i
        return (
          <li key={item.q} className="border-b border-line">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : i)}
              className="flex w-full cursor-pointer items-center justify-between gap-6 py-5 text-left text-[15px] text-fg transition-colors hover:text-white"
            >
              {item.q}
              <span className="relative grid size-5 shrink-0 place-items-center text-fg-3">
                <span className="absolute h-px w-3 bg-current" />
                <span className={cn("absolute h-3 w-px bg-current transition-transform duration-300", isOpen && "scale-y-0")} />
              </span>
            </button>
            <div className={cn("grid transition-[grid-template-rows,opacity] duration-400 ease-[var(--ease-out-quint)]", isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
              <div className="overflow-hidden">
                <p className="max-w-[60ch] pb-6 text-[14.5px] leading-[24px] text-fg-3">{item.a}</p>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
