"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "motion/react"
import { X } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Kbd } from "@repo/ui/components/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { useRetained } from "@/lib/react"

/**
 * What is ticked, and what can be done to all of it: the bar that rises from
 * the bottom of the list on the first tick, as the templates page's does.
 *
 * ⚠ IT FLOATS OVER THE LIST RATHER THAN PUSHING IT. A bar inserted above the
 * rows moves the row somebody just ticked out from under the pointer, and the
 * next click lands on its neighbour.
 *
 * ⚠ ESC CLEARS, unless a dialog or menu has the key.
 *
 * ⚠ FIXED TO THE SCREEN, CENTRED OVER THE PAGE - not sticky to the list.
 * Sticky, it could only float inside the list's own box, so under a short
 * list it sat right below the last row instead of at the bottom of the view.
 * It is centred on the page pane (measured from the element it is placed in)
 * rather than the window, so it lines up with the content, not the rail.
 *
 * ⚠ RENDERED INTO <body>. The page's enter animation leaves a transform on a
 * wrapper, and `fixed` inside a transformed element is fixed to THAT element:
 * the bar landed a rail's width too far right and at the wrapper's bottom.
 */
export function BulkBar({
  count,
  onClear,
  label,
  note,
  children,
}: {
  count: number
  onClear: () => void
  /** The toolbar's accessible name, e.g. "Selected contacts". */
  label: string
  /** A short qualifier after the count, e.g. "on this page". */
  note?: string
  children: React.ReactNode
}) {
  // The count holds while the bar fades out, so it never reads "0 selected".
  const shown = useRetained(count || null) ?? 0

  React.useEffect(() => {
    if (count === 0) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea")) return
      onClear()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [count, onClear])

  // The page pane: the nearest scrolling ancestor of where the bar is placed.
  const anchor = React.useRef<HTMLSpanElement>(null)
  const [pane, setPane] = React.useState<{ left: number; width: number } | null>(null)
  React.useLayoutEffect(() => {
    const el = anchor.current
    if (!el) return
    let host: HTMLElement | null = el.parentElement
    while (host && !/(auto|scroll)/.test(getComputedStyle(host).overflowY))
      host = host.parentElement
    const target = host ?? document.documentElement
    const measure = () => {
      const r = target.getBoundingClientRect()
      setPane({ left: r.left, width: r.width })
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(target)
    window.addEventListener("resize", measure)
    return () => {
      watch.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  return (
    <>
      <span ref={anchor} hidden />
      {pane &&
        createPortal(
          <div
            className="pointer-events-none fixed bottom-6 z-40 flex justify-center"
            style={{ left: pane.left, width: pane.width }}
          >
            <AnimatePresence>
              {count > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 16, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    y: 12,
                    scale: 0.98,
                    transition: { duration: 0.15 },
                  }}
                  transition={{ type: "spring", stiffness: 500, damping: 36 }}
                  className="pointer-events-auto flex items-center gap-1 rounded-2xl border bg-popover/95 p-1.5 pl-3.5 text-sm shadow-xl backdrop-blur-md"
                  role="toolbar"
                  aria-label={label}
                >
                  <span className="tabular pr-1 font-medium">
                    <motion.span
                      key={shown}
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="inline-block"
                    >
                      {shown}
                    </motion.span>{" "}
                    selected
                    {note && (
                      <span className="font-normal text-muted-foreground"> {note}</span>
                    )}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7"
                        onClick={onClear}
                        aria-label="Clear selection"
                      >
                        <X />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Clear <Kbd className="ml-1">Esc</Kbd>
                    </TooltipContent>
                  </Tooltip>
                  <div className="mx-1 h-5 w-px bg-border" />
                  {children}
                </motion.div>
              )}
            </AnimatePresence>
          </div>,
          document.body,
        )}
    </>
  )
}
