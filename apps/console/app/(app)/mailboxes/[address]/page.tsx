import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { MailboxDetailView } from "@/components/mailbox-detail"
import { tryApi } from "@/lib/api"
import type { MailboxAliasList } from "@/lib/mailbox-aliases"
import { transferSnapshot, type MailboxJob } from "@/lib/mailbox-transfer"
import type { ConsoleMailbox, StoragePool } from "@/lib/mailbox-view"
import { mailboxDetailShape, type MailboxDetailData } from "@/lib/shapes/mailbox-detail"
import type { DomainSummary, Me } from "@/lib/types"

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
const NO_DOMAINS: string[] = []

/**
 * ⚠ THE LIST PAGE'S RULE, so an alias is offered on the same domains a mailbox is:
 * hosting on, and this workspace the one that proved it (`owned`). One that
 * another workspace proved since would be refused at the address.
 */
function hostedDomains(domains: readonly DomainSummary[]): string[] {
  return domains
    .filter((d) => d.mailboxes?.enabled && d.mailboxes.owned)
    .map((d) => d.name)
}

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
 *
 * ⚠ THE HOSTED DOMAINS ARE FOR ADMINS TOO, and only for the Add alias dialog. A
 * failed read hides the domains, so the dialog's button is disabled with the
 * reason, not the page.
 */
export default async function MailboxPage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address: segment } = await params
  const address = addressFrom(segment)

  const [result, me, list, aliases, domains, exported, imported] = await Promise.all([
    tryApi<ConsoleMailbox>(`/console/mailboxes/${encodeURIComponent(address)}`),
    tryApi<Me>("/console/me"),
    // Asked of everyone because the role is not known yet; a member's answer is
    // their own mailbox alone, and is not used.
    tryApi<{ data: ConsoleMailbox[]; pool: StoragePool }>("/console/mailboxes", {
      query: { limit: 200 },
    }),
    // ⚠ THE API ANSWERS A MEMBER FOR THEIR OWN MAILBOX ONLY, so this is safe to ask
    // of everyone. A failure hides the list, not the page: the section says so.
    tryApi<MailboxAliasList>(
      `/console/mailboxes/${encodeURIComponent(address)}/aliases`,
    ),
    // Asked of everyone for the same reason as the list above; only an admin's is used.
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    // ⚠ THE LATEST EXPORT AND IMPORT, so a run in progress, a finished export's
    // download and an import started before the person left are all there when
    // the page opens. The API answers the mailbox's owner, the workspace's owner
    // and admins; for anyone else the section hides (see `transferSnapshot`).
    tryApi<MailboxJob>(`/mailboxes/${encodeURIComponent(address)}/export`),
    tryApi<MailboxJob>(`/mailboxes/${encodeURIComponent(address)}/import`),
  ])

  if (!result.ok) {
    if (result.error.statusCode === 404) notFound()
    throw new Error(result.error.message)
  }

  // The list page's own rule: `members:manage`, which owners and admins hold.
  const isAdmin =
    me.ok && me.data.access?.permissions.includes("members:manage") === true

  const data: MailboxDetailData = {
    mailbox: result.data,
    others:
      isAdmin && list.ok
        ? list.data.data.filter((m) => m.address !== result.data.address)
        : NO_MAILBOXES,
    pool: isAdmin && list.ok ? list.data.pool : null,
    aliases: aliases.ok ? aliases.data : null,
    domains: isAdmin && domains.ok ? hostedDomains(domains.data.data) : NO_DOMAINS,
    transfer: transferSnapshot(exported, imported),
    isAdmin,
    renderedAt: new Date().toISOString(),
  }

  return <MailboxDetailView shape={mailboxDetailShape.of(data)} data={data} />
}
