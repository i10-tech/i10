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
  children,
}: {
  id: string
  href?: string
  menu?: React.ReactNode
  /** Revoked, disabled: still listed, quieter. */
  muted?: boolean
  children: React.ReactNode
}) {
  const body = <div className="flex h-full flex-col gap-3 p-4">{children}</div>
  const surface = cn(
    "block h-full rounded-2xl border bg-background outline-none",
    "transition-[border-color,box-shadow,transform] duration-200 ease-out",
    "hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.18)]",
    "focus-visible:ring-2 focus-visible:ring-ring",
    muted && "opacity-60",
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
