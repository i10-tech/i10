import type { Metadata } from "next"
import { Inbox } from "lucide-react"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { EmptyState } from "@/components/empty-state"

export const metadata: Metadata = { title: "Mailboxes" }

/**
 * The human half of i10.
 *
 * ⚠ FIXTURE — THE PAGE IS REAL AND THE DATA IS NOT WIRED YET. `/mailboxes` on
 * the API is SESSION authenticated and already works; what it does not have is
 * a LIST that the console's tenant-scoped surface can read. The mailbox routes
 * answer for the signed-in PERSON (their own mailboxes), not for the tenant —
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
  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Mailboxes</PageTitle>
        </PageHeaderRow>
        <PageDescription>
          Real IMAP mailboxes on your own domains — one address, one password, the same
          account you sign in with.
        </PageDescription>
      </PageHeader>

      <PageBody>
        <EmptyState
          title="Not connected to the dashboard yet"
          description="Mailbox provisioning is live on the API and authenticated per person rather than per workspace, so who may see this list is still an open question. Until it is answered, this page deliberately shows nothing rather than guessing."
          action={{ label: "Read the routing decision", href: "/domains" }}
        />

        <div className="mt-6 flex items-start gap-3 rounded-lg border px-4 py-3">
          <Inbox className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">What exists today</p>
            <p className="text-muted-foreground">
              A domain marked as hosting mailboxes accepts mail through our own MTA and
              authenticates over LDAP against your i10 account — so a mailbox holder has
              one password, not two. Creating one is an API call that takes your
              session, not an API key.
            </p>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
