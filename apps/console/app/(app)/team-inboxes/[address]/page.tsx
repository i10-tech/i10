import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { TeamInboxDetail } from "@/components/team-inbox-detail"
import { tryApi } from "@/lib/api"
import type { ConsoleMailbox } from "@/lib/mailbox-view"
import { candidatesFrom, type TeamInbox } from "@/lib/team-inbox"
import type { Me } from "@/lib/types"

/** The address as the person typed it, however the framework hands the segment over. */
function addressFrom(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>
}): Promise<Metadata> {
  const { address } = await params
  return { title: addressFrom(address) }
}

const NO_MAILBOXES: ConsoleMailbox[] = []

/**
 * One team inbox.
 *
 * ⚠ THE API DECIDES WHO MAY SEE IT: an owner or admin gets any team inbox of the
 * workspace, a member only one they are in, and anyone else's is a 404 that
 * reveals nothing (apps/api/src/routes/console/team-inboxes.ts). This page only
 * turns that 404 into the console's.
 *
 * ⚠ THE MAILBOXES ARE READ FOR THE MEMBER PICKER, which only an admin sees. They
 * are asked of everyone because the role is not known yet, and a failure hides
 * the picker's choices, not the page: the API then says no in words if somebody
 * is added by other means.
 */
export default async function TeamInboxPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address: segment } = await params
  const address = addressFrom(segment)

  const [result, me, mailboxes] = await Promise.all([
    tryApi<TeamInbox>(`/console/team-inboxes/${encodeURIComponent(address)}`),
    tryApi<Me>("/console/me"),
    tryApi<{ data: ConsoleMailbox[] }>("/console/mailboxes", { query: { limit: 200 } }),
  ])

  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

  // The list page's own rule: `members:manage`, which owners and admins hold.
  const isAdmin =
    me.ok && me.data.access?.permissions.includes("members:manage") === true

  return (
    <TeamInboxDetail
      inbox={result.data}
      candidates={candidatesFrom(
        isAdmin && mailboxes.ok ? mailboxes.data.data : NO_MAILBOXES,
      )}
      isAdmin={isAdmin}
    />
  )
}
