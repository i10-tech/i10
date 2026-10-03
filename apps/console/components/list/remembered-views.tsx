"use client"

import * as React from "react"

export type View = "grid" | "table"

/** The cookie a list page's chosen view is kept in, so the server knows it. */
export const viewCookie = (key: string) => `i10-view-${key}`

/**
 * The views list pages were left in, read from cookies by the app layout.
 *
 * ⚠ SO THE SERVER RENDERS THE RIGHT ONE. Kept only in local storage - which
 * the server cannot read - a page always rendered its default first, then
 * switched once the browser took over: a table page refreshed into a grid
 * for a moment.
 */
const RememberedViews = React.createContext<Record<string, View>>({})

export function RememberedViewsProvider({
  views,
  children,
}: {
  views: Record<string, View>
  children: React.ReactNode
}) {
  return <RememberedViews.Provider value={views}>{children}</RememberedViews.Provider>
}

export function useServerViews(): Record<string, View> {
  return React.useContext(RememberedViews)
}
