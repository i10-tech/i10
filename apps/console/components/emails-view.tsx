"use client"

import * as React from "react"
import { NONE } from "@/lib/react"
import { useRouteSearchParams } from "@/lib/target-route"
import { Mail, SearchX } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { EmailFilters } from "@/components/email-filters"
import { EmptyState } from "@/components/empty-state"
import { ApiButton } from "@/components/list/api-button"
import {
  RememberShape,
  seedShape,
  useRememberedShape,
} from "@/components/list/remembered-shapes"
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
import { Status } from "@/components/status"
import { bareAddress, firstLine } from "@/lib/format"
import { PAGE_COPY } from "@/lib/page-copy"
import { emailShape, emailShapeFromRow } from "@/lib/shapes/email"
import { emailsShape, type EmailsData, type EmailsShape } from "@/lib/shapes/emails"
import { SNIPPETS } from "@/lib/snippets"
import type { EmailRow } from "@/lib/types"
import { Time } from "@/components/time"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function EmailsLoading() {
  return <EmailsView shape={useRememberedShape(emailsShape)} />
}

/**
 * ⚠ ONE CONSTANT, BECAUSE THE COPY BELOW QUOTES IT. "None of the last 50
 * messages match" is only true while the request asks for 50, and a number
 * written twice is a number that will disagree with itself.
 */
const PAGE_SIZE = 50
const SUBJECT_WIDTHS = ["60%", "45%", "75%", "50%", "65%"]

/**
 * The delivery log, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
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
export function EmailsView({ shape, data }: { shape: EmailsShape; data?: EmailsData }) {
  const loading = data === undefined
  const searchParams = useRouteSearchParams()
  const filtered = Boolean(
    searchParams.get("search") ||
    searchParams.get("status") ||
    searchParams.get("broadcast_id") ||
    searchParams.get("days") ||
    searchParams.get("domain_id") ||
    searchParams.get("api_key_id"),
  )
  const cursor = searchParams.get("cursor")

  const rows: (EmailRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : (data?.rows ?? NONE)
  const hasRows = shape.rows > 0

  return (
    <BoneScope id="emails" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.emails.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.emails.title}</PageTitle>
            )}
            <PageActions>
              <ApiButton snippet={SNIPPETS.emails} />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.emails.description}</PageDescription>
        </PageHeader>

        <PageBody width="full">
          <UrlList className="space-y-4">
            <EmailFilters
              domains={(data?.domains ?? NONE).map((d) => ({
                id: d.id,
                name: d.name,
              }))}
              apiKeys={(data?.apiKeys ?? NONE).map((k) => ({
                id: k.id,
                name: k.name,
              }))}
              showDomains={shape.domainFilter}
              showKeys={shape.keyFilter}
            />

            <ListRegion>
              <BoneRegion id="list">
                {data?.error !== undefined ? (
                  <PanelError title="Could not load the log" message={data.error} />
                ) : !hasRows && shape.hasMore ? (
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
                    <LoadMore cursor={data?.nextCursor} hasMore={shape.hasMore} />
                  </div>
                ) : !hasRows ? (
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
                    {/* F = 480 (Status 144, To 208, Sent 128), Subject keeps 220: min 700. From 208 -> 908 -> lg (928). */}
                    <ListTable className="[&_table]:min-w-[700px]">
                      <ListHeader>
                        <ListHead className="w-[9rem]">Status</ListHead>
                        <ListHead className="w-[13rem]">To</ListHead>
                        <ListHead>Subject</ListHead>
                        <ListHead hideBelow="lg" className="w-[13rem]">
                          From
                        </ListHead>
                        <ListHead className="w-[8rem] text-right">Sent</ListHead>
                      </ListHeader>
                      <ListBody>
                        {rows.map((email, i) => {
                          const href = email ? `/emails/${email.id}` : undefined
                          const seed = () =>
                            email &&
                            seedShape(emailShape, email.id, emailShapeFromRow(email))
                          return (
                            <BoneScope key={email?.id ?? i} id={`row-${i}`} unit>
                              <ListRow onMouseEnter={seed} onClick={seed}>
                                {/*
                                 * ⚠ THE LINK IS INSIDE EVERY CELL RATHER THAN WRAPPING
                                 * THE ROW, BECAUSE A <tr> CANNOT CONTAIN AN <a>. Making
                                 * the row clickable with an onClick handler would mean a
                                 * client component for the whole table, no middle-click
                                 * to open in a tab, and nothing for a keyboard.
                                 */}
                                <ListCell className="p-0">
                                  <CellLink href={href} className="pl-4">
                                    <Bone
                                      id="status"
                                      shape="box"
                                      width={84}
                                      height={20}
                                      radius={9999}
                                      inline
                                    >
                                      {email && <Status status={email.last_event} />}
                                    </Bone>
                                  </CellLink>
                                </ListCell>
                                <ListCell className="p-0">
                                  <CellLink
                                    href={href}
                                    className="font-mono text-xs"
                                    title={email?.to.join(", ")}
                                  >
                                    <Bone id="to" width={140} lineHeight={16}>
                                      {email && (
                                        <span className="flex min-w-0">
                                          <span className="truncate">
                                            {email.to[0] ? bareAddress(email.to[0]) : "-"}
                                          </span>
                                          {email.to.length > 1 && (
                                            <span className="shrink-0 pl-1 text-muted-foreground">
                                              +{email.to.length - 1}
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </Bone>
                                  </CellLink>
                                </ListCell>
                                <ListCell className="p-0">
                                  {/*
                                   * ⚠ THE ERROR SITS UNDER THE SUBJECT, NOT AFTER IT, so
                                   * each truncates on its own, and the `title` carries
                                   * both - the full reason is one hover away. IT IS INSIDE
                                   * THE BONE: whether a row has one is data, and a skeleton
                                   * cannot know.
                                   */}
                                  <CellLink
                                    href={href}
                                    title={
                                      email?.last_error
                                        ? `${email.subject}\n\n${email.last_error}`
                                        : email?.subject
                                    }
                                  >
                                    <Bone
                                      id="subject"
                                      width={SUBJECT_WIDTHS[i % SUBJECT_WIDTHS.length]}
                                      lineHeight={20}
                                    >
                                      {email && (
                                        <>
                                          <span className="block truncate text-sm">
                                            {email.subject || (
                                              <em className="text-muted-foreground">
                                                No subject
                                              </em>
                                            )}
                                          </span>
                                          {email.last_error && (
                                            <span className="mt-0.5 block truncate text-xs text-danger">
                                              {firstLine(email.last_error, 120)}
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </Bone>
                                  </CellLink>
                                </ListCell>
                                <ListCell hideBelow="lg" className="p-0">
                                  <CellLink
                                    href={href}
                                    className="font-mono text-xs text-muted-foreground"
                                    title={email?.from}
                                  >
                                    <Bone id="from" width={140} lineHeight={16}>
                                      {email && (
                                        <span className="block truncate">
                                          {bareAddress(email.from)}
                                        </span>
                                      )}
                                    </Bone>
                                  </CellLink>
                                </ListCell>
                                <ListCell className="p-0 text-right">
                                  <CellLink
                                    href={href}
                                    className="pr-4 text-xs whitespace-nowrap text-muted-foreground"
                                    title={email?.created_at}
                                  >
                                    <Bone
                                      id="sent"
                                      width={64}
                                      lineHeight={16}
                                      align="end"
                                    >
                                      {email && <Time iso={email.created_at} />}
                                    </Bone>
                                  </CellLink>
                                </ListCell>
                              </ListRow>
                            </BoneScope>
                          )
                        })}
                      </ListBody>
                    </ListTable>

                    <LoadMore cursor={data?.nextCursor} hasMore={shape.hasMore} />
                  </div>
                )}
              </BoneRegion>
            </ListRegion>
          </UrlList>
        </PageBody>
        {data && data.error === undefined && (
          <RememberShape
            def={emailsShape}
            shape={shape}
            skip={filtered || Boolean(cursor)}
          />
        )}
      </Page>
    </BoneScope>
  )
}
