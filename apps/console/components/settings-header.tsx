"use client"

import * as React from "react"
import { usePendingNavigation } from "@/lib/pending-navigation"
import { useRoutePathname } from "@/lib/target-route"
import {
  PageActions,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { findSettingsItem } from "@/lib/nav"
import { SETTINGS_COPY } from "@/lib/page-copy"

/**
 * The settings header, rendered in the settings layout so the title morphs
 * between tabs.
 *
 * ⚠ THE TITLE RESOLVES FROM THE CURRENT ROUTE, NOT HARDCODED AS "Settings".
 * The settings shell layout persists across navigation between settings tabs,
 * which means `PageTitle`'s letter-morphing plays on the text difference when
 * moving between General, Team, Single sign-on, etc.
 */
export function SettingsHeader({ actions }: { actions?: React.ReactNode }) {
  const current = useRoutePathname()
  // The tab just clicked names the page at once, as its skeleton draws below.
  const pending = usePendingNavigation()?.pathname
  const pathname = pending && findSettingsItem(pending) ? pending : current
  const item = findSettingsItem(pathname)
  const label = item?.label ?? "Settings"
  const description = item ? SETTINGS_COPY[item.href] : undefined

  return (
    <PageHeader>
      <PageHeaderRow>
        <PageTitle>{label}</PageTitle>
        <PageActions>{actions}</PageActions>
      </PageHeaderRow>
      {description ? <PageDescription>{description}</PageDescription> : null}
    </PageHeader>
  )
}
