"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Tabs } from "@repo/ui/components/tabs"

/**
 * Tabs whose choice is `?tab=`, so a filter inside one tab - itself a URL
 * change - comes back to the same tab, and a link can open on either.
 *
 * ⚠ THE OTHER TAB'S FILTERS GO WITH THE SWITCH. They narrow a list that is no
 * longer on screen, and would be waiting, unexplained, on the way back.
 */
export function UrlTabs({
  value,
  fallback,
  keep = [],
  children,
}: {
  value: string | undefined
  fallback: string
  /** Parameters that survive a tab switch. */
  keep?: string[]
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [tab, setTab] = React.useState(value ?? fallback)
  const [seen, setSeen] = React.useState(value)
  if (value !== seen) {
    setSeen(value)
    setTab(value ?? fallback)
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
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
      }}
    >
      {children}
    </Tabs>
  )
}
