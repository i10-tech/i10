"use client"

import type * as React from "react"
import HomeLoading from "@/app/(app)/(home)/loading"
import AccountLoading from "@/app/(app)/account/loading"
import ApiKeysLoading from "@/app/(app)/api-keys/loading"
import BroadcastsLoading from "@/app/(app)/broadcasts/(index)/loading"
import BroadcastsRecordLoading from "@/app/(app)/broadcasts/[id]/loading"
import ContactsLoading from "@/app/(app)/contacts/loading"
import DomainsLoading from "@/app/(app)/domains/(index)/loading"
import DomainsRecordLoading from "@/app/(app)/domains/[id]/loading"
import DomainsNewLoading from "@/app/(app)/domains/new/loading"
import EmailsLoading from "@/app/(app)/emails/(index)/loading"
import EmailsRecordLoading from "@/app/(app)/emails/[id]/loading"
import LogsLoading from "@/app/(app)/logs/loading"
import MailboxesLoading from "@/app/(app)/mailboxes/(index)/loading"
import MailboxesRecordLoading from "@/app/(app)/mailboxes/[address]/loading"
import SegmentsLoading from "@/app/(app)/segments/loading"
import SettingsLoading from "@/app/(app)/settings/(index)/loading"
import SettingsBillingLoading from "@/app/(app)/settings/billing/loading"
import SettingsSecurityLoading from "@/app/(app)/settings/security/(index)/loading"
import SettingsSecurityRecordLoading from "@/app/(app)/settings/security/[id]/loading"
import SettingsSecurityAuditLoading from "@/app/(app)/settings/security/audit/loading"
import SettingsSsoLoading from "@/app/(app)/settings/sso/(index)/loading"
import SettingsSsoRecordLoading from "@/app/(app)/settings/sso/[id]/loading"
import SettingsSsoConnectLoading from "@/app/(app)/settings/sso/connect/loading"
import SettingsTeamLoading from "@/app/(app)/settings/team/loading"
import SettingsUnsubscribePageLoading from "@/app/(app)/settings/unsubscribe-page/loading"
import SettingsUsageLoading from "@/app/(app)/settings/usage/loading"
import SuppressionsLoading from "@/app/(app)/suppressions/loading"
import TeamInboxesLoading from "@/app/(app)/team-inboxes/(index)/loading"
import TeamInboxesRecordLoading from "@/app/(app)/team-inboxes/[address]/loading"
import TemplatesLoading from "@/app/(app)/templates/(index)/loading"
import TemplatesRecordLoading from "@/app/(app)/templates/[id]/loading"
import TemplatesFolderRecordLoading from "@/app/(app)/templates/folder/[id]/loading"
import TemplatesGithubSetupLoading from "@/app/(app)/templates/github/setup/loading"
import TopicsLoading from "@/app/(app)/topics/loading"
import WebhooksLoading from "@/app/(app)/webhooks/(index)/loading"
import WebhooksRecordLoading from "@/app/(app)/webhooks/[id]/loading"
import WebhooksDeliveriesRecordLoading from "@/app/(app)/webhooks/deliveries/[id]/loading"

/**
 * Every console page's own skeleton, by route: what PageFrame draws the moment
 * a page is clicked, before Next has anything from the server
 * (lib/pending-navigation.ts).
 *
 * ⚠ THE SAME loading.tsx A PAGE SHOWS ON ITS OWN, IMPORTED, NEVER A COPY. Each
 * one is that page's view drawn from its shape, so the skeleton at the click and
 * the one Next streams are one component. test/skeleton-coverage.test.ts fails
 * when a page's loading.tsx is missing here.
 */
const ROUTES: { route: string; Loading: React.ComponentType }[] = [
  { route: "/", Loading: HomeLoading },
  { route: "/account", Loading: AccountLoading },
  { route: "/api-keys", Loading: ApiKeysLoading },
  { route: "/broadcasts", Loading: BroadcastsLoading },
  { route: "/broadcasts/[id]", Loading: BroadcastsRecordLoading },
  { route: "/contacts", Loading: ContactsLoading },
  { route: "/domains", Loading: DomainsLoading },
  { route: "/domains/[id]", Loading: DomainsRecordLoading },
  { route: "/domains/new", Loading: DomainsNewLoading },
  { route: "/emails", Loading: EmailsLoading },
  { route: "/emails/[id]", Loading: EmailsRecordLoading },
  { route: "/logs", Loading: LogsLoading },
  { route: "/mailboxes", Loading: MailboxesLoading },
  { route: "/mailboxes/[address]", Loading: MailboxesRecordLoading },
  { route: "/segments", Loading: SegmentsLoading },
  { route: "/settings", Loading: SettingsLoading },
  { route: "/settings/billing", Loading: SettingsBillingLoading },
  { route: "/settings/security", Loading: SettingsSecurityLoading },
  { route: "/settings/security/[id]", Loading: SettingsSecurityRecordLoading },
  { route: "/settings/security/audit", Loading: SettingsSecurityAuditLoading },
  { route: "/settings/sso", Loading: SettingsSsoLoading },
  { route: "/settings/sso/[id]", Loading: SettingsSsoRecordLoading },
  { route: "/settings/sso/connect", Loading: SettingsSsoConnectLoading },
  { route: "/settings/team", Loading: SettingsTeamLoading },
  { route: "/settings/unsubscribe-page", Loading: SettingsUnsubscribePageLoading },
  { route: "/settings/usage", Loading: SettingsUsageLoading },
  { route: "/suppressions", Loading: SuppressionsLoading },
  { route: "/team-inboxes", Loading: TeamInboxesLoading },
  { route: "/team-inboxes/[address]", Loading: TeamInboxesRecordLoading },
  { route: "/templates", Loading: TemplatesLoading },
  { route: "/templates/[id]", Loading: TemplatesRecordLoading },
  { route: "/templates/folder/[id]", Loading: TemplatesFolderRecordLoading },
  { route: "/templates/github/setup", Loading: TemplatesGithubSetupLoading },
  { route: "/topics", Loading: TopicsLoading },
  { route: "/webhooks", Loading: WebhooksLoading },
  { route: "/webhooks/[id]", Loading: WebhooksRecordLoading },
  { route: "/webhooks/deliveries/[id]", Loading: WebhooksDeliveriesRecordLoading },
]

interface Compiled {
  pattern: RegExp
  names: string[]
  statics: number
  Loading: React.ComponentType
}

/*
 * ⚠ A STATIC SEGMENT BEATS A PARAMETER, AS IN NEXT. `/domains/new` must not be
 * read as the domain whose id is "new", so routes with more literal segments
 * are tried first.
 */
const COMPILED: Compiled[] = ROUTES.map(({ route, Loading }) => {
  const names: string[] = []
  const segments = route.split("/").filter(Boolean)
  const source = segments
    .map((segment) => {
      const param = /^\[(\w+)\]$/.exec(segment)
      if (!param) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      names.push(param[1]!)
      return "([^/]+)"
    })
    .join("/")
  return {
    pattern: new RegExp(`^/${source}/?$`),
    names,
    statics: segments.length - names.length,
    Loading,
  }
}).sort((a, b) => b.statics - a.statics)

export interface SkeletonMatch {
  Loading: React.ComponentType
  params: Record<string, string>
}

/** The skeleton for a pathname, with its route params; null for a page without one. */
export function matchSkeleton(pathname: string): SkeletonMatch | null {
  for (const route of COMPILED) {
    const found = route.pattern.exec(pathname)
    if (!found) continue
    const params = Object.fromEntries(
      route.names.map((name, i) => [name, decodeURIComponent(found[i + 1]!)]),
    )
    return { Loading: route.Loading, params }
  }
  return null
}
