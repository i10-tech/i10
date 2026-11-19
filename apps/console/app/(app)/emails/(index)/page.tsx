import type { Metadata } from "next"
import { EmailsView } from "@/components/emails-view"
import { tryApi } from "@/lib/api"
import { rangeStart } from "@/lib/range"
import { emailsShape, type EmailsData } from "@/lib/shapes/emails"
import type { ApiKeyRow, DomainSummary, EmailRow, Page as ApiPage } from "@/lib/types"

export const metadata: Metadata = { title: "Emails" }

/**
 * ⚠ ONE CONSTANT, BECAUSE THE COPY BELOW QUOTES IT. "None of the last 50
 * messages match" is only true while the request asks for 50, and a number
 * written twice is a number that will disagree with itself.
 */
const PAGE_SIZE = 50

/**
 * The delivery log.
 *
 * ⚠ THE FILTERS LIVE IN THE URL AND THE PAGE IS A SERVER COMPONENT, which is
 * what makes this fast on a large account. The alternative - fetching in the
 * browser - puts a spinner over the one screen people keep open all day, and
 * turns every filter change into a round trip with nothing on screen. In the
 * URL the state is also shareable: "here is the bounce" is a link.
 *
 * ⚠ AND PAGINATION IS A CURSOR, NOT A PAGE NUMBER. `core.messages` is
 * partitioned and an OFFSET of forty thousand makes Postgres produce and
 * discard forty thousand rows on every request. A cursor is also the only
 * CORRECT form while rows are arriving: offset pagination on a descending log
 * shows one row twice and skips another every time something is inserted
 * between two page loads, which on a live send log is constantly.
 */
export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string
    domain_id?: string
    broadcast_id?: string
    search?: string
    days?: string
    api_key_id?: string
    cursor?: string
  }>
}) {
  const params = await searchParams

  // ⚠ THE FILTERS' CHOICES FAIL QUIETLY: without them the menus are shorter,
  // and the log itself still loads.
  const [result, domains, keys] = await Promise.all([
    tryApi<ApiPage<EmailRow>>("/console/emails", {
      query: {
        status: params.status,
        domain_id: params.domain_id,
        // ⚠ FORWARDED, WHICH IT WAS NOT. The broadcast page links here with this
        // filter to answer "what did this broadcast actually send"; dropping it
        // silently showed the whole account's log instead, which looks like the
        // link working.
        broadcast_id: params.broadcast_id,
        search: params.search,
        from: rangeStart(params.days),
        api_key_id: params.api_key_id,
        cursor: params.cursor,
        limit: PAGE_SIZE,
      },
    }),
    tryApi<{ data: DomainSummary[] }>("/console/domains"),
    tryApi<{ data: ApiKeyRow[] }>("/console/api-keys"),
  ])

  /*
   * ⚠ AN EMPTY PAGE WITH A CURSOR IS A REAL STATE, AND IT USED TO BE A DEAD END.
   * The status filter is applied in TypeScript after the page is fetched - see
   * `listEmails`, where the reason is written up - so filtering by a rare status
   * routinely returns a page of fifty rows with none of them matching, while the
   * next page does. Rendering the terminal empty state there tells somebody
   * "nothing matches those filters" about a message that exists forty rows
   * further down, and gives them no way to keep looking. The cursor is what says
   * whether the list is finished; the row count never was.
   */
  /*
   * ⚠ AN EMPTY PAGE WITH A CURSOR IS A REAL STATE, AND IT USED TO BE A DEAD END.
   * The status filter is applied in TypeScript after the page is fetched - see
   * `listEmails`, where the reason is written up - so filtering by a rare status
   * routinely returns a page of fifty rows with none of them matching, while the
   * next page does. Rendering the terminal empty state there tells somebody
   * "nothing matches those filters" about a message that exists forty rows
   * further down, and gives them no way to keep looking. The cursor is what says
   * whether the list is finished; the row count never was.
   */
  const data: EmailsData = {
    rows: result.ok ? result.data.data : [],
    nextCursor: result.ok ? result.data.nextCursor : null,
    domains: domains.ok ? domains.data.data : [],
    apiKeys: keys.ok ? keys.data.data : [],
    ...(result.ok ? {} : { error: result.error.message }),
  }

  return <EmailsView shape={emailsShape.of(data)} data={data} />
}
