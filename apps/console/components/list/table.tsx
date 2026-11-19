import * as React from "react"
import Link from "next/link"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { cn } from "cn"
import arc from "@repo/ui/components/sortable-data-table/sortable-data-table.module.css"

/**
 * The table every list draws, the templates table's shape: a rounded frame, a
 * quiet header band, rows that answer the pointer.
 *
 * ⚠ PLAIN ELEMENTS, NO CLIENT CODE, so a server page can render its rows
 * without shipping them to the browser. Rows that animate in and out are
 * `motion.tr` in a client list, given `rowClass`.
 */
/*
 * ⚠ EVERY LIST TABLE HAS A FIXED LAYOUT: THE HEADER'S WIDTHS ARE THE COLUMNS
 * (2026-11-18). The column without a width takes what is left. In the browser's
 * own layout a column is as wide as what is in it, and a skeleton row holds
 * bars, not the values: every column moved when the rows arrived (Domains'
 * Status 41px, API keys' Name 106px), and the tick column was 18px narrower.
 * Fixed, a column is the same with bars in it as with words. The widths match
 * what the loaded tables drew before. It also stops truncating cells
 * (`max-w-0`) handing the spare width to whichever column the browser liked -
 * the emails log once gave it all to To and squeezed Subject to "Welc...".
 */
/*
 * ⚠ A LIST TABLE ADAPTS TO ITS OWN WIDTH, NOT THE WINDOW'S (2026-11-18). The
 * wrapper is a size container (`@container/list`), and a column that can go
 * carries `hideBelow`, a tier of container width. With the browser's sidebar
 * open the window stays wide while the table narrows, and viewport classes
 * (`md:table-cell`) kept columns the table had no room for: cells drew over
 * their neighbours. The lowest-priority column hides first, so the primary
 * column keeps at least ~220px; truncation is the last resort (every cell
 * clips) and the table's min-width scroll the final one. Never overlap.
 *
 * The tiers are container widths in rem, chosen so Name keeps >= 220px with
 * every column of a lower tier showing. For a table whose fixed columns, in
 * px, are F, and the dropped-in columns D1..Dn in priority order: tier k opens
 * at F + 220 + D1 + .. + Dk, rounded up to the next tier.
 *   API keys: F = 344 (tick 68, Key 136, Mode 80, actions 60)
 *     Sends from 136 -> 700 -> sm (704);  Last used 112 -> 812 -> md (832)
 *     Created 96 -> 908 -> lg (928);      Created by 120 -> 1028 -> xl (1056)
 *   Contacts: F = 324 (tick 68, Status 136, Added 120)
 *     Name 160 -> 704 -> sm (704)
 * `2xl` is spare for a table with a fifth optional column.
 */
export type HideBelow = "sm" | "md" | "lg" | "xl" | "2xl"

// ⚠ WRITTEN OUT, NOT BUILT: Tailwind only emits a class it can read in the source.
const HIDE_BELOW: Record<HideBelow, string> = {
  sm: "hidden @min-[44rem]/list:table-cell",
  md: "hidden @min-[52rem]/list:table-cell",
  lg: "hidden @min-[58rem]/list:table-cell",
  xl: "hidden @min-[66rem]/list:table-cell",
  "2xl": "hidden @min-[76rem]/list:table-cell",
}

/** For a raw `<th>`/`<td>` that cannot be a `ListHead`/`ListCell`. */
export const hideBelow = (tier: HideBelow | undefined) =>
  tier ? HIDE_BELOW[tier] : undefined

// A fixed layout does not size a column to its text, so what does not fit is
// cut with an ellipsis. A cell that should wrap says `whitespace-normal`.
const clipped = "overflow-hidden text-ellipsis whitespace-nowrap"

export function ListTable({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn(arc.wrapper, "@container/list", className)}>
      <div className={arc.scroller}>
        <table className={arc.table} data-fixed>
          {children}
        </table>
      </div>
    </div>
  )
}

export function ListHeader({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr>{children}</tr>
    </thead>
  )
}

/** Arc right-aligns a column through `data-numeric`; a `text-right` head opts in. */
const rightAligned = (className?: string) =>
  /(^|\s)text-right(\s|$)/.test(className ?? "") || undefined

export function ListHead({
  className,
  hideBelow: tier,
  ...props
}: React.ComponentProps<"th"> & { hideBelow?: HideBelow }) {
  return (
    <th
      data-numeric={rightAligned(className)}
      className={cn(clipped, hideBelow(tier), className)}
      {...props}
    />
  )
}

// ⚠ `divide-y` LIKE MotionBody's, the page this stands in for while loading. A
// skeleton without the row dividers is a different table.
export function ListBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y", className)} {...props} />
}

/** Hover, and the entrance every new page of rows gets. */
/** Hover and selection paint Arc's cell fill; see `.i10-row` in styles/arc.css. */
// ⚠ A MUTED ROW (revoked, disabled) IS DIMMED BY AN ATTRIBUTE, NOT A CLASS. The
// class is on every row, so a skeleton row and its page carry the same ones;
// whether the row is muted is data, and arrives with it (test/skeleton-parity).
export const rowClass = "i10-row group data-[muted]:opacity-50"

/** A ticked row, the same faint wash on every list that has checkboxes. */
export const selectedRowClass = "i10-row-selected"

/**
 * The picture at the start of a row - an icon in a quiet tile, the shape the
 * templates table gives its thumbnails - so every name in every list starts
 * at the same place.
 */
export function ListTile({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border/60 ring-inset",
        "transition-colors duration-150 group-hover:text-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * A list swapping between its table, grid and empty state: the old one fades
 * out before the new one fades in. With `AnimatePresence mode="wait"
 * initial={false}`, so a page that loads already full or empty does not fade.
 */
export const SWAP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: {
    duration: motionTokens.duration.fast,
    ease: [...motionTokens.ease.standard],
  },
} as const

// ⚠ `clickable` IS MotionRow's `href`, FOR A ROW THAT HAS NO HREF YET: the
// skeleton row of a list whose rows open something looks like it does.
export function ListRow({
  className,
  muted,
  clickable,
  ...props
}: React.ComponentProps<"tr"> & { muted?: boolean; clickable?: boolean }) {
  return (
    <tr
      className={cn(rowClass, clickable && "cursor-pointer", className)}
      data-muted={muted || undefined}
      {...props}
    />
  )
}

export function ListCell({
  className,
  hideBelow: tier,
  ...props
}: React.ComponentProps<"td"> & { hideBelow?: HideBelow }) {
  return (
    <td
      data-numeric={rightAligned(className)}
      className={cn(clipped, hideBelow(tier), className)}
      {...props}
    />
  )
}

/**
 * A whole-row link for a server table: each cell links, since a `<tr>` cannot
 * hold an `<a>`, and the padding moves onto the link so all of the cell is a
 * target - middle-click and the keyboard included.
 */
export function CellLink({
  href,
  className,
  children,
  title,
}: {
  /** Absent in a skeleton row, which has nowhere to go yet and draws the same cell. */
  href?: string
  className?: string
  children: React.ReactNode
  title?: string
}) {
  const classes = cn(
    // The whole cell is the link: it cancels the cell's 16px padding and
    // fills its height, so a click anywhere on the cell opens the record.
    "-mx-4 flex min-h-[52px] items-center px-4 outline-none focus-visible:bg-muted",
    className,
  )
  if (href === undefined) {
    return (
      <a aria-hidden tabIndex={-1} className={classes}>
        {children}
      </a>
    )
  }
  return (
    <Link href={href} title={title} className={classes}>
      {children}
    </Link>
  )
}

/**
 * A row's `•••`: hidden until the row is hovered or the menu is open, on
 * screens with a pointer; always there on touch, where there is no hover.
 */
export const rowMenuClass =
  "size-7 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
