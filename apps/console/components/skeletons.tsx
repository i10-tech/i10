"use client"

import * as React from "react"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { SkeletonBlock } from "@repo/ui/components/i10/skeleton-block"
import { cn } from "cn"
import { ListHead, ListHeader, ListTable } from "@/components/list/table"
import { useRememberedView } from "@/components/list/toolbar"
import { useRememberedCount } from "@/components/list/remembered-counts"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import { SkeletonTabs } from "@/components/skeleton-tabs"

/**
 * Loading states shaped like the page they stand in for.
 *
 * ⚠ BUILT FROM THE PAGE'S OWN PARTS, NOT DRAWN TO LOOK LIKE THEM. The header
 * is the real `PageHeader` with the page's real title and description (from
 * lib/page-copy), the table is the real `ListTable` with the real column
 * heads, widths and breakpoints. Only the data is a placeholder, so when the
 * page arrives nothing moves: the words were already there, and every row
 * lands on the row that held its place.
 *
 * ⚠ AND THE VIEW IS THE ONE THE PAGE WILL OPEN IN. A list remembered as cards
 * loads as cards: `useRememberedView` itself, so it is the live choice, not
 * the cookie the layout read when the console first loaded.
 */

/** A placeholder bar. Widths vary row to row, deterministically. */
function Bar({ className }: { className?: string }) {
  return <SkeletonBlock className={cn("h-3.5 rounded-full", className)} />
}

const WIDTHS = ["w-[72%]", "w-[54%]", "w-[86%]", "w-[63%]", "w-[78%]", "w-[47%]"]
const widthFor = (row: number, column: number) =>
  WIDTHS[(row * 3 + column) % WIDTHS.length]

export function PageSkeleton({
  title,
  description,
  actions = [],
  children,
}: {
  title: string
  description?: string
  /** Widths of the header's buttons, left to right, e.g. ["w-16", "w-28"]. */
  actions?: string[]
  children: React.ReactNode
}) {
  return (
    <Page aria-busy="true">
      <PageHeader>
        <PageHeaderRow>
          {/* The title's one entrance plays here; the page then shows it still. */}
          <PlaceholderTitle text={title} className={TITLE} />
          {actions.length > 0 && (
            <PageActions>
              {actions.map((width, i) => (
                <SkeletonBlock
                  key={i}
                  className={cn("h-8 rounded-[var(--radius-control)]", width)}
                />
              ))}
            </PageActions>
          )}
        </PageHeaderRow>
        {description && <PageDescription>{description}</PageDescription>}
      </PageHeader>
      <PageBody className="space-y-4">{children}</PageBody>
    </Page>
  )
}

/** The list toolbar: a search box, its filters, and the view switch. */
export function ToolbarSkeleton({
  filters = 0,
  range = false,
  view = false,
}: {
  filters?: number
  range?: boolean
  view?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SkeletonBlock className="h-9 min-w-48 flex-1 rounded-xl" />
      {range && <SkeletonBlock className="h-9 w-32 rounded-full" />}
      {Array.from({ length: filters }, (_, i) => (
        <SkeletonBlock key={i} className="h-9 w-36 rounded-full" />
      ))}
      {view && <SkeletonBlock className="h-9 w-[4.5rem] rounded-full" />}
    </div>
  )
}

export type Column = {
  /** The column's real heading; empty for a box or menu column. */
  head?: string
  /** The heading's own classes: width, breakpoint, alignment. */
  className?: string
  /** What the cell holds. */
  kind?:
    | "text"
    | "mono"
    | "badge"
    | "status"
    | "number"
    | "box"
    | "menu"
    | "chevron"
    | "tile"
}

function Cell({ column, row, index }: { column: Column; row: number; index: number }) {
  const hidden = column.className?.match(/(^|\s)hidden(\s|$)/)
    ? column.className
        .split(/\s+/)
        .filter((c) => c === "hidden" || c.endsWith(":table-cell"))
        .join(" ")
    : ""
  const right = /(^|\s)text-right(\s|$)/.test(column.className ?? "")
  const kind = column.kind ?? "text"
  let content: React.ReactNode
  switch (kind) {
    case "box":
      content = <SkeletonBlock className="size-4 rounded-[5px]" />
      break
    case "menu":
      content = <SkeletonBlock className="ml-auto size-7 rounded-full opacity-60" />
      break
    case "chevron":
      content = <SkeletonBlock className="size-3.5 rounded-full opacity-50" />
      break
    case "badge":
      content = <SkeletonBlock className="h-5 w-20 rounded-full" />
      break
    case "status":
      content = (
        <span className="flex items-center gap-2">
          <SkeletonBlock className="size-2 rounded-full" />
          <Bar className="w-16" />
        </span>
      )
      break
    case "number":
      content = <Bar className={cn("w-12", right && "ml-auto")} />
      break
    case "tile":
      content = (
        <span className="flex items-center gap-3">
          <SkeletonBlock className="size-8 shrink-0 rounded-[10px]" />
          <Bar className={widthFor(row, index)} />
        </span>
      )
      break
    default:
      content = (
        <Bar
          className={cn(
            widthFor(row, index),
            kind === "mono" && "h-3",
            right && "ml-auto w-16",
          )}
        />
      )
  }
  return (
    <td
      className={cn(
        hidden,
        (kind === "box" || index === 0) && "pl-4",
        kind === "box" && "w-10",
        "py-[1.1rem]",
      )}
    >
      {content}
    </td>
  )
}

/** A list as a table: the real headings over placeholder rows. */
/**
 * The rows to draw: the list's remembered count when there is one (see
 * components/list/remembered-counts), else the page's guess.
 */
function useRows(list: string | undefined, fallback: number): number {
  const remembered = useRememberedCount(list)
  return remembered === null ? fallback : Math.min(remembered, MAX_SKELETON_ROWS)
}

/**
 * A list that was empty last time loads as its empty state - the icon tile,
 * the two lines and the button - not as rows that are about to vanish.
 */
export function EmptySkeleton({ action = true }: { action?: boolean }) {
  return (
    <div
      aria-hidden
      className="flex flex-col items-center px-5 py-[clamp(2rem,8vw,3rem)] text-center"
    >
      <SkeletonBlock className="size-12 rounded-[var(--radius-panel)]" />
      <Bar className="mt-5 h-4 w-40" />
      <Bar className="mt-3 h-3 w-64 max-w-full opacity-70" />
      <Bar className="mt-2 h-3 w-48 max-w-full opacity-70" />
      {action && (
        <SkeletonBlock className="mt-5 h-8 w-32 rounded-[var(--radius-control)]" />
      )}
    </div>
  )
}

export function TableSkeleton({
  columns,
  rows: fallback = 8,
  list,
  fixed,
}: {
  columns: Column[]
  rows?: number
  /** The list's key, to draw as many rows as it had last time. */
  list?: string
  /** Match a page that lays its table out fixed (see ListTable). */
  fixed?: boolean
}) {
  const rows = useRows(list, fallback)
  if (rows === 0) return <EmptySkeleton />
  return (
    <ListTable fixed={fixed}>
      <ListHeader>
        {columns.map((column, i) =>
          column.kind === "box" ? (
            <th key={i} className="w-10 py-2.5 pl-4">
              <SkeletonBlock className="size-4 rounded-[5px]" />
            </th>
          ) : (
            <ListHead key={i} className={column.className}>
              {column.head ?? <span className="sr-only">Actions</span>}
            </ListHead>
          ),
        )}
      </ListHeader>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row} style={{ opacity: 1 - row * (0.5 / Math.max(rows, 6)) }}>
            {columns.map((column, i) => (
              <Cell key={i} column={column} row={row} index={i} />
            ))}
          </tr>
        ))}
      </tbody>
    </ListTable>
  )
}

/** A list as cards, the shape `ListCard` draws. */
export function CardGridSkeleton({
  count: fallback = 6,
  className,
  lines = 2,
  list,
}: {
  count?: number
  className?: string
  lines?: number
  /** The list's key, to draw as many cards as it had last time. */
  list?: string
}) {
  const count = useRows(list, fallback)
  if (count === 0) return <EmptySkeleton />
  return (
    <ul className={cn("grid gap-3 sm:grid-cols-2", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li
          key={i}
          className="flex flex-col gap-3 rounded-2xl border p-4"
          style={{ opacity: 1 - i * 0.08 }}
        >
          <div className="flex items-center gap-3">
            <SkeletonBlock className="size-9 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Bar className={widthFor(i, 0)} />
              <Bar className="h-3 w-24 opacity-70" />
            </div>
          </div>
          {Array.from({ length: lines }, (_, l) => (
            <div key={l} className="flex gap-1.5">
              <SkeletonBlock className="h-5 w-24 rounded-full" />
              <SkeletonBlock className="h-5 w-28 rounded-full" />
              {l === 0 && <SkeletonBlock className="h-5 w-10 rounded-full" />}
            </div>
          ))}
          <div className="mt-auto flex items-center justify-between">
            <span className="flex items-center gap-2">
              <SkeletonBlock className="size-2 rounded-full" />
              <Bar className="w-16" />
            </span>
            <Bar className="w-10" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Table or cards, whichever the list is remembered as. */
export function RememberedListSkeleton({
  viewKey,
  fallback,
  table,
  grid,
}: {
  viewKey: string
  fallback: "table" | "grid"
  table: React.ReactNode
  grid: React.ReactNode
}) {
  const remembered = useRememberedCount(viewKey)
  // The same store the view switch writes, so a choice made a moment ago on
  // another page is the one this loads in, not the one the server last saw.
  const [view] = useRememberedView(viewKey, fallback)
  // Empty last time: the empty state, whichever view it was left in.
  if (remembered === 0) return <EmptySkeleton />
  return <>{view === "grid" ? grid : table}</>
}

/** A record's page: crumb, icon and name, the facts row, tabs, a panel. */
export function DetailSkeleton({
  tabs = [],
  facts = 4,
  children,
}: {
  tabs?: string[]
  facts?: number
  children?: React.ReactNode
}) {
  return (
    <Page aria-busy="true">
      <PageHeader>
        <PageHeaderRow>
          <div className="flex min-w-0 items-center gap-3">
            <SkeletonBlock className="size-5 rounded-md" />
            <SkeletonBlock className="h-7 w-64 rounded-lg" />
          </div>
          <SkeletonBlock className="h-8 w-32 rounded-[var(--radius-control)]" />
        </PageHeaderRow>
      </PageHeader>
      <PageBody className="space-y-8">
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {Array.from({ length: facts }, (_, i) => (
            <div key={i} className="space-y-2.5">
              <Bar className="h-3 w-16 opacity-70" />
              <Bar className={widthFor(i, 2)} />
            </div>
          ))}
        </div>
        {tabs.length > 0 && <SkeletonTabs tabs={tabs} />}
        {children}
      </PageBody>
    </Page>
  )
}

/** A settings page: sections of label, help line and control. */
export function SectionsSkeleton({ sections = 3 }: { sections?: number }) {
  return (
    <div aria-busy="true" className="space-y-0">
      {Array.from({ length: sections }, (_, i) => (
        <div key={i} className="space-y-4 border-b py-6 first:pt-0 last:border-b-0">
          <div className="space-y-2">
            <Bar className="h-4 w-32" />
            <Bar className={cn("h-3 opacity-70", widthFor(i, 1), "max-w-md")} />
          </div>
          <SkeletonBlock className="h-14 w-full max-w-md rounded-full" />
        </div>
      ))}
    </div>
  )
}

/** The template library's cards: a preview, a name and a line, as many as it had. */
export function TemplateGridSkeleton({ list = "templates" }: { list?: string }) {
  const count = useRows(list, 8)
  if (count === 0) return <EmptySkeleton />
  return (
    <ul
      aria-hidden
      className="grid grid-cols-1 gap-x-4 gap-y-6 pt-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
    >
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="space-y-3" style={{ opacity: 1 - i * 0.07 }}>
          <SkeletonBlock className="aspect-[4/3] w-full rounded-xl" />
          <div className="space-y-2 px-0.5">
            <SkeletonBlock className="h-3.5 w-2/3 rounded-full" />
            <SkeletonBlock className="h-3 w-1/3 rounded-full opacity-70" />
          </div>
        </li>
      ))}
    </ul>
  )
}
