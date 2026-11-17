"use client"

import Link from "next/link"
import { Users } from "lucide-react"
import { CreateTeamInbox } from "@/components/create-team-inbox-dialog"
import { EmptyState } from "@/components/empty-state"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  ListTile,
} from "@/components/list/table"
import { Time } from "@/components/time"
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

/**
 * The team inboxes a person can see: all of them for an owner or admin, only
 * their own for a member, read-only. Which is which is the API's call; this list
 * shows what it sent and offers Create only to an admin.
 *
 * ⚠ THE CREATE BUTTON LIVES HERE WHILE THE LIST IS EMPTY AND IN THE PAGE HEADER
 * ONCE IT IS NOT, as on Mailboxes: two buttons for one action, far apart, read as
 * two different things. With no domain hosting mailboxes the action is the one
 * that unblocks it, so the empty state links to Domains instead.
 */
export function TeamInboxesList({
  inboxes,
  isAdmin,
  create,
}: {
  inboxes: readonly TeamInbox[]
  isAdmin: boolean
  create: CreateTeamInboxProps
}) {
  if (inboxes.length === 0) {
    if (!isAdmin) {
      return (
        <EmptyState
          icon={<Users />}
          title="You are not in a team inbox"
          description="A team inbox is a shared address that several people read. An owner or admin adds you to the ones you should see."
        />
      )
    }
    const hosted = create.domains.length > 0
    return (
      <EmptyState
        icon={<Users />}
        title="No team inboxes yet"
        description={
          hosted
            ? "A team inbox is a shared address, like support@, that several people read and reply from in their own mail apps. Create the first one and choose who is in it."
            : "A team inbox is a shared address, like support@, that several people read and reply from in their own mail apps. Turn on mailbox hosting on a domain to create one."
        }
        {...(hosted ? {} : { action: { label: "Go to domains", href: "/domains" } })}
        secondary={hosted ? <CreateTeamInbox {...create} /> : undefined}
      />
    )
  }

  return (
    <ListTable fixed>
      <ListHeader>
        <ListHead>Team inbox</ListHead>
        <ListHead>Members</ListHead>
        <ListHead className="text-right">Created</ListHead>
      </ListHeader>
      <ListBody>
        {inboxes.map((inbox) => {
          const name = inboxName(inbox)
          return (
            <ListRow key={inbox.address}>
              <ListCell>
                <div className="flex items-center gap-3">
                  <ListTile>
                    <Users className="size-4" />
                  </ListTile>
                  <div className="min-w-0">
                    <Link
                      href={`/team-inboxes/${encodeURIComponent(inbox.address)}`}
                      className="block truncate font-medium outline-none hover:underline focus-visible:underline"
                    >
                      {name}
                    </Link>
                    {name !== inbox.address && (
                      <p className="truncate text-xs text-muted-foreground">
                        {inbox.address}
                      </p>
                    )}
                  </div>
                </div>
              </ListCell>
              <ListCell className="text-sm text-muted-foreground">
                {memberCount(inbox.members.length)}
              </ListCell>
              <ListCell className="text-right text-sm text-muted-foreground">
                <Time iso={inbox.created_at} />
              </ListCell>
            </ListRow>
          )
        })}
      </ListBody>
    </ListTable>
  )
}
