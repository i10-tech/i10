import type { Metadata } from "next"
import { TeamInboxesView } from "@/components/team-inboxes-view"
import { tryApi } from "@/lib/api"
import type { ConsoleMailbox } from "@/lib/mailbox-view"
import { PREVIEW } from "@/lib/preview"
import { candidatesFrom, hostedDomainNames, type TeamInbox } from "@/lib/team-inbox"
import { teamInboxesShape, type TeamInboxesData } from "@/lib/shapes/team-inboxes"
import type { DomainSummary } from "@/lib/types"

export const metadata: Metadata = { title: "Team inboxes" }

const NO_MAILBOXES: ConsoleMailbox[] = []
const NO_DOMAINS: DomainSummary[] = []

/**
 * The team inboxes this person can see.
 *
 * ⚠ THE API DECIDES WHO SEES WHICH: an owner or admin gets every team inbox of
 * the workspace, a member only the ones they are in (see
 * apps/api/src/team-inboxes/service.ts). This page shows what it is sent and only
 * decides whether to offer Create, by the same `members:manage` rule as Mailboxes.
 *
 * ⚠ THE DOMAINS AND MAILBOXES ARE READ FOR THE CREATE DIALOG ONLY, and asked of
 * everyone because the role is not known until `/console/me` answers. A member's
 * mailbox list is their own mailbox alone and is never used. A failure hides what
 * the dialog could offer, not the page: with no domain it sends the admin to
 * Domains, and with no mailboxes the picker says members need one.
 *
 * ⚠ `?empty=1` IS PREVIEW ONLY, to see the empty workspace. `PREVIEW` folds to
 * `false` in a production build and the branch goes with it.
 */
export default async function TeamInboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ empty?: string }>
}) {
  const params = await searchParams
  const [me, result, domains, mailboxes] = await Promise.all([
    tryApi<{ access?: { permissions?: string[] } | null }>("/console/me"),
    tryApi<{ data: TeamInbox[] }>("/console/team-inboxes", {
      ...(PREVIEW && params.empty ? { query: { empty: params.empty } } : {}),
    }),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<{ data: ConsoleMailbox[] }>("/console/mailboxes", { query: { limit: 200 } }),
  ])
  const isAdmin = me.ok
    ? (me.data.access?.permissions ?? []).includes("members:manage")
    : false

  const create = {
    domains: hostedDomainNames(domains.ok ? domains.data.data : NO_DOMAINS),
    candidates: candidatesFrom(mailboxes.ok ? mailboxes.data.data : NO_MAILBOXES),
  }

  const data: TeamInboxesData = {
    inboxes: result.ok ? result.data.data : [],
    isAdmin,
    create,
    ...(result.ok ? {} : { error: result.error.message }),
  }

  return <TeamInboxesView shape={teamInboxesShape.of(data)} data={data} />
}
