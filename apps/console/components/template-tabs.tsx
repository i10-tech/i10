"use client"

import * as React from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs"

/**
 * The template page's sections, with the open one in the URL.
 *
 * ⚠ `?tab=` IS WRITTEN WITH `replaceState`, NOT A NAVIGATION. Switching tabs
 * must not refetch the page or add a history entry per click; the URL only
 * has to survive a reload and a shared link.
 */
export function TemplateTabs({
  initial,
  tabs,
}: {
  initial: string
  tabs: { value: string; label: string; content: React.ReactNode }[]
}) {
  const [tab, setTab] = React.useState(
    tabs.some((t) => t.value === initial) ? initial : tabs[0]!.value,
  )
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value)
        const url = new URL(window.location.href)
        url.searchParams.set("tab", value)
        window.history.replaceState(window.history.state, "", url)
      }}
    >
      <TabsList>
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="pt-4">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
