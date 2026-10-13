"use client"

import * as React from "react"
import { useAuth, useClerk, useOrganization, useSession, useUser } from "@clerk/nextjs"
import type {
  OrganizationInvitationResource,
  OrganizationMembershipResource,
  OrganizationResource,
} from "@clerk/shared/types"
import { useRouter } from "next/navigation"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Skeleton } from "@repo/ui/components/skeleton/skeleton"
import { TagInput } from "@repo/ui/components/tag-input/tag-input"
import { emailProblem } from "@repo/ui/checks"
import {
  AddAction,
  MotionItem,
  MotionList,
  ProfileBlock,
  ProfileRow,
  clerkReason,
  shortDate,
  useFollowOpen,
} from "@/components/account/shared"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RowMenu } from "@/components/list/row-menu"
import {
  answerJoinRequest,
  makeTeamWorkspace,
  removeTeamMember,
  teamAccessDomains,
  teamJoinRequests,
  teamJoins,
  type AccessDomain,
  type JoinRecord,
  type JoinRequest,
} from "@/lib/actions"
import { AccessDomains, Exclusions, type AccessState } from "@/components/team-access"
import { atDomain, ruleForAddress } from "@/lib/access-match"
import { useCreateWorkspace } from "@/lib/create-workspace"
import { announceWorkspacesChanged } from "@/lib/workspace-name"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { useReverify, useStepUp } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"

/**
 * The team panel, ours (2026-10-12) - what Clerk's `<OrganizationProfile />`
 * was on this page: members and their roles, invitations, membership requests,
 * verified domains and leaving; and Clerk's `<CreateOrganization />` for
 * somebody on a personal account. Clerk's originals are at
 * /reference/clerk/organization-profile to compare against.
 *
 * ⚠ THE SAME LAYOUT AS THE ACCOUNT PAGE, which is the same layout Clerk used
 * for both: blocks, and rows with the label on the left.
 *
 * ⚠ WHO CAN DO WHAT IS CLERK'S ANSWER, NOT OURS. `has({ permission })` reads
 * the session's organization permissions - the same check Clerk's panel used
 * to decide which buttons to draw - and Clerk's API refuses anything else.
 */
export function TeamPanel() {
  const { isLoaded, organization, membership } = useOrganization()

  if (!isLoaded) {
    return (
      <div className="space-y-3">
        <Skeleton label="Loading members" avatar lines={2} />
      </div>
    )
  }
  if (!organization || !membership) return <CreateWorkspace />
  if (organization.publicMetadata?.kind === "personal") {
    return <PersonalWorkspace organization={organization} />
  }
  return <Team organization={organization} membership={membership} />
}

/**
 * A Personal workspace's team page (#325): there is no team, only the way to
 * make one of it.
 *
 * ⚠ IT KEEPS EVERYTHING. The domains, keys, templates and plan stay where they
 * are; only the name changes and the one-member limit is lifted. Somebody who
 * would rather keep Personal and start fresh creates a workspace instead.
 */
function PersonalWorkspace({ organization }: { organization: OrganizationResource }) {
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const next = name.trim()
    if (!next || saving) return
    setSaving(true)
    const made = await makeTeamWorkspace(next)
    if (!made.ok) {
      toastError("Could not turn it into a team workspace", made.error)
      setSaving(false)
      return
    }
    await organization.reload()
    announceWorkspacesChanged()
    toastDone(`${next} is a team workspace now`)
    router.refresh()
    setSaving(false)
  }

  return (
    <ProfileBlock title="Personal workspace">
      <ProfileRow label="Team">
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This workspace is just for you. Name it to turn it into a team workspace you
            can invite people to. Your domains, keys and plan stay as they are.
          </p>
          <FloatingInput
            label="Team name"
            id="team-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={saving}
          />
          <Button type="submit" loading={saving} disabled={!name.trim()}>
            Turn into a team workspace
          </Button>
        </form>
      </ProfileRow>
    </ProfileBlock>
  )
}

function Team({
  organization,
  membership,
}: {
  organization: OrganizationResource
  membership: OrganizationMembershipResource
}) {
  const { has } = useAuth()
  const manage =
    has?.({ permission: "org:sys_memberships:manage" }) ??
    membership.role === "org:admin"
  const domains =
    has?.({ permission: "org:sys_domains:manage" }) ?? membership.role === "org:admin"

  const [roles, setRoles] = React.useState<{ value: string; label: string }[]>([])
  React.useEffect(() => {
    void organization.getRoles({ pageSize: 50 }).then(
      (result) =>
        setRoles(result.data.map((role) => ({ value: role.key, label: role.name }))),
      () => setRoles([]),
    )
  }, [organization])

  // Invitations are listed beside the members; sending one refreshes both.
  const [invitesVersion, setInvitesVersion] = React.useState(0)
  // Removing somebody adds them to a list; the lists block reloads.
  const [listsVersion, setListsVersion] = React.useState(0)

  /*
   * ⚠ ONE READ OF THE ACCESS DOMAINS FOR THE WHOLE PAGE (#326): the access
   * block shows them, and the remove dialog needs them to say whether
   * auto-join covers the person being removed.
   */
  const [access, setAccess] = React.useState<AccessState | false | null>(null)
  const loadAccess = React.useCallback(() => {
    void teamAccessDomains().then((result) =>
      setAccess(
        result.ok
          ? {
              domains: result.data.data,
              verified: result.data.verified ?? [],
              suggested: result.data.suggested ?? [],
            }
          : false,
      ),
    )
  }, [])
  React.useEffect(loadAccess, [loadAccess])

  return (
    <div>
      <ProfileBlock title="Members">
        <ProfileRow label="Members">
          <Members
            manage={manage}
            roles={roles}
            access={access ? access.domains : []}
            onRemoved={() => setListsVersion((v) => v + 1)}
          />
        </ProfileRow>
        {manage && (
          <ProfileRow label="Invitations">
            <Invitations
              organization={organization}
              roles={roles}
              version={invitesVersion}
              onSent={() => setInvitesVersion((v) => v + 1)}
            />
          </ProfileRow>
        )}
        {manage && (
          <ProfileRow label="Requests">
            <Requests
              organization={organization}
              onBlocked={() => setListsVersion((v) => v + 1)}
            />
          </ProfileRow>
        )}
      </ProfileBlock>
      {domains && (
        <ProfileBlock title="Team access">
          <ProfileRow label="Domains">
            <AccessDomains state={access} roles={roles} onChange={loadAccess} />
          </ProfileRow>
        </ProfileBlock>
      )}
      {manage && (
        <ProfileBlock title="Removed and blocked">
          <ProfileRow label="People">
            <Exclusions version={listsVersion} />
          </ProfileRow>
        </ProfileBlock>
      )}
      <ProfileBlock title="Leave workspace">
        <ProfileRow label="Leave">
          <Leave organization={organization} />
        </ProfileRow>
      </ProfileBlock>
    </div>
  )
}

// ── Members ──────────────────────────────────────────────────────────────────

/** A member's name, or their address when they have none. */
function who(data: OrganizationMembershipResource["publicUserData"]) {
  const name = [data?.firstName, data?.lastName].filter(Boolean).join(" ")
  return {
    name: name || data?.identifier || "Member",
    identifier: data?.identifier ?? "",
  }
}

/**
 * Clerk's members list: each member with their photo, name and address, when
 * they joined, their role (a picker for an admin, as Clerk's was) and a menu
 * to remove them. "You" on the person reading it.
 */
function Members({
  manage,
  roles,
  access,
  onRemoved,
}: {
  manage: boolean
  roles: { value: string; label: string }[]
  access: AccessDomain[]
  onRemoved: () => void
}) {
  const [removing, setRemoving] = React.useState<{
    member: OrganizationMembershipResource
    block: boolean
  } | null>(null)
  const reverify = useReverify()
  const stepUp = useStepUp()
  /** How each member got in through an access domain (#326), by user id. */
  const [joins, setJoins] = React.useState<Record<string, JoinRecord>>({})
  React.useEffect(() => {
    void teamJoins().then((result) =>
      setJoins(
        result.ok
          ? Object.fromEntries(result.data.data.map((j) => [j.user_id, j]))
          : {},
      ),
    )
  }, [])
  const { user } = useUser()
  const { session } = useSession()
  /*
   * ⚠ CLERK'S OWN PAGINATED LIST, WITH `keepPreviousData` (2026-10-12) - the
   * hook `<OrganizationProfile />` read. Fetching by hand re-ran whenever
   * Clerk handed back a fresh organization object, and a refetch that failed
   * set the list to empty: the members vanished a couple of seconds in.
   * Refreshing now keeps what is on screen until the new page has arrived.
   */
  const { memberships } = useOrganization({
    memberships: { pageSize: 50, keepPreviousData: true },
  })
  /*
   * ⚠ WHAT IS ON SCREEN STAYS WHILE ANOTHER WORKSPACE LOADS (2026-10-13).
   * Switching workspace showed "Loading members…" and drew the list again, so
   * the reader - first in both lists - was taken out and put back. The
   * previous page is kept until the next one arrives, and rows are keyed by
   * person, so whoever is in both stays where they are.
   */
  const members =
    memberships?.data && memberships.data.length > 0
      ? memberships.data
      : memberships?.isLoading
        ? null
        : (memberships?.data ?? [])
  const load = () => void memberships?.revalidate?.()

  async function changeRole(member: OrganizationMembershipResource, role: string) {
    if (role === member.role) return
    /*
     * ⚠ THE LAST ADMIN CANNOT STEP DOWN (2026-10-12). A workspace with no
     * admin has nobody who can invite, change roles, turn domains on or
     * delete it - and nobody left who could fix that. The picker stays on
     * Admin and says why; promote somebody else first.
     */
    const admins = (members ?? []).filter((m) => m.role === "org:admin").length
    if (member.role === "org:admin" && role !== "org:admin" && admins <= 1) {
      toastError("You are the only admin", {
        description: "Make someone else an admin first, then change your own role.",
      })
      return
    }
    try {
      const done = await reverify(() => member.update({ role }))
      /*
       * ⚠ YOUR OWN ROLE: THE SESSION IS RE-READ AT ONCE, as Clerk's panel
       * leaves to its token. The pickers here hang on `has()`, which reads
       * the session token - without this a self-demoted member keeps an
       * admin's controls until the token renews. Demoting yourself is one
       * way, as in Clerk: a member cannot change roles, their own included.
       */
      if (done && member.publicUserData?.userId === user?.id) await session?.reload()
      load()
    } catch (error) {
      toastError("Could not change that role", clerkReason(error))
    }
  }

  if (!members)
    return <p className="pt-1.5 text-sm text-muted-foreground">Loading members…</p>

  return (
    <div>
      <MotionList>
        {members.map((member) => {
          const { name, identifier } = who(member.publicUserData)
          // ⚠ BY USER ID, NOT THE MEMBERSHIP'S OWN COPY: Clerk's active
          // membership can carry no `publicUserData`, which made nobody "You"
          // and gave the reader a role picker - and a Remove - on themselves.
          const mine = member.publicUserData?.userId === user?.id
          return (
            <MotionItem key={member.publicUserData?.userId ?? member.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar
                    name={name}
                    src={
                      member.publicUserData?.hasImage
                        ? member.publicUserData.imageUrl
                        : undefined
                    }
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm">
                      <span className="truncate">{name}</span>
                      {mine && (
                        <Badge size="sm" tone="success">
                          You
                        </Badge>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {identifier}
                      {` · ${joinedLine(
                        joins[member.publicUserData?.userId ?? ""],
                        member.createdAt,
                      )}`}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {/* Your own role too (2026-10-12), with the last-admin guard above. */}
                  {manage && roles.length > 0 ? (
                    <MorphSelect
                      label={`Role for ${name}`}
                      hideLabel
                      items={roles}
                      value={member.role}
                      onValueChange={(role) => void changeRole(member, role)}
                    />
                  ) : (
                    <Badge
                      size="sm"
                      tone={member.role === "org:admin" ? "info" : "neutral"}
                    >
                      {member.roleName}
                    </Badge>
                  )}
                  {manage && !mine && (
                    <RowMenu visible label={name}>
                      <DropdownMenuItem
                        className="text-danger"
                        onSelect={() => setRemoving({ member, block: false })}
                      >
                        Remove member
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-danger"
                        onSelect={() => setRemoving({ member, block: true })}
                      >
                        Remove and block
                      </DropdownMenuItem>
                    </RowMenu>
                  )}
                  {/* Leaving is its own block below; this keeps the pickers in line. */}
                  {manage && mine && <span aria-hidden className="size-7" />}
                </span>
              </div>
            </MotionItem>
          )
        })}
      </MotionList>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.block ? "Remove and block" : "Remove member"}
        description={removeCopy(removing, access)}
        confirmLabel={removing?.block ? "Remove and block" : "Remove"}
        doneLabel={removing?.block ? "Blocked" : "Removed"}
        onConfirm={async () => {
          const target = removing?.member.publicUserData?.userId
          if (!removing || !target) return false
          /*
           * ⚠ THROUGH OUR API, NOT `membership.destroy()` (#326): the person's
           * addresses go on the removed or block list BEFORE Clerk removes
           * them, or auto-join would let them straight back in.
           */
          if (!(await stepUp())) return false
          const result = await removeTeamMember(target, removing.block)
          if (!result.ok) {
            toastError("Could not remove that member", { description: result.error })
            return false
          }
          load()
          onRemoved()
          return true
        }}
      />
    </div>
  )
}

/** "Joined 3 Oct", or how they came in through an access domain. */
function joinedLine(join: JoinRecord | undefined, at: Date | null | undefined) {
  const when = shortDate(at)
  if (!join) return `Joined ${when}`
  const via = atDomain(join.email)
  if (join.how === "auto") return `Joined automatically via ${via} · ${when}`
  if (join.how === "join") return `Joined via ${via} · ${when}`
  return `Approved request via ${via} · ${when}`
}

/**
 * What removing somebody does, said plainly - and, when an access rule would
 * otherwise let them back in, that it no longer will.
 */
function removeCopy(
  removing: { member: OrganizationMembershipResource; block: boolean } | null,
  access: AccessDomain[],
) {
  if (!removing) return ""
  const { name, identifier } = who(removing.member.publicUserData)
  const base = `${name} will lose access to this workspace - its domains, keys and contacts.`
  if (removing.block)
    return `${base} They won't be suggested this workspace, can't ask to join, and won't be added automatically.`
  const rule = identifier ? ruleForAddress(access, identifier) : null
  if (rule?.mode === "auto")
    return `${base} Auto-join covers ${atDomain(identifier)}, but once removed they can only ask to join again.`
  return `${base} They can still ask to join again.`
}

// ── Invitations ──────────────────────────────────────────────────────────────

/**
 * Clerk's invitations: "+ Invite" opening the form in place - addresses (as
 * many as you like) and a role - and the pending invitations under it, each
 * with a menu to revoke it.
 */
function Invitations({
  organization,
  roles,
  version,
  onSent,
}: {
  organization: OrganizationResource
  roles: { value: string; label: string }[]
  version: number
  onSent: () => void
}) {
  const reverify = useReverify()
  const { invitations } = useOrganization({
    invitations: { status: ["pending"], pageSize: 50, keepPreviousData: true },
  })
  const pending = invitations?.isLoading ? null : (invitations?.data ?? [])
  const [open, setOpen] = React.useState(false)
  const [emails, setEmails] = React.useState<string[]>([])
  const [role, setRole] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const follow = useFollowOpen<HTMLFormElement>(open)

  // A send elsewhere on the page refreshes this list.
  const revalidateInvitations = invitations?.revalidate
  React.useEffect(() => {
    if (version > 0) void revalidateInvitations?.()
  }, [version, revalidateInvitations])

  const chosenRole =
    role ??
    roles.find((r) => r.value === "org:member")?.value ??
    roles[0]?.value ??
    null

  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (!chosenRole || emails.length === 0) return
    setSending(true)
    setError(null)
    try {
      const sent = await reverify(() =>
        organization.inviteMembers({ emailAddresses: emails, role: chosenRole }),
      )
      if (!sent) return
      toastDone(
        sent.length === 1 ? "Invitation sent" : `${sent.length} invitations sent`,
      )
      setEmails([])
      setOpen(false)
      onSent()
    } catch (error) {
      setError(clerkReason(error))
    } finally {
      setSending(false)
    }
  }

  async function revoke(invitation: OrganizationInvitationResource) {
    try {
      await reverify(() => invitation.revoke())
      void invitations?.revalidate?.()
    } catch (error) {
      toastError("Could not revoke that invitation", clerkReason(error))
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <MotionList>
        {(pending ?? []).map((invitation) => (
          <MotionItem key={invitation.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-sm">
                  {invitation.emailAddress}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Invited {shortDate(invitation.createdAt)} · {invitation.roleName}
                </span>
              </span>
              <RowMenu visible label={invitation.emailAddress}>
                <DropdownMenuItem
                  className="text-danger"
                  onSelect={() => void revoke(invitation)}
                >
                  Revoke invitation
                </DropdownMenuItem>
              </RowMenu>
            </div>
          </MotionItem>
        ))}
      </MotionList>
      {pending && pending.length === 0 && !open && (
        <p className="pt-1.5 text-sm text-muted-foreground">No pending invitations.</p>
      )}

      <Reveal show={open} spacing="pt-3">
        <form
          ref={follow}
          noValidate
          onSubmit={send}
          className="flex scroll-mb-6 flex-col gap-7 rounded-2xl border p-4"
        >
          <TagInput
            id="invite-emails"
            label="Email addresses"
            value={emails}
            onValueChange={(next) => {
              setError(null)
              setEmails(next.map((email) => email.trim()).filter(Boolean))
            }}
            placeholder="name@company.com"
            description="Press Enter after each address."
            // ⚠ ONLY REAL ADDRESSES BECOME TAGS (2026-10-12); anything else
            // stays in the box with the reason, instead of failing at send.
            validate={(tag) => {
              const problem = emailProblem(tag)
              return typeof problem === "string" ? problem : (problem?.message ?? null)
            }}
          />
          {roles.length > 0 && (
            <MorphSelect
              label="Role"
              items={roles}
              value={chosenRole}
              onValueChange={(value) => setRole(value)}
            />
          )}
          {error && <p className="-mt-3 text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={sending} disabled={emails.length === 0}>
              Send invitations
            </Button>
          </div>
        </form>
      </Reveal>
      {!open && (
        <div>
          <AddAction onClick={() => setOpen(true)}>Invite</AddAction>
        </div>
      )}
    </div>
  )
}

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * People who asked to join through an access domain, or whose auto-join found
 * the workspace full (#326) - ours since 2026-10-13. Accepting adds them with
 * their rule's role and clears them from the removed list.
 *
 * ⚠ WHILE THE WORKSPACE IS FULL, ACCEPT IS OFF AND SAYS WHY. Clerk counts
 * members plus pending invitations against the limit, so the way to make room
 * is one of those two - and only the ones that apply are named.
 */
function Requests({
  organization,
  onBlocked,
}: {
  organization: OrganizationResource
  onBlocked: () => void
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [requests, setRequests] = React.useState<JoinRequest[] | null>(null)
  const { memberships } = useOrganization({ memberships: { pageSize: 50 } })

  const load = React.useCallback(() => {
    void teamJoinRequests().then((result) =>
      setRequests(result.ok ? result.data.data : []),
    )
  }, [])
  React.useEffect(load, [load])

  const limit = organization.maxAllowedMemberships
  const full =
    limit > 0 &&
    organization.membersCount + organization.pendingInvitationsCount >= limit
  const room = [
    "remove a member",
    ...(organization.pendingInvitationsCount > 0 ? ["withdraw an invitation"] : []),
  ].join(" or ")

  async function answer(request: JoinRequest, accept: boolean, block = false) {
    setBusy(request.id)
    const result = await answerJoinRequest(request.id, accept, block)
    setBusy(null)
    if (!result.ok) {
      toastError(
        accept ? "Could not accept that request" : "Could not answer that request",
        { description: result.error },
      )
      return
    }
    setRequests((list) => (list ?? []).filter((r) => r.id !== request.id))
    if (accept) {
      toastDone(`${request.email} joined`)
      void memberships?.revalidate?.()
      void organization.reload()
    }
    if (block) {
      toastDone(`${request.email} is blocked`)
      onBlocked()
    }
  }

  if (!requests)
    return <p className="pt-1.5 text-sm text-muted-foreground">Loading requests…</p>
  if (requests.length === 0)
    return <p className="pt-1.5 text-sm text-muted-foreground">No requests to join.</p>

  return (
    <div className="flex flex-col gap-2">
      {full && (
        <p className="text-xs text-muted-foreground">
          {organization.name} is full. To accept a request, {room} first.
        </p>
      )}
      <MotionList>
        {requests.map((request) => (
          <MotionItem key={request.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm">
                  <span className="truncate">{request.email}</span>
                  {request.full && (
                    <Badge size="sm" tone="warning">
                      Waiting for room
                    </Badge>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {request.full
                    ? `Tried to join automatically ${shortDate(new Date(request.created_at))} while the workspace was full`
                    : `Asked ${shortDate(new Date(request.created_at))} · via ${request.via ? `@${request.via}` : atDomain(request.email)}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void answer(request, false)}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  loading={busy === request.id}
                  disabled={busy !== null || full}
                  onClick={() => void answer(request, true)}
                >
                  Accept
                </Button>
                <RowMenu visible label={request.email}>
                  <DropdownMenuItem
                    className="text-danger"
                    disabled={busy !== null}
                    onSelect={() => void answer(request, false, true)}
                  >
                    Decline and block
                  </DropdownMenuItem>
                </RowMenu>
              </span>
            </div>
          </MotionItem>
        ))}
      </MotionList>
    </div>
  )
}

// ── Leave ────────────────────────────────────────────────────────────────────

/** Clerk's "Leave organization": confirmed by typing its name. */
function Leave({ organization }: { organization: OrganizationResource }) {
  const { user } = useUser()
  const clerk = useClerk()
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        You will lose access to {organization.name}. Somebody will have to invite you
        back.
      </p>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Leave
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Leave ${organization.name}?`}
        description="You will lose access to its domains, keys and contacts. This workspace carries on without you."
        confirmLabel="Leave"
        doneLabel="Left"
        confirmWord={organization.name}
        onConfirm={async () => {
          if (!user) return false
          try {
            await user.leaveOrganization(organization.id)
            await clerk.setActive({ organization: null })
            router.push("/")
            return true
          } catch (error) {
            toastError("Could not leave this workspace", clerkReason(error))
            return false
          }
        }}
      />
    </div>
  )
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Clerk's `<CreateOrganization />`, ours: one button. No name is asked here -
 * onboarding's first step is the name, so the new workspace goes straight
 * there. See lib/create-workspace.ts.
 */
function CreateWorkspace() {
  const { creating, create } = useCreateWorkspace()
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        You are signed in to a personal account, so there is no team to show yet. Create
        a workspace to invite people and share domains, keys and billing.
      </p>
      <Button
        loading={creating}
        onClick={() =>
          void create().catch((error: unknown) =>
            toastError("Could not create a workspace", clerkReason(error)),
          )
        }
      >
        Create workspace
      </Button>
    </div>
  )
}
