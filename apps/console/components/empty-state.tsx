"use client"

import Link from "next/link"
import { motion } from "motion/react"
import { Button } from "@repo/ui/components/button"
import { cn } from "cn"

/**
 * Nothing here yet.
 *
 * ⚠ AN EMPTY STATE HAS TO SAY WHY IT IS EMPTY AND WHAT TO DO, AND THE TWO
 * REASONS NEED DIFFERENT WORDS. "No domains" on a new account means "add one";
 * "no domains" after a filter means "your filter matched nothing". Rendering
 * the same sentence for both is how somebody concludes their data has been
 * deleted. Every caller passes the filtered variant explicitly.
 *
 * ⚠ AND IT IS A DASHED BORDER, NOT A CARD. A solid bordered box full of empty
 * space reads as a component that failed to load; a dashed outline reads as a
 * space waiting to be filled, which is what it is.
 *
 * ⚠ THE ICON SITS ON A SMALL STACK OF TILES, the templates page's folder art in
 * miniature, so every empty list in the console looks like one family.
 */
export function EmptyState({
  title,
  description,
  action,
  secondary,
  icon,
  className,
}: {
  title: string
  description?: string
  action?: { label: string; href: string }
  secondary?: React.ReactNode
  /** A lucide icon, e.g. `<Globe />`. */
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      {icon && (
        <div className="group/empty relative mb-5 size-14" aria-hidden>
          <span className="absolute inset-0 translate-x-1.5 -translate-y-1 rotate-6 rounded-2xl border bg-muted/60 transition-transform duration-300 ease-out group-hover/empty:translate-x-2.5 group-hover/empty:rotate-12" />
          <span className="absolute inset-0 -translate-x-1 rotate-[-4deg] rounded-2xl border bg-muted transition-transform duration-300 ease-out group-hover/empty:-translate-x-2 group-hover/empty:-rotate-8" />
          <span className="absolute inset-0 grid place-items-center rounded-2xl border bg-background text-muted-foreground shadow-sm [&_svg]:size-6">
            {icon}
          </span>
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {(action || secondary) && (
        <div className="mt-5 flex items-center gap-2">
          {action && (
            <Button size="sm" asChild>
              <Link href={action.href}>{action.label}</Link>
            </Button>
          )}
          {secondary}
        </div>
      )}
    </motion.div>
  )
}
