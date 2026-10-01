import * as React from "react"
import Link from "next/link"
import { cn } from "cn"

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
    <div className={cn("overflow-x-auto rounded-2xl border bg-background", className)}>
      <table className="w-full text-sm">{children}</table>
    </div>
  )
}

export function ListHeader({ children }: { children: React.ReactNode }) {
  return (
    <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
      <tr>{children}</tr>
    </thead>
  )
}

export function ListHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4",
        className,
      )}
      {...props}
    />
  )
}

export function ListBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y", className)} {...props} />
}

/** Hover, and the entrance every new page of rows gets. */
export const rowClass = "group transition-colors duration-150 hover:bg-muted/40"

export function ListRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(rowClass, "animate-in fade-in-0 duration-300", className)}
      {...props}
    />
  )
}

export function ListCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-3 first:pl-4 last:pr-4", className)} {...props} />
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
        "block px-3 py-3 outline-none focus-visible:bg-muted/60",
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
