import type { Metadata } from "next"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/i10/page"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import {
  MailboxesList,
  type ConsoleMailbox,
  type StoragePool,
} from "@/components/mailboxes-list"
import { PAGE_COPY } from "@/lib/page-copy"

export const metadata: Metadata = { title: "Mailboxes" }

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const params = await searchParams
  const me = await tryApi<{
    access?: { permissions?: string[] } | null
    user: { email: string | null }
  }>("/console/me")
  const isAdmin = me.ok
    ? (me.data.access?.permissions ?? []).includes("members:manage")
    : false

  const result = await tryApi<{
    data: ConsoleMailbox[]
    pool: StoragePool
    nextCursor: string | null
  }>("/console/mailboxes", { query: { cursor: params.cursor, limit: 50 } })

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>{PAGE_COPY.mailboxes.title}</PageTitle>
        </PageHeaderRow>
        <PageDescription>{PAGE_COPY.mailboxes.description}</PageDescription>
      </PageHeader>
      <PageBody>
        {!result.ok ? (
          <PanelError title="Could not load mailboxes" message={result.error.message} />
        ) : (
          <MailboxesList
            mailboxes={result.data.data}
            pool={result.data.pool}
            nextCursor={result.data.nextCursor}
            isAdmin={isAdmin}
          />
        )}
      </PageBody>
    </Page>
  )
}
