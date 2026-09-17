import type { Metadata } from "next"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { LogsTable } from "@/components/logs-table"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import type { Page as ApiPage, RequestRow } from "@/lib/types"

export const metadata: Metadata = { title: "Logs" }

/**
 * Every API request this workspace has made.
 *
 * ⚠ THE ENVELOPE ONLY — NEVER THE BODY. A request body on this API contains the
 * customer's mail: subject lines, recipients, and the HTML of whatever they
 * sent. Logging it would turn an operational log into a copy of every email the
 * platform has carried, retained under a policy nobody wrote and readable by
 * anyone who can read logs. Method, path, status, duration and the key that was
 * used answer every question this page exists to answer.
 *
 * ⚠ AND THE PATH IS THE ROUTE PATTERN, NOT THE URL. `/emails/{id}`, never a
 * concrete message id — otherwise this page becomes a list of message ids and a
 * filter on it becomes a way to enumerate them.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>
}) {
  const params = await searchParams
  const status =
    params.status === "error" || params.status === "ok" ? params.status : undefined

  const result = await tryApi<ApiPage<RequestRow>>("/console/requests", {
    query: { status, cursor: params.cursor, limit: 50 },
  })

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Logs</PageTitle>
        </PageHeaderRow>
        <PageDescription>
          Requests your servers have made to the API, with what we answered. Bodies are
          never recorded — they contain your customers&rsquo; mail.
        </PageDescription>
      </PageHeader>

      <PageBody width="full">
        {!result.ok ? (
          <PanelError
            title="Could not load the request log"
            message={result.error.message}
          />
        ) : (
          <LogsTable
            rows={result.data.data}
            nextCursor={result.data.nextCursor}
            status={status}
          />
        )}
      </PageBody>
    </Page>
  )
}
