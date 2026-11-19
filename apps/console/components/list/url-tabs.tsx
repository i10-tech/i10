"use client"

import * as React from "react"
import { useRoutePathname, useRouteSearchParams } from "@/lib/target-route"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { cn } from "cn"

export interface UrlTabItem {
  value: string
  label: React.ReactNode
  badge?: React.ReactNode
}

export interface UrlTabsProps {
  value?: string
  fallback: string
  /** Parameters that survive a tab switch. */
  keep?: string[]
  /** Tab list decided by the caller from the shape. Draws real tab labels in both modes. */
  tabs?: (string | UrlTabItem)[]
  loading?: boolean
  className?: string
  children?: React.ReactNode
}

/**
 * Tabs whose choice is `?tab=`, so a filter inside one tab - itself a URL
 * change - comes back to the same tab, and a link can open on either.
 *
 * ⚠ REAL TAB LABELS IN BOTH MODES. The tab list is decided by the caller from
 * the shape; the active tab comes from the URL.
 *
 * ⚠ THE OTHER TAB'S FILTERS GO WITH THE SWITCH. They narrow a list that is no
 * longer on screen, and would be waiting, unexplained, on the way back.
 */
export function UrlTabs({
  value,
  fallback,
  keep = [],
  tabs,
  className,
  children,
}: {
  value?: string
  fallback: string
  /** Parameters that survive a tab switch. */
  keep?: string[]
  /** Tab list decided by the caller from the shape. Draws real tab labels in both modes. */
  tabs?: (string | UrlTabItem)[]
  loading?: boolean
  className?: string
  children?: React.ReactNode
}) {
  const pathname = useRoutePathname()
  const searchParams = useRouteSearchParams()
  const urlTab = searchParams.get("tab") ?? undefined
  const target = value ?? urlTab ?? fallback

  const [tab, setTab] = React.useState(target)
  const [seen, setSeen] = React.useState(target)
  if (target !== seen) {
    setSeen(target)
    setTab(target)
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        setTab(next)
        const params = new URLSearchParams()
        for (const name of keep) {
          const v = searchParams.get(name)
          if (v) params.set(name, v)
        }
        if (next !== fallback) params.set("tab", next)
        const query = params.toString()
        /*
         * ⚠ `history.replaceState`, NOT `router.replace` (2026-10-03). Both
         * tabs are already rendered; asking the server for the page again on
         * every switch re-ran every read the page makes and repainted it, which
         * is a reload wearing a tab's clothes. Next keeps `useSearchParams` in
         * step with a native replaceState, so the URL still says which tab.
         */
        window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname)
      }}
    >
      {tabs && tabs.length > 0 && (
        <div
          className={cn(
            "-mx-4 mb-6 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0",
            className,
          )}
        >
          <TabsList>
            {tabs.map((t) => {
              const item: UrlTabItem =
                typeof t === "string" ? { value: t.toLowerCase(), label: t } : t
              return (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                  {item.badge}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>
      )}
      {children}
    </Tabs>
  )
}

export { TabsList, TabsTrigger, TabsContent }
