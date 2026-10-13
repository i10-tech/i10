"use client"

import * as React from "react"
import { countCookie, MAX_SKELETON_ROWS, parseCounts } from "@/lib/list-counts"

/**
 * How many rows each list had the last time it loaded, for this workspace
 * (2026-10-13) - so a loading page draws what is about to arrive: two rows
 * for two domains, the empty state for none, instead of a fixed eight rows
 * for everybody.
 *
 * ⚠ A COOKIE, SO THE SERVER RENDERS IT, the same reason as the remembered
 * views (see remembered-views.tsx): read only in the browser, the skeleton
 * would draw eight and then jump to two.
 *
 * ⚠ KEYED BY WORKSPACE. The value carries the tenant it was counted in, and
 * a different workspace's count is ignored - one workspace's fifty domains
 * say nothing about another's.
 *
 * ⚠ ONLY AN UNFILTERED FIRST PAGE IS COUNTED. A search that matched one row
 * is not what the list holds; pages report through `RememberCount` and say
 * when they are filtered.
 */

interface Counts {
  tenantId: string
  counts: Record<string, number>
}

const RememberedCounts = React.createContext<Counts>({ tenantId: "", counts: {} })

export function RememberedCountsProvider({
  tenantId,
  counts,
  children,
}: Counts & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ tenantId, counts }), [tenantId, counts])
  return <RememberedCounts.Provider value={value}>{children}</RememberedCounts.Provider>
}

const listeners = new Set<() => void>()

function readCookie(key: string, tenantId: string): number | null {
  const name = `${countCookie(key)}=`
  const raw = document.cookie
    .split("; ")
    .find((part) => part.startsWith(name))
    ?.slice(name.length)
  if (!raw) return null
  return parseCounts([{ name: countCookie(key), value: raw }], tenantId)[key] ?? null
}

/**
 * The count a skeleton should draw for `key`: null when it has never been
 * seen in this workspace (draw the default), 0 for the empty state.
 */
export function useRememberedCount(key: string | undefined): number | null {
  const { tenantId, counts } = React.useContext(RememberedCounts)
  const fromServer = key ? (counts[key] ?? null) : null
  return React.useSyncExternalStore(
    (notify) => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    () => (key && tenantId ? (readCookie(key, tenantId) ?? fromServer) : fromServer),
    () => fromServer,
  )
}

/** Rendered by a list page with what it has just loaded. Draws nothing. */
export function RememberCount({
  list,
  count,
  filtered = false,
}: {
  list: string
  count: number
  /** A filtered or later page says nothing about the list as a whole. */
  filtered?: boolean
}) {
  const { tenantId } = React.useContext(RememberedCounts)
  React.useEffect(() => {
    if (filtered || !tenantId) return
    const capped = Math.min(count, MAX_SKELETON_ROWS)
    if (readCookie(list, tenantId) === capped) return
    const secure = window.location.protocol === "https:" ? "; secure" : ""
    document.cookie = `${countCookie(list)}=${encodeURIComponent(`${tenantId}:${capped}`)}; path=/; max-age=31536000; samesite=lax${secure}`
    for (const notify of listeners) notify()
  }, [list, count, filtered, tenantId])
  return null
}
