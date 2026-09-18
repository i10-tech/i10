import type { Metadata } from "next"
import Link from "next/link"
import {
  Page,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/ui/components/table"
import { EmailFilters } from "@/components/email-filters"
import { LoadMore } from "@/components/load-more"
import { PanelError } from "@/components/panel-error"
import { EmptyState } from "@/components/empty-state"
import { tryApi } from "@/lib/api"
import { bareAddress, firstLine, formatRelative } from "@/lib/format"
import type { EmailRow, Page as ApiPage } from "@/lib/types"

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
 * what makes this fast on a large account. The alternative — fetching in the
 * browser — puts a spinner over the one screen people keep open all day, and
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
    cursor?: string
  }>
}) {
  const params = await searchParams

  const result = await tryApi<ApiPage<EmailRow>>("/console/emails", {
    query: {
      status: params.status,
      domain_id: params.domain_id,
      // ⚠ FORWARDED, WHICH IT WAS NOT. The broadcast page links here with this
      // filter to answer "what did this broadcast actually send"; dropping it
      // silently showed the whole account's log instead, which looks like the
      // link working.
      broadcast_id: params.broadcast_id,
      search: params.search,
      cursor: params.cursor,
      limit: PAGE_SIZE,
    },
  })

  /*
   * ⚠ AN EMPTY PAGE WITH A CURSOR IS A REAL STATE, AND IT USED TO BE A DEAD END.
   * The status filter is applied in TypeScript after the page is fetched — see
   * `listEmails`, where the reason is written up — so filtering by a rare status
   * routinely returns a page of fifty rows with none of them matching, while the
   * next page does. Rendering the terminal empty state there tells somebody
   * "nothing matches those filters" about a message that exists forty rows
   * further down, and gives them no way to keep looking. The cursor is what says
   * whether the list is finished; the row count never was.
   */
  const rows = result.ok ? result.data.data : []
  const nextCursor = result.ok ? result.data.nextCursor : null
  const filtered = Boolean(params.search || params.status || params.broadcast_id)

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Emails</PageTitle>
        </PageHeaderRow>
        <PageDescription>
          Every message this workspace has sent, with what happened to it.
        </PageDescription>
      </PageHeader>

      <PageBody width="full" className="space-y-4">
        <EmailFilters />

        {!result.ok ? (
          <PanelError title="Could not load the log" message={result.error.message} />
        ) : rows.length === 0 && nextCursor ? (
          /*
           * ⚠ NOT AN `EmptyState`, BECAUSE THE LIST IS NOT EMPTY — this page of
           * it is. The distinction is the difference between "you have no
           * bounces" and "no bounces in the last fifty messages", and only one
           * of those is true here.
           */
          <div className="space-y-4 rounded-lg border px-4 py-8 text-center">
            <div>
              <p className="text-sm font-medium">Nothing on this page</p>
              <p className="mt-1 text-sm text-muted-foreground">
                None of the last {PAGE_SIZE} messages match. There is more log below.
              </p>
            </div>
            <LoadMore cursor={nextCursor} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtered ? "Nothing matches those filters" : "No mail yet"}
            description={
              filtered
                ? "Try a wider date range, or clear the filters."
                : "Send your first email and it will appear here within a second of the API accepting it."
            }
            action={
              filtered
                ? { label: "Clear filters", href: "/emails" }
                : { label: "Set up sending", href: "/onboarding" }
            }
          />
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[9rem]">Status</TableHead>
                    <TableHead className="w-[16rem]">To</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead className="hidden w-[16rem] lg:table-cell">
                      From
                    </TableHead>
                    <TableHead className="w-[9rem] text-right">Sent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((email) => (
                    <TableRow key={email.id} className="group">
                      {/*
                       * ⚠ THE LINK IS INSIDE EVERY CELL RATHER THAN WRAPPING
                       * THE ROW, BECAUSE A <tr> CANNOT CONTAIN AN <a>. Making
                       * the row clickable with an onClick handler would mean a
                       * client component for the whole table, no middle-click
                       * to open in a tab, and nothing for a keyboard. Repeating
                       * the anchor is more markup and the only correct answer.
                       */}
                      <TableCell className="p-0">
                        <Link
                          href={`/emails/${email.id}`}
                          className="block px-3 py-2.5"
                        >
                          <Status status={email.last_event} />
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-0 p-0">
                        <Link
                          href={`/emails/${email.id}`}
                          className="block truncate px-3 py-2.5 font-mono text-xs"
                          title={email.to.join(", ")}
                        >
                          {email.to[0] ? bareAddress(email.to[0]) : "—"}
                          {email.to.length > 1 && (
                            <span className="text-muted-foreground">
                              {" "}
                              +{email.to.length - 1}
                            </span>
                          )}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-0 p-0">
                        {/*
                         * ⚠ THE ERROR SITS UNDER THE SUBJECT, NOT AFTER IT. Both
                         * used to share one truncating line, so a failed message
                         * read "131871 is your verification code MessageRejected:
                         * Email addr…" — the reason was cut off exactly where it
                         * started to say something, and it ran into the subject
                         * as though it were part of it. Two lines let each
                         * truncate on its own, which is the only way both can be
                         * readable in a fixed column.
                         *
                         * ⚠ AND THE `title` CARRIES BOTH, so the full reason is
                         * one hover away without opening the message.
                         */}
                        <Link
                          href={`/emails/${email.id}`}
                          className="block px-3 py-2.5"
                          title={
                            email.last_error
                              ? `${email.subject}\n\n${email.last_error}`
                              : email.subject
                          }
                        >
                          <span className="block truncate text-sm">
                            {email.subject || (
                              <em className="text-muted-foreground">No subject</em>
                            )}
                          </span>
                          {email.last_error && (
                            <span className="mt-0.5 block truncate text-xs text-danger">
                              {firstLine(email.last_error, 120)}
                            </span>
                          )}
                        </Link>
                      </TableCell>
                      <TableCell className="hidden max-w-0 p-0 lg:table-cell">
                        <Link
                          href={`/emails/${email.id}`}
                          className="block truncate px-3 py-2.5 font-mono text-xs text-muted-foreground"
                          title={email.from}
                        >
                          {bareAddress(email.from)}
                        </Link>
                      </TableCell>
                      <TableCell className="p-0 text-right">
                        <Link
                          href={`/emails/${email.id}`}
                          className="block px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground"
                          title={email.created_at}
                        >
                          {formatRelative(email.created_at)}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <LoadMore cursor={nextCursor} />
          </>
        )}
      </PageBody>
    </Page>
  )
}
