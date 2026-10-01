import type { Metadata } from "next"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Download } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { AddSuppressionButton } from "@/components/add-suppression"
import { ApiButton } from "@/components/list/api-button"
import { SuppressionsTable } from "@/components/suppressions-table"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { SNIPPETS } from "@/lib/snippets"
import type { Page as ApiPage, SuppressionRow } from "@/lib/types"

export const metadata: Metadata = { title: "Suppressions" }

/**
 * Addresses we refuse to send to.
 *
 * ⚠ THIS LIST PROTECTS THE ACCOUNT, NOT THE RECIPIENT, AND THE DISTINCTION
 * MATTERS WHEN SOMEBODY ASKS TO REMOVE AN ENTRY. Continuing to send to an
 * address that hard-bounced is the fastest way to lose a sending reputation -
 * every attempt is counted against the account by the receiving networks. An
 * address here is not being punished; it is being skipped so the rest of the
 * mail keeps arriving.
 *
 * ⚠ AND IT IS SEPARATE FROM A CONTACT'S `unsubscribed` FLAG. Unsubscribing from
 * a newsletter must not stop a password reset, and a hard bounce on a
 * transactional message must not silently remove somebody from a marketing list
 * they can still be reached on. Two questions, two tables, both consulted at
 * send.
 */
export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; reason?: string; cursor?: string }>
}) {
  const params = await searchParams

  const result = await tryApi<ApiPage<SuppressionRow>>("/console/suppressions", {
    query: {
      search: params.search,
      reason: params.reason,
      cursor: params.cursor,
      limit: 50,
    },
  })

  return (
    <Page>
      <PageHeader>
        {/*
         * ⚠ WRAPS, UNLIKE MOST HEADERS: two actions beside the title do not fit
         * a 375px screen, and the second one went off the edge.
         */}
        <PageHeaderRow className="flex-wrap gap-y-2">
          <PageTitle>Suppressions</PageTitle>
          <PageActions>
            <ApiButton snippet={SNIPPETS.suppressions} />
            {/*
             * ⚠ A PLAIN ANCHOR, NOT A `Link`. The target is a file, and Next's
             * client router would try to render a CSV as a page.
             */}
            <Button variant="outline" size="sm" asChild>
              <a href="/suppressions/export" download>
                <Download />
                Export CSV
              </a>
            </Button>
            <AddSuppressionButton />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          Addresses that hard-bounced or complained, plus any you have added by hand. We
          skip them rather than sending and damaging your reputation. This list is yours
          alone: another workspace&apos;s bounces never land here.
        </PageDescription>
      </PageHeader>

      <PageBody>
        {!result.ok ? (
          <PanelError
            title="Could not load suppressions"
            message={result.error.message}
          />
        ) : (
          <SuppressionsTable
            rows={result.data.data}
            nextCursor={result.data.nextCursor}
          />
        )}
      </PageBody>
    </Page>
  )
}
