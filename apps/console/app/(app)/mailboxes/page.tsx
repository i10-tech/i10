import type { Metadata } from "next"
import { MailboxesView } from "@/components/mailboxes-view"

export const metadata: Metadata = { title: "Mailboxes" }

/**
 * The human half of i10.
 *
 * ⚠ FIXTURE - THE PAGE IS REAL AND THE DATA IS NOT WIRED YET. `/mailboxes` on
 * the API is SESSION authenticated and already works; what it does not have is
 * a LIST that the console's tenant-scoped surface can read. The mailbox routes
 * answer for the signed-in PERSON (their own mailboxes), not for the tenant -
 * deliberately, because a mailbox belongs to whoever holds it rather than to
 * whoever pays the bill.
 *
 * Wiring this properly means deciding who may see a workspace's mailboxes at
 * all, which is a product question rather than a plumbing one. It is written up
 * in docs/decisions/console.md §7 rather than guessed at here, and the page
 * says what it is instead of rendering pretend rows.
 *
 * ⚠ AND IT IS IN THE NAVIGATION ANYWAY, because the feature exists and hiding
 * it would make a shipped capability invisible. An honest empty state beats a
 * missing menu item.
 */
export default function MailboxesPage() {
  return <MailboxesView shape={{}} data={{}} />
}
