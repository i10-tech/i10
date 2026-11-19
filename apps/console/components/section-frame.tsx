"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  Page,
  PageBody,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { PageTransition } from "@repo/ui/components/i10/page-transition"
import { matchSkeleton } from "@/components/instant-skeleton"
import { SettingsHeader } from "@/components/settings-header"
import { SettingsWorkspace } from "@/components/settings-workspace"
import { useClerkEnabled } from "@/lib/clerk-enabled"
import { usePendingNavigation, type PendingNavigation } from "@/lib/pending-navigation"
import { TargetRoute } from "@/lib/target-route"

/**
 * ⚠ SECTIONS WHOSE LAYOUT DRAWS THE HEADER, SO IT MUST NOT RE-ENTER INSIDE
 * THEM. Keyed on the full pathname, `/settings/sso/connect` to `/settings/sso`
 * remounted the whole layout: "Settings" rose and faded in again although it
 * never changed, and the workspace picker beside it remounted and redrew. Inside
 * these the frame holds still and `SectionContent` animates only the body.
 */
const SHARED_HEADER = ["/settings", "/account", "/reference"]

export function frameKey(pathname: string) {
  return (
    SHARED_HEADER.find((s) => pathname === s || pathname.startsWith(`${s}/`)) ??
    pathname
  )
}

/**
 * The settings frame: the layout's, and the skeleton's when settings is
 * entered from elsewhere (`SkeletonFor`), so the two cannot drift.
 *
 * ⚠ THE HEADING LIVES HERE, NOT IN EACH PAGE. Eight pages each rendering their
 * own title is eight chances for one of them to be two pixels out - which
 * nobody can name and everybody feels as they move between tabs. It names the
 * active tab, so the title morphs as you move between tabs while the layout
 * persists and the actions hold still.
 */
export function SettingsShell({
  actions,
  children,
}: {
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Page>
      <SettingsHeader actions={actions} />

      {/*
       * ⚠ A MAX WIDTH, BECAUSE SETTINGS IS PROSE AND FORMS. Without the second
       * column the content is free to run the full width of a desktop window,
       * where a label and its field end up a hand's width apart.
       */}
      <PageBody>
        <div className="min-w-0 max-w-3xl">
          <SectionContent>{children}</SectionContent>
        </div>
      </PageBody>
    </Page>
  )
}

/** The account frame: one word of copy apart from the settings one. */
export function AccountShell({ children }: { children: React.ReactNode }) {
  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Account</PageTitle>
        </PageHeaderRow>
      </PageHeader>

      <PageBody>
        <div className="min-w-0 max-w-3xl">
          <SectionContent>{children}</SectionContent>
        </div>
      </PageBody>
    </Page>
  )
}

/**
 * A page's own skeleton, drawn for a navigation Next has not committed yet.
 *
 * ⚠ `framed` IS FOR ARRIVING IN A SECTION FROM OUTSIDE IT. Settings pages draw
 * only their body, under the header their layout draws; coming from Domains
 * there is no such layout on screen yet, so the skeleton brings the frame.
 * Moving within a section keeps the frame that is there (`SectionContent`).
 */
export function SkeletonFor({
  pending,
  framed,
}: {
  pending: PendingNavigation
  framed: boolean
}) {
  const clerk = useClerkEnabled()
  const match = matchSkeleton(pending.pathname)
  const route = React.useMemo(
    () => ({
      pathname: pending.pathname,
      params: match?.params ?? {},
      searchParams: new URLSearchParams(pending.search),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending],
  )
  if (!match) return null
  const body = <match.Loading />
  const section = framed ? frameKey(pending.pathname) : null
  return (
    <TargetRoute value={route}>
      {section === "/settings" ? (
        <SettingsShell actions={<SettingsWorkspace clerkEnabled={clerk} />}>
          {body}
        </SettingsShell>
      ) : section === "/account" ? (
        <AccountShell>{body}</AccountShell>
      ) : (
        body
      )}
    </TargetRoute>
  )
}

/**
 * A navigation to draw a skeleton for at this level, or null.
 *
 * ⚠ ONE LEVEL DRAWS IT, NEVER TWO. The page frame takes navigations between
 * sections; a section's body takes those inside it, so its header holds still.
 *
 * ⚠ THE LEVEL COMES FROM WHERE THE CLICK WAS MADE, NOT FROM `usePathname`. The
 * skeleton outlives Next's commit (the hold in lib/pending-navigation.ts), and
 * from then on the pathname IS the destination: judged against it, a skeleton
 * the frame drew would pass to the section halfway through.
 */
export function usePendingSkeleton(
  level: "frame" | "section",
): PendingNavigation | null {
  const pending = usePendingNavigation()
  if (!pending || pending.warm || !matchSkeleton(pending.pathname)) return null
  const sameSection = frameKey(pending.pathname) === frameKey(pending.from)
  if (level === "frame") return sameSection ? null : pending
  return sameSection ? pending : null
}

/** The body of a section in `SHARED_HEADER`, arriving per page under its header. */
export function SectionContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const pending = usePendingSkeleton("section")
  return (
    <PageTransition pathname={pending?.pathname ?? pathname}>
      {pending ? <SkeletonFor pending={pending} framed={false} /> : children}
    </PageTransition>
  )
}
