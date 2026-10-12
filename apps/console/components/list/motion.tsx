"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import { cn } from "cn"
import { rowClass } from "@/components/list/table"

const SPRING = { type: "spring", stiffness: 500, damping: 38, mass: 0.6 } as const

/**
 * The grid view every list shares: cards that make room for each other as a
 * filter narrows them, rather than snapping into new places.
 */
export function ListGrid({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <LayoutGroup>
      <ul
        className={cn(
          "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4",
          className,
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {children}
        </AnimatePresence>
      </ul>
    </LayoutGroup>
  )
}

/**
 * One card. The whole card is the link; `menu` sits above it, so opening the
 * menu never opens the card.
 */
export function ListCard({
  id,
  href,
  menu,
  muted = false,
  select,
  selected = false,
  selecting = false,
  children,
}: {
  id: string
  href?: string
  menu?: React.ReactNode
  /** Revoked, disabled: still listed, quieter. */
  muted?: boolean
  /**
   * The card's tick box for the bulk bar (see list/selection). It shows on
   * hover, and stays on every card once anything is ticked, so ticking a
   * second card is one click rather than a hunt.
   */
  select?: React.ReactNode
  selected?: boolean
  /** Something in the list is ticked. */
  selecting?: boolean
  children: React.ReactNode
}) {
  const body = <div className="flex h-full flex-col gap-3 p-4">{children}</div>
  const surface = cn(
    "block h-full rounded-2xl border bg-background outline-none",
    // ⚠ NO LIFT ON HOVER (2026-10-03). The border and shadow answer the
    // pointer; a card that jumps up under it is the movement nobody asked for.
    "transition-[border-color,box-shadow] duration-200 ease-out",
    "hover:border-foreground/15 hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.18)]",
    "focus-visible:ring-2 focus-visible:ring-ring",
    muted && "opacity-60",
    selected &&
      "border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_5%,var(--background))]",
  )
  return (
    <motion.li
      key={id}
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRING}
      className="group relative"
    >
      {href ? (
        <Link href={href} className={surface}>
          {body}
        </Link>
      ) : (
        <div className={surface}>{body}</div>
      )}
      {select && (
        <div
          className={cn(
            "absolute top-3 flex size-8 items-center justify-center transition-opacity duration-(--duration-fast) ease-(--ease-standard)",
            menu ? "right-11" : "right-3",
            selected || selecting
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          {select}
        </div>
      )}
      {menu && <div className="absolute top-3 right-3">{menu}</div>}
    </motion.li>
  )
}

/**
 * A table row that fades in, closes its gap when it leaves, and opens `href`
 * on a click anywhere outside its own controls.
 *
 * ⚠ THE FIRST LINK IN THE ROW STAYS A REAL LINK, so middle-click and the
 * keyboard still work; the row's click is the convenience on top.
 */
export function MotionRow({
  href,
  className,
  children,
  onClick,
}: {
  href?: string
  className?: string
  children: React.ReactNode
  onClick?: (event: React.MouseEvent) => void
}) {
  const router = useRouter()
  return (
    <motion.tr
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 550, damping: 45, mass: 0.8 }}
      onClick={(event) => {
        /*
         * ⚠ ONLY A CLICK THAT HAPPENED IN THE ROW. React bubbles events from a
         * portal up the component tree, so a dialog or menu opened from this
         * row sent its own clicks here - and the row followed its link under
         * the open dialog (2026-10-12).
         */
        if (!event.currentTarget.contains(event.target as Node)) return
        if (onClick) return onClick(event)
        if (!href) return
        const target = event.target as HTMLElement
        if (target.closest("a, button, [role=menuitem], [role=checkbox], input")) return
        if (window.getSelection()?.toString()) return
        router.push(href)
      }}
      className={cn(rowClass, href && "cursor-pointer", className)}
    >
      {children}
    </motion.tr>
  )
}

/** The tbody for `MotionRow`s, so rows leaving are animated out. */
export function MotionBody({ children }: { children: React.ReactNode }) {
  return (
    <tbody className="divide-y">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </tbody>
  )
}
