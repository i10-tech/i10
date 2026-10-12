"use client"

import * as React from "react"
import { Checkbox } from "@repo/ui/components/checkbox/checkbox"
import { useResetWhen } from "@/lib/react"

/**
 * Ticking rows for the bulk bar, the same on every list: click a box to tick
 * one, shift-click to tick the run since the last one, the header box for
 * all of them.
 *
 * ⚠ ONLY WHAT IS ON SCREEN CAN STAY TICKED. Narrowing the filter drops the
 * rows it hides from the selection, so the bar never acts on a row nobody can
 * see. (The domains list is where this started; see domains-list.tsx.)
 */
export function useListSelection<T>(rows: T[], idOf: (row: T) => string) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [anchor, setAnchor] = React.useState<string | null>(null)
  const ids = rows.map(idOf)
  useResetWhen(ids.join(","), () =>
    setSelected((prev) => new Set([...prev].filter((id) => ids.includes(id)))),
  )
  const clear = React.useCallback(() => setSelected(new Set()), [])

  function toggle(id: string, shiftKey: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      const on = !prev.has(id)
      if (shiftKey && anchor && ids.includes(anchor)) {
        const a = ids.indexOf(anchor)
        const b = ids.indexOf(id)
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          if (on) next.add(x)
          else next.delete(x)
        }
      } else if (on) next.add(id)
      else next.delete(id)
      return next
    })
    setAnchor(id)
  }

  const picked = rows.filter((row) => selected.has(idOf(row)))
  const all = rows.length > 0 && picked.length === rows.length

  return {
    picked,
    clear,
    isTicked: (row: T) => selected.has(idOf(row)),
    /** The header's box: ticks everything shown, or nothing. */
    headerBox: (label: string) => (
      <Checkbox
        checked={all ? true : picked.length > 0 ? "indeterminate" : false}
        aria-label={label}
        onCheckedChange={(checked) =>
          setSelected(checked === true ? new Set(ids) : new Set())
        }
      />
    ),
    /** A row's box. It never follows the row's link. */
    rowBox: (row: T, label: string) => (
      <Checkbox
        checked={selected.has(idOf(row))}
        aria-label={label}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          toggle(idOf(row), event.shiftKey)
        }}
      />
    ),
  }
}

/**
 * Runs one action over every picked row, one at a time, and counts the
 * outcome. In sequence rather than all at once: the API rate-limits a
 * workspace, and a burst of twenty deletes would trip it halfway.
 */
export async function forEachPicked<T>(
  rows: T[],
  act: (row: T) => Promise<{ ok: boolean }>,
): Promise<{ done: number; failed: number }> {
  let done = 0
  let failed = 0
  for (const row of rows) {
    const result = await act(row).catch(() => ({ ok: false }))
    if (result.ok) done += 1
    else failed += 1
  }
  return { done, failed }
}
