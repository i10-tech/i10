import type { Metadata } from "next"
import { MailboxesView } from "@/components/mailboxes-view"
import { tryApi } from "@/lib/api"
import { addressesByOwner } from "@/lib/mailbox-create"
import type { ConsoleMailbox, StoragePool } from "@/lib/mailbox-view"
import { PREVIEW } from "@/lib/preview"
import { PREVIEW_MEMBERS } from "@/lib/preview-mailboxes"
import { mailboxesShape, type MailboxesData } from "@/lib/shapes/mailboxes"
import type { DomainSummary } from "@/lib/types"

/** What the pool reads as where the list could not be read: nothing used, nothing capped. */
const NO_POOL: StoragePool = {
  kind: "uncapped",
  total: null,
  allocated: 0,
  used: 0,
  remaining: null,
  unallocated: 0,
}

export const metadata: Metadata = { title: "Mailboxes" }

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const params = await searchParams
  const [me, result, domains, creation] = await Promise.all([
    tryApi<{
      access?: { permissions?: string[] } | null
      user: { email: string | null }
    }>("/console/me"),
    tryApi<{
      data: ConsoleMailbox[]
      pool: StoragePool
      nextCursor: string | null
    }>("/console/mailboxes", { query: { cursor: params.cursor, limit: 50 } }),
    // ⚠ A FAILURE HIDES THE DOMAINS, NOT THE PAGE: the dialog then says there is
    // none to put a mailbox on, which sends the person to Domains to look.
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    // ⚠ A FAILURE READS AS `admins`: a member is then told an admin creates it,
    // never shown a button the API would refuse.
    tryApi<{ mode: "admins" | "members" | "on_join" }>(
      "/console/mailboxes/creation-mode",
    ),
  ])
  const isAdmin = me.ok
    ? (me.data.access?.permissions ?? []).includes("members:manage")
    : false

  /*
   * ⚠ ONLY DOMAINS THAT HOST MAILBOXES AND THAT THIS WORKSPACE HOLDS. Hosting
   * switched on is not enough: a domain another workspace proved since (`owned`
   * false) would be refused at the address, so it is not offered.
   */
  const hosted = domains.ok
    ? domains.data.data
        .filter((d) => d.mailboxes?.enabled && d.mailboxes.owned)
        .map((d) => d.name)
    : []

  const create = {
    domains: hosted,
    // ⚠ THE FIRST PAGE'S OWNERS ONLY. Somebody whose mailbox is on a later page
    // is not greyed out here; picking them is refused by the API in words
    // ("already has a mailbox at ..."), which is the safe direction.
    held: result.ok ? Object.fromEntries(addressesByOwner(result.data.data)) : {},
    clerkEnabled: Boolean(process.env.CLERK_PUBLISHABLE_KEY),
    ...(PREVIEW ? { previewMembers: PREVIEW_MEMBERS } : {}),
  }

  const data: MailboxesData = {
    mailboxes: result.ok ? result.data.data : [],
    pool: result.ok ? result.data.pool : NO_POOL,
    nextCursor: result.ok ? result.data.nextCursor : null,
    isAdmin,
    selfServe: creation.ok && creation.data.mode !== "admins",
    create,
    ...(result.ok ? {} : { error: result.error.message }),
  }

  return <MailboxesView shape={mailboxesShape.of(data)} data={data} />
}
