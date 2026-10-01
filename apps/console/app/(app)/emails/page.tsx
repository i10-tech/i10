import type { Metadata } from "next"
import { Mail, SearchX } from "lucide-react"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
} from "@repo/ui/components/page"
import { Status } from "@/components/status"
import { EmailFilters } from "@/components/email-filters"
import { ApiButton } from "@/components/list/api-button"
import {
  CellLink,
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
} from "@/components/list/table"
import { ListRegion, UrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { PanelError } from "@/components/panel-error"
import { EmptyState } from "@/components/empty-state"
import { tryApi } from "@/lib/api"
import { bareAddress, firstLine, formatRelative } from "@/lib/format"
import { rangeStart } from "@/lib/range"
import { SNIPPETS } from "@/lib/snippets"
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
  const rows = result.ok ? result.data.data : []
  const nextCursor = result.ok ? result.data.nextCursor : null
  const filtered = Boolean(
    params.search ||
    params.status ||
    params.broadcast_id ||
    params.days ||
    params.domain_id ||
    params.api_key_id,
  )

  return (
    <Page>
      <PageHeader>
        <PageHeaderRow>
          <PageTitle>Emails</PageTitle>
          <PageActions>
            <ApiButton snippet={SNIPPETS.emails} />
          </PageActions>
        </PageHeaderRow>
        <PageDescription>
          Every message this workspace has sent, with what happened to it.
        </PageDescription>
      </PageHeader>

      <PageBody width="full">
        <UrlList className="space-y-4">
          <EmailFilters
            domains={
              domains.ok
                ? domains.data.data.map((d) => ({ id: d.id, name: d.name }))
                : []
            }
            apiKeys={
              keys.ok ? keys.data.data.map((k) => ({ id: k.id, name: k.name })) : []
            }
          />

          <ListRegion>
            {!result.ok ? (
              <PanelError
                title="Could not load the log"
                message={result.error.message}
              />
            ) : rows.length === 0 && nextCursor ? (
              /*
               * ⚠ NOT AN `EmptyState`, BECAUSE THE LIST IS NOT EMPTY - this page
               * of it is. The distinction is the difference between "you have no
               * bounces" and "no bounces in the last fifty messages", and only
               * one of those is true here.
               */
              <div className="space-y-4 rounded-2xl border px-4 py-8 text-center">
                <div>
                  <p className="text-sm font-medium">Nothing on this page</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    None of the last {PAGE_SIZE} messages match. There is more log
                    below.
                  </p>
                </div>
                <LoadMore cursor={nextCursor} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={filtered ? <SearchX /> : <Mail />}
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
              <div className="space-y-4">
                <ListTable>
                  <ListHeader>
                    <ListHead className="w-[9rem]">Status</ListHead>
                    <ListHead className="w-[16rem]">To</ListHead>
                    <ListHead>Subject</ListHead>
                    <ListHead className="hidden w-[16rem] lg:table-cell">From</ListHead>
                    <ListHead className="w-[9rem] text-right">Sent</ListHead>
                  </ListHeader>
                  <ListBody>
                    {rows.map((email) => {
                      const href = `/emails/${email.id}`
                      return (
                        <ListRow key={email.id}>
                          {/*
                           * ⚠ THE LINK IS INSIDE EVERY CELL RATHER THAN WRAPPING
                           * THE ROW, BECAUSE A <tr> CANNOT CONTAIN AN <a>. Making
                           * the row clickable with an onClick handler would mean a
                           * client component for the whole table, no middle-click
                           * to open in a tab, and nothing for a keyboard.
                           */}
                          <ListCell className="p-0">
                            <CellLink href={href} className="pl-4">
                              <Status status={email.last_event} />
                            </CellLink>
                          </ListCell>
                          <ListCell className="max-w-0 p-0">
                            <CellLink
                              href={href}
                              className="truncate font-mono text-xs"
                              title={email.to.join(", ")}
                            >
                              {email.to[0] ? bareAddress(email.to[0]) : "-"}
                              {email.to.length > 1 && (
                                <span className="text-muted-foreground">
                                  {" "}
                                  +{email.to.length - 1}
                                </span>
                              )}
                            </CellLink>
                          </ListCell>
                          <ListCell className="max-w-0 p-0">
                            {/*
                             * ⚠ THE ERROR SITS UNDER THE SUBJECT, NOT AFTER IT, so
                             * each truncates on its own, and the `title` carries
                             * both - the full reason is one hover away.
                             */}
                            <CellLink
                              href={href}
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
                            </CellLink>
                          </ListCell>
                          <ListCell className="hidden max-w-0 p-0 lg:table-cell">
                            <CellLink
                              href={href}
                              className="truncate font-mono text-xs text-muted-foreground"
                              title={email.from}
                            >
                              {bareAddress(email.from)}
                            </CellLink>
                          </ListCell>
                          <ListCell className="p-0 text-right">
                            <CellLink
                              href={href}
                              className="pr-4 text-xs whitespace-nowrap text-muted-foreground"
                              title={email.created_at}
                            >
                              {formatRelative(email.created_at)}
                            </CellLink>
                          </ListCell>
                        </ListRow>
                      )
                    })}
                  </ListBody>
                </ListTable>

                <LoadMore cursor={nextCursor} />
              </div>
            )}
          </ListRegion>
        </UrlList>
      </PageBody>
    </Page>
  )
}
