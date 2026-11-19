"use client"

import Link from "next/link"
import { Users } from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
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
import { CreateTeamInbox } from "@/components/create-team-inbox-dialog"
import { EmptyState } from "@/components/empty-state"
import {
  RememberShape,
  seedShape,
  useRememberedShape,
} from "@/components/list/remembered-shapes"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  ListTile,
} from "@/components/list/table"
import { PanelError } from "@/components/panel-error"
import { Time } from "@/components/time"
import { PAGE_COPY } from "@/lib/page-copy"
import { NONE } from "@/lib/react"
import {
  seedTeamInboxShape,
  teamInboxDetailShape,
} from "@/lib/shapes/team-inbox-detail"
import {
  teamInboxesShape,
  type TeamInboxesData,
  type TeamInboxesShape,
} from "@/lib/shapes/team-inboxes"
import {
  inboxName,
  memberCount,
  type Candidate,
  type TeamInbox,
} from "@/lib/team-inbox"

/** What the Create team inbox dialog needs from the page. */
export interface CreateTeamInboxProps {
  domains: string[]
  candidates: readonly Candidate[]
}

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function TeamInboxesLoading() {
  return <TeamInboxesView shape={useRememberedShape(teamInboxesShape)} />
}

const NAME_WIDTHS = ["54%", "42%", "62%", "48%"]

/** The Create button's box: it carries the dialog, so a skeleton draws its bar. */
const CREATE_BOX = {
  shape: "box",
  width: 148,
  height: 32,
  radius: 8,
  inline: true,
} as const

/**
 * The team inboxes a person can see, loaded and loading: ONE view, so the
 * skeleton cannot drift from the page (docs/decisions/skeletons.md).
 *
 * ⚠ THE API DECIDES WHO SEES WHICH: an owner or admin gets every team inbox of
 * the workspace, a member only the ones they are in, read-only. This view shows
 * what it is sent and offers Create only to an admin.
 *
 * ⚠ THE CREATE BUTTON LIVES IN THE EMPTY STATE WHILE THE LIST IS EMPTY AND IN THE
 * HEADER ONCE IT IS NOT, as on Mailboxes. With no domain hosting mailboxes the
 * action is the one that unblocks it, so the empty state links to Domains instead.
 */
export function TeamInboxesView({
  shape,
  data,
}: {
  shape: TeamInboxesShape
  data?: TeamInboxesData
}) {
  const loading = data === undefined
  const inboxes = data?.inboxes ?? NONE
  const hasRows = shape.rows > 0
  // Rows to draw: the data's, or as many placeholders as the shape remembers.
  const rows: readonly (TeamInbox | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : inboxes

  return (
    <BoneScope id="team-inboxes" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.teamInboxes.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.teamInboxes.title}</PageTitle>
            )}
            {/* Hidden while the list is empty: the empty state carries the action. */}
            {shape.admin && hasRows && (
              <PageActions>
                <Bone id="create" {...CREATE_BOX}>
                  {data && <CreateTeamInbox {...data.create} />}
                </Bone>
              </PageActions>
            )}
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.teamInboxes.description}</PageDescription>
        </PageHeader>
        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load team inboxes" message={data.error} />
          ) : !hasRows ? (
            !shape.admin ? (
              <EmptyState
                icon={<Users />}
                title="You are not in a team inbox"
                description="A team inbox is a shared address that several people read. An owner or admin adds you to the ones you should see."
              />
            ) : (
              <EmptyState
                icon={<Users />}
                title="No team inboxes yet"
                description={
                  shape.hosted
                    ? "A team inbox is a shared address, like support@, that several people read and reply from in their own mail apps. Create the first one and choose who is in it."
                    : "A team inbox is a shared address, like support@, that several people read and reply from in their own mail apps. Turn on mailbox hosting on a domain to create one."
                }
                {...(shape.hosted
                  ? {}
                  : { action: { label: "Go to domains", href: "/domains" } })}
                secondary={
                  shape.hosted ? (
                    <Bone id="create" {...CREATE_BOX}>
                      {data && <CreateTeamInbox {...data.create} />}
                    </Bone>
                  ) : undefined
                }
              />
            )
          ) : (
            <ListTable>
              <ListHeader>
                <ListHead>Team inbox</ListHead>
                <ListHead className="w-[10rem]">Members</ListHead>
                <ListHead className="w-[10rem] text-right">Created</ListHead>
              </ListHeader>
              <ListBody>
                {rows.map((inbox, i) => {
                  const name = inbox ? inboxName(inbox) : undefined
                  const seed = () =>
                    inbox &&
                    seedShape(
                      teamInboxDetailShape,
                      inbox.address,
                      seedTeamInboxShape(inbox, shape.admin),
                    )
                  return (
                    <BoneScope key={inbox?.address ?? i} id={`row-${i}`} unit>
                      <ListRow>
                        <ListCell>
                          <div className="flex items-center gap-3">
                            <ListTile>
                              <Users className="size-4" />
                            </ListTile>
                            <div className="min-w-0 flex-1">
                              <Bone
                                id="name"
                                as="div"
                                width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                              >
                                {inbox && (
                                  <Link
                                    href={`/team-inboxes/${encodeURIComponent(inbox.address)}`}
                                    className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                                    onMouseEnter={seed}
                                    onClick={seed}
                                  >
                                    {name}
                                  </Link>
                                )}
                              </Bone>
                              {/* ⚠ THE ADDRESS UNDER A NAME THAT IS NOT IT: the line is empty when the name is the address. */}
                              <p className="truncate text-xs text-muted-foreground">
                                <Bone id="address" lineHeight={16} width="68%">
                                  {inbox && name !== inbox.address
                                    ? inbox.address
                                    : undefined}
                                </Bone>
                              </p>
                            </div>
                          </div>
                        </ListCell>
                        <ListCell className="text-sm text-muted-foreground">
                          <Bone id="members" width={80}>
                            {inbox && memberCount(inbox.members.length)}
                          </Bone>
                        </ListCell>
                        <ListCell className="text-right text-sm text-muted-foreground">
                          <Bone id="created" width={72} align="end">
                            {inbox && <Time iso={inbox.created_at} />}
                          </Bone>
                        </ListCell>
                      </ListRow>
                    </BoneScope>
                  )
                })}
              </ListBody>
            </ListTable>
          )}
        </PageBody>
        {data && data.error === undefined && (
          <RememberShape def={teamInboxesShape} shape={shape} />
        )}
      </Page>
    </BoneScope>
  )
}
