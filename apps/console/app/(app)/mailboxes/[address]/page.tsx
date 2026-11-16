import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { MailboxDetail } from "@/components/mailbox-detail"
import { tryApi } from "@/lib/api"
import type { ConsoleMailbox, StoragePool } from "@/lib/mailbox-view"
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
 * One mailbox.
 *
 * ⚠ THE API DECIDES WHO MAY SEE IT: an owner or admin gets any mailbox of the
 * workspace, a member only their own, and anyone else's is a 404 that reveals
 * nothing (apps/api/src/routes/console/mailboxes.ts). This page only turns that
 * 404 into the console's.
 *
 * ⚠ THE WORKSPACE'S OTHER MAILBOXES AND THE POOL ARE READ FOR ADMINS ONLY, and
 * only to answer two questions a dialog asks: where a deleted mailbox can forward
 * to, and how much storage there is to give. A failure hides those answers, not
 * the page: the delete dialog then offers no forwarding and the storage dialog
 * checks only that the number is a number, and the API says no in words.
 */
export default async function MailboxPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address: segment } = await params
  const address = addressFrom(segment)

  const [result, me, list] = await Promise.all([
    tryApi<ConsoleMailbox>(`/console/mailboxes/${encodeURIComponent(address)}`),
    tryApi<Me>("/console/me"),
    // Asked of everyone because the role is not known yet; a member's answer is
    // their own mailbox alone, and is not used.
    tryApi<{ data: ConsoleMailbox[]; pool: StoragePool }>("/console/mailboxes", {
      query: { limit: 200 },
    }),
  ])

  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

  // The list page's own rule: `members:manage`, which owners and admins hold.
  const isAdmin =
    me.ok && me.data.access?.permissions.includes("members:manage") === true

  return (
    <MailboxDetail
      mailbox={result.data}
      others={
        isAdmin && list.ok
          ? list.data.data.filter((m) => m.address !== result.data.address)
          : NO_MAILBOXES
      }
      pool={isAdmin && list.ok ? list.data.pool : null}
      isAdmin={isAdmin}
      renderedAt={new Date().toISOString()}
    />
  )
}
