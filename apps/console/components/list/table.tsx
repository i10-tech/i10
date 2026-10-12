import * as React from "react"
import Link from "next/link"
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
export function ListTable({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn(arc.wrapper, className)}>
      <div className={arc.scroller}>
        <table className={arc.table}>{children}</table>
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

export function ListHead({ className, ...props }: React.ComponentProps<"th">) {
  return <th data-numeric={rightAligned(className)} className={className} {...props} />
}

export function ListBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={className} {...props} />
}

/** Hover, and the entrance every new page of rows gets. */
/** Hover and selection paint Arc's cell fill; see `.i10-row` in styles/arc.css. */
export const rowClass = "i10-row group"

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

export function ListRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(rowClass, "animate-in fade-in-0 duration-300", className)}
      {...props}
    />
  )
}

export function ListCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-numeric={rightAligned(className)} className={className} {...props} />
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
  href: string
  className?: string
  children: React.ReactNode
  title?: string
}) {
  return (
    <Link
      href={href}
      title={title}
      className={cn(
        // The whole cell is the link: it cancels the cell's 16px padding and
        // fills its height, so a click anywhere on the cell opens the record.
        "-mx-4 flex min-h-[52px] items-center px-4 outline-none focus-visible:bg-muted",
        className,
      )}
    >
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
