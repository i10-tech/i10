"use client"

import * as React from "react"
import { MoreHorizontal } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { rowMenuClass } from "@/components/list/table"

/**
 * A row's `•••` and the menu behind it - the one spelling every list in the
 * console uses (2026-10-03).
 *
 * ⚠ IT EXISTS SO THE MENUS CANNOT DRIFT. Seven lists each wrote the trigger
 * and the panel by hand, and they had already split: some menus were modal and
 * locked the page's scroll while open, some were not; the panels were three
 * different widths. Only the items differ between rows, so only the items are
 * left to the caller.
 *
 * ⚠ NOT MODAL. A row menu is a shortcut, not a decision; locking the page and
 * swallowing the next click outside it made dismissing one cost a click.
 *
 * ⚠ THE LABEL NAMES THE ROW, because there is one of these per row and
 * "Actions" repeated nine times tells a screen reader nothing about which row
 * it is on.
 */
export function RowMenu({
  label,
  children,
}: {
  /** What the row is called - "acme.com", "production-api". */
  label: string
  children: React.ReactNode
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={rowMenuClass}
          aria-label={`Actions for ${label}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
