"use client"

import * as React from "react"
import { useClerk, useOrganization, useUser } from "@clerk/nextjs"
import type {
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
  changeMemberRole,
  leaveWorkspace,
  makeTeamWorkspace,
  removeTeamMember,
  sendInvitations,
  teamAccessDomains,
  teamCapacity,
  teamExclusions,
  teamInvitations,
  teamJoinRequests,
  teamJoins,
  teamRoles,
  withdrawInvitation,
  type AccessDomain,
  type JoinRecord,
  type JoinRequest,
  type JoinRole,
  type PendingInvitation,
  type TeamCapacity,
  type TeamRoles,
} from "@/lib/actions"
import { roleItems, roleLabel } from "@/lib/roles"
import type { WorkspaceRole } from "@/lib/types"
import { InviteExpiry, defaultExpiry, type Expiry } from "@/components/invite-expiry"
import {
  expiresLine,
  expiryProblem,
  lastSpotWarning,
  roomText,
  seatsLine,
} from "@/lib/invitations"
import { AccessDomains, Exclusions, type AccessState } from "@/components/team-access"
import { atDomain, ruleForAddress } from "@/lib/access-match"
import { useCreateWorkspace } from "@/lib/create-workspace"
import { announceWorkspacesChanged } from "@/lib/workspace-name"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"
import { RememberShape } from "@/components/list/remembered-shapes"
import { TeamSkeleton } from "@/components/team-skeleton"
import {
  teamShape,
  MAX_TEAM_MEMBERS,
  MAX_TEAM_ROWS,
  type TeamShape,
} from "@/lib/shapes/team"

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
 * ⚠ WHO CAN DO WHAT IS OUR ANSWER SINCE #335, NOT CLERK'S. Every member is
 * `org:member` in Clerk, so `membership.role` and `has()` say the same thing
 * about everybody; the roles and the reader's permissions come from
 * `/console/team/roles`, and the API checks them again on every write.
 */
export function TeamPanel({
  shape,
  loading = false,
}: {
  shape: TeamShape
  loading?: boolean
}) {
  const { isLoaded, organization, membership } = useOrganization()

  if (loading || !isLoaded) return <TeamSkeleton shape={shape} />
  if (!organization || !membership) return <CreateWorkspace />
  if (organization.publicMetadata?.kind === "personal") {
    return <PersonalWorkspace organization={organization} />
  }
  return <Team organization={organization} shape={shape} />
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

/** The roles an access rule may give: never owner. */
const RULE_ROLES = roleItems<JoinRole>(["member", "admin"])

/**
 * One read, kept on screen while it is read again: `value` is `undefined`
 * only until the first answer, and a failed read answers with its fallback, so
 * the page never waits on one that will not come.
 */
function useRead<T>(
  read: () => Promise<T>,
  { enabled = true, key = 0 as unknown } = {},
) {
  const [value, set] = React.useState<T | undefined>(undefined)
  const load = React.useCallback(() => void read().then(set), [read])
  React.useEffect(() => {
    if (enabled) load()
  }, [enabled, load, key])
  return { value, set, load }
}

const readRoles = () => teamRoles().then((result) => (result.ok ? result.data : null))
const readCapacity = () =>
  teamCapacity().then((result) => (result.ok ? (result.data.data ?? null) : null))
const readAccess = () =>
  teamAccessDomains().then((result): AccessState | false =>
    result.ok
      ? {
          domains: result.data.data,
          verified: result.data.verified ?? [],
          suggested: result.data.suggested ?? [],
        }
      : false,
  )
/** How each member got in through an access domain (#326), by user id. */
const readJoins = () =>
  teamJoins().then((result): Record<string, JoinRecord> =>
    result.ok ? Object.fromEntries(result.data.data.map((j) => [j.user_id, j])) : {},
  )
const readInvitations = () =>
  teamInvitations().then((result) => (result.ok ? result.data.data : []))
const readRequests = () =>
  teamJoinRequests().then((result) => (result.ok ? result.data.data : []))
const readExclusions = () =>
  teamExclusions().then((result) => (result.ok ? result.data.data : []))

/**
 * ⚠ ONE LOADING STATE FOR THE WHOLE PAGE (2026-11-09). The members come from
 * Clerk and everything else from six reads of ours, and each block used to
 * draw its own "Loading…" and then its content, pushing every block below it
 * down in turn - 400px and more, six times in two seconds. Now every read is
 * started at once and the page stays a skeleton (components/team-skeleton.tsx,
 * drawn from the shape remembered for this workspace) until the last one has
 * answered; then it is the page, in one frame, where the skeleton said.
 *
 * The invitations, requests and removed list are only for managers, whom the
 * roles read names - and the roles are one of the reads. So they start on the
 * remembered answer and, if the roles say otherwise, stop.
 */
function Team({
  organization,
  shape,
}: {
  organization: OrganizationResource
  shape: TeamShape
}) {
  const [invitesVersion, setInvitesVersion] = React.useState(0)
  // Removing somebody adds them to a list; the lists block reloads.
  const [listsVersion, setListsVersion] = React.useState(0)

  /*
   * ⚠ ONE READ OF THE ROLES FOR THE WHOLE PAGE (#335): every member's, and
   * the reader's own permissions, which decide every block below. Re-read
   * after a role changes, and when the workspace does.
   */
  const roles = useRead(readRoles, { key: organization.id })
  const permitted = (permission: string) =>
    roles.value?.me.permissions.includes(permission) ?? false
  const manage = permitted("members:manage")
  const domains = permitted("access_domains:manage")
  const expectManage = roles.value === undefined ? shape.canManage : manage

  /*
   * ⚠ ONE READ OF THE WORKSPACE'S SEATS FOR THE WHOLE PAGE (#327): the
   * invitation form warns on the last spot and refuses past it, and Accept
   * says what would make room. Re-read after anything that moves a seat.
   */
  const capacity = useRead(readCapacity)
  /*
   * ⚠ ONE READ OF THE ACCESS DOMAINS FOR THE WHOLE PAGE (#326): the access
   * block shows them, and the remove dialog needs them to say whether
   * auto-join covers the person being removed.
   */
  const access = useRead(readAccess)
  const joins = useRead(readJoins)
  const invitations = useRead(readInvitations, {
    enabled: expectManage,
    key: invitesVersion,
  })
  const requests = useRead(readRequests, { enabled: expectManage })
  const exclusions = useRead(readExclusions, {
    enabled: expectManage,
    key: listsVersion,
  })
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

  const ready =
    roles.value !== undefined &&
    capacity.value !== undefined &&
    access.value !== undefined &&
    joins.value !== undefined &&
    (memberships?.data !== undefined || Boolean(memberships?.isError)) &&
    (!manage ||
      (invitations.value !== undefined &&
        requests.value !== undefined &&
        exclusions.value !== undefined))
  if (!ready) return <TeamSkeleton shape={shape} />

  const loadedRoles = roles.value ?? null
  const members = memberships?.data ?? []
  const pending = invitations.value ?? []
  const asked = requests.value ?? []
  const state = access.value ?? false
  const accessDomains = state ? state.domains : []
  const seats = capacity.value ?? null

  return (
    <div>
      <ProfileBlock title="Members">
        <ProfileRow label="Members">
          <Members
            members={members}
            joins={joins.value ?? {}}
            manage={manage}
            roles={loadedRoles}
            onRolesChanged={roles.load}
            access={accessDomains}
            reload={() => void memberships?.revalidate?.()}
            onRemoved={() => {
              setListsVersion((v) => v + 1)
              capacity.load()
            }}
          />
        </ProfileRow>
        {manage && (
          <ProfileRow label="Invitations">
            <Invitations
              invitable={loadedRoles?.me.invitable ?? []}
              capacity={seats}
              pending={pending}
              setPending={invitations.set}
              onChanged={() => {
                setInvitesVersion((v) => v + 1)
                capacity.load()
              }}
            />
          </ProfileRow>
        )}
        {manage && (
          <ProfileRow label="Requests">
            <Requests
              organization={organization}
              capacity={seats}
              requests={asked}
              setRequests={requests.set}
              refreshMembers={() => void memberships?.revalidate?.()}
              onAccepted={capacity.load}
              onBlocked={() => setListsVersion((v) => v + 1)}
            />
          </ProfileRow>
        )}
      </ProfileBlock>
      {domains && (
        <ProfileBlock title="Team access">
          <ProfileRow label="Domains">
            <AccessDomains state={state} roles={RULE_ROLES} onChange={access.load} />
          </ProfileRow>
        </ProfileBlock>
      )}
      {manage && (
        <ProfileBlock title="Removed and blocked">
          <ProfileRow label="People">
            <Exclusions list={exclusions.value ?? []} setList={exclusions.set} />
          </ProfileRow>
        </ProfileBlock>
      )}
      <ProfileBlock title="Leave workspace">
        <ProfileRow label="Leave">
          <Leave organization={organization} />
        </ProfileRow>
      </ProfileBlock>
      <RememberShape
        def={teamShape}
        shape={{
          members: Math.min(members.length, MAX_TEAM_MEMBERS),
          canManage: manage,
          capacity: seats !== null,
          invitable: seats !== null && !seats.personal,
          invites: Math.min(pending.length, MAX_TEAM_ROWS),
          requests: Math.min(asked.length, MAX_TEAM_ROWS),
          waiting: Math.min(asked.filter((r) => r.full).length, MAX_TEAM_ROWS),
          full: Boolean(seats?.full),
          accessDomains: domains,
          domains: Math.min(accessDomains.length, MAX_TEAM_ROWS),
          proofs: Math.min(
            accessDomains.filter((d) => d.status !== "verified").length,
            MAX_TEAM_ROWS,
          ),
          suggestions: Math.min(state ? state.suggested.length : 0, MAX_TEAM_ROWS),
          removed: Math.min((exclusions.value ?? []).length, MAX_TEAM_ROWS),
        }}
      />
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
 * they joined, their role (a picker for whoever may change it) and a menu to
 * remove them. "You" on the person reading it.
 *
 * ⚠ THE LIST IS CLERK'S, THE ROLES ARE OURS (#335). Names, photos and who is
 * in come from Clerk's membership list; each role, and what the reader may
 * give, from `/console/team/roles`. Somebody we hold no role for is a member.
 */
function Members({
  members,
  joins,
  manage,
  roles,
  onRolesChanged,
  access,
  reload,
  onRemoved,
}: {
  members: OrganizationMembershipResource[]
  joins: Record<string, JoinRecord>
  manage: boolean
  roles: TeamRoles | null
  onRolesChanged: () => void
  access: AccessDomain[]
  reload: () => void
  onRemoved: () => void
}) {
  const [removing, setRemoving] = React.useState<{
    member: OrganizationMembershipResource
    block: boolean
  } | null>(null)
  const stepUp = useStepUp()
  const { user } = useUser()
  const roleOf = React.useMemo(
    () => new Map((roles?.data ?? []).map((r) => [r.user_id, r.role])),
    [roles],
  )
  const grantable = roles?.me.grantable ?? []
  const pickable = roleItems(grantable)

  async function changeRole(userId: string, from: WorkspaceRole, to: WorkspaceRole) {
    if (to === from) return
    /*
     * ⚠ THE LAST OWNER CANNOT STEP DOWN (#335; it was the last admin until
     * then). A workspace with no owner has nobody who can delete it or make
     * a new owner - and nobody left who could fix that. The picker stays on
     * Owner and says why; the API refuses it too.
     */
    const owners = [...roleOf.values()].filter((r) => r === "owner").length
    if (from === "owner" && owners <= 1) {
      toastError("You are the only owner", {
        description: "Make someone else an owner first, then change your own role.",
      })
      return
    }
    const result = await changeMemberRole(userId, to)
    if (!result.ok) {
      toastError("Could not change that role", { description: result.error })
      return
    }
    // Your own role too: the pickers hang on our answer, re-read at once.
    onRolesChanged()
  }

  return (
    <div>
      <MotionList>
        {members.map((member) => {
          const { name, identifier } = who(member.publicUserData)
          // ⚠ BY USER ID, NOT THE MEMBERSHIP'S OWN COPY: Clerk's active
          // membership can carry no `publicUserData`, which made nobody "You"
          // and gave the reader a role picker - and a Remove - on themselves.
          const userId = member.publicUserData?.userId ?? ""
          const mine = userId !== "" && userId === user?.id
          const role = roleOf.get(userId) ?? "member"
          // An admin sees an owner's role, and cannot change or remove them.
          const canPick = userId !== "" && grantable.includes(role)
          const canRemove =
            manage && !mine && (role !== "owner" || grantable.includes("owner"))
          return (
            <MotionItem key={member.publicUserData?.userId ?? member.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar
                    name={name}
                    // Clerk's picture, its default without an upload; letters
                    // only when it cannot load, as every avatar here.
                    src={member.publicUserData?.imageUrl}
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
                  {/* Your own role too (2026-10-12), with the last-owner guard above. */}
                  {canPick ? (
                    <MorphSelect
                      label={`Role for ${name}`}
                      hideLabel
                      items={pickable}
                      value={role}
                      onValueChange={(next) =>
                        void changeRole(userId, role, next as WorkspaceRole)
                      }
                    />
                  ) : (
                    <Badge size="sm" tone={role === "member" ? "neutral" : "info"}>
                      {roleLabel(role)}
                    </Badge>
                  )}
                  {canRemove && (
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
                  {manage && !canRemove && <span aria-hidden className="size-7" />}
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
          reload()
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
 * Invitations, through our API since #327: "+ Invite" opens the form in place
 * - addresses, a role, and when it expires, in the invitee's time - and the
 * pending invitations sit under it, each with its expiry and a way to
 * withdraw it. The expiry cannot be changed after sending.
 *
 * ⚠ THE FORM KNOWS THE SPOTS LEFT. The invitation that takes the last one
 * says who it shuts out; more addresses than spots is refused before it is
 * sent, with what would make room - the API refuses it too.
 */
function Invitations({
  invitable,
  capacity,
  pending,
  setPending,
  onChanged,
}: {
  /** What the reader may invite as (#335): member or admin, never owner. */
  invitable: JoinRole[]
  capacity: TeamCapacity | null
  pending: PendingInvitation[]
  setPending: React.Dispatch<React.SetStateAction<PendingInvitation[] | undefined>>
  onChanged: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [emails, setEmails] = React.useState<string[]>([])
  const [role, setRole] = React.useState<JoinRole | null>(null)
  const roles = roleItems(invitable)
  const [expiry, setExpiry] = React.useState<Expiry>(() => defaultExpiry())
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [withdrawing, setWithdrawing] = React.useState<PendingInvitation | null>(null)
  const follow = useFollowOpen<HTMLFormElement>(open)

  const chosenRole =
    role ?? roles.find((r) => r.value === "member")?.value ?? roles[0]?.value ?? null

  const free = capacity?.free ?? null
  const tooMany = free !== null && emails.length > free
  const warning =
    capacity && !tooMany
      ? lastSpotWarning({
          free: capacity.free,
          adding: emails.length,
          patterns: capacity.patterns,
        })
      : null

  function openForm() {
    // A fresh form starts at seven days from now, not from when the page loaded.
    setExpiry((current) => ({
      ...defaultExpiry(),
      zone: current.zone,
      country: current.country,
    }))
    setOpen(true)
  }

  async function send(event: React.FormEvent) {
    event.preventDefault()
    if (!chosenRole || emails.length === 0 || tooMany) return
    const problem = expiryProblem(expiry.at, new Date())
    if (problem || !expiry.at) {
      setError(problem)
      return
    }
    setSending(true)
    setError(null)
    const result = await sendInvitations({
      emails,
      role: chosenRole,
      expires_at: expiry.at.toISOString(),
      zone: expiry.zone,
      country: expiry.country,
    })
    setSending(false)
    if (!result.ok) {
      const reasons = Array.isArray(result.body?.reasons)
        ? (result.body.reasons as string[])
        : []
      setError(
        reasons.length > 0
          ? `${result.error} To make room, ${roomText(reasons)}.`
          : result.error,
      )
      onChanged()
      return
    }
    const { sent, failed } = result.data
    if (sent.length > 0)
      toastDone(
        sent.length === 1 ? "Invitation sent" : `${sent.length} invitations sent`,
      )
    if (failed.length > 0) {
      // What failed stays in the box with why; what went out leaves it.
      setEmails(failed.map((f) => f.email))
      setError(failed.map((f) => `${f.email}: ${f.reason}`).join(" "))
    } else {
      setEmails([])
      setOpen(false)
    }
    onChanged()
  }

  const now = new Date()

  return (
    <div className="flex flex-col gap-1">
      {capacity && (
        <p className="pb-1 text-xs text-muted-foreground tabular">
          {seatsLine(capacity)}
        </p>
      )}
      <MotionList>
        {pending.length === 0 && !open ? (
          <MotionItem key="empty">
            <p className="pt-1.5 text-sm text-muted-foreground">
              No pending invitations.
            </p>
          </MotionItem>
        ) : (
          pending.map((invitation) => (
            <MotionItem key={invitation.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{invitation.email}</span>
                  <span className="block text-xs text-muted-foreground">
                    {expiresLine(new Date(invitation.expires_at), now)} ·{" "}
                    {roleLabel(invitation.role)}
                  </span>
                </span>
                <RowMenu visible label={invitation.email}>
                  <DropdownMenuItem
                    className="text-danger"
                    onSelect={() => setWithdrawing(invitation)}
                  >
                    Withdraw invitation
                  </DropdownMenuItem>
                </RowMenu>
              </div>
            </MotionItem>
          ))
        )}
      </MotionList>

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
              onValueChange={(value) => setRole(value as JoinRole)}
            />
          )}
          <InviteExpiry
            value={expiry}
            onChange={(next) => {
              setError(null)
              setExpiry(next)
            }}
          />
          <Reveal show={Boolean(tooMany && capacity)} spacing="pt-0">
            <p className="text-xs text-danger">
              {capacity?.free === 0
                ? "This workspace is full."
                : `Only ${capacity?.free} ${capacity?.free === 1 ? "spot is" : "spots are"} free.`}{" "}
              To make room, {roomText(capacity?.reasons ?? [])}.
            </p>
          </Reveal>
          <Reveal show={Boolean(warning)} spacing="pt-0">
            <p className="text-xs text-warning">{warning}</p>
          </Reveal>
          <Reveal show={Boolean(error)} spacing="pt-0">
            <p className="text-xs text-danger">{error}</p>
          </Reveal>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={sending}
              disabled={emails.length === 0 || tooMany}
            >
              Send invitations
            </Button>
          </div>
        </form>
      </Reveal>
      {!open && !capacity?.personal && (
        <div>
          <AddAction onClick={openForm}>Invite</AddAction>
        </div>
      )}

      <ConfirmDialog
        open={withdrawing !== null}
        onOpenChange={(next) => !next && setWithdrawing(null)}
        title="Withdraw invitation"
        description={
          withdrawing
            ? `The link sent to ${withdrawing.email} stops working now, and the spot it held frees up.`
            : ""
        }
        confirmLabel="Withdraw"
        doneLabel="Withdrawn"
        onConfirm={async () => {
          if (!withdrawing) return false
          const result = await withdrawInvitation(withdrawing.id)
          if (!result.ok && result.status !== 404) {
            toastError("Could not withdraw that invitation", {
              description: result.error,
            })
            return false
          }
          setPending((list) => (list ?? []).filter((i) => i.id !== withdrawing.id))
          onChanged()
          return true
        }}
      />
    </div>
  )
}

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * People who asked to join through an access domain, or whose auto-join found
 * the workspace full (#326) - ours since 2026-10-13. Accepting adds them with
 * their rule's role and clears them from the removed list.
 *
 * ⚠ WHILE THE WORKSPACE IS FULL, ACCEPT IS OFF AND SAYS WHY. Members plus
 * pending invitations count against the plan's limit (#327), so the way to
 * make room is one of those, or a bigger plan - and only what applies is
 * named: withdrawing needs a pending invitation, upgrading a higher plan.
 *
 * ⚠ ACCEPT AND NOTIFY IS THE ONE FLOW. Requests never expire; whoever is
 * accepted is emailed that they are in, and somebody who waited because the
 * workspace was full is told a spot opened up.
 */
function Requests({
  organization,
  capacity,
  requests,
  setRequests,
  refreshMembers,
  onAccepted,
  onBlocked,
}: {
  organization: OrganizationResource
  capacity: TeamCapacity | null
  requests: JoinRequest[]
  setRequests: React.Dispatch<React.SetStateAction<JoinRequest[] | undefined>>
  refreshMembers: () => void
  onAccepted: () => void
  onBlocked: () => void
}) {
  const [busy, setBusy] = React.useState<string | null>(null)

  const full = capacity?.full ?? false
  const room = roomText(capacity?.reasons ?? [])

  async function answer(request: JoinRequest, accept: boolean, block = false) {
    setBusy(request.id)
    const result = await answerJoinRequest(request.id, accept, block)
    setBusy(null)
    if (!result.ok) {
      toastError(
        accept ? "Could not accept that request" : "Could not answer that request",
        { description: result.error },
      )
      // Full since the page loaded: show what would make room.
      if (result.name === "workspace_full") onAccepted()
      return
    }
    setRequests((list) => (list ?? []).filter((r) => r.id !== request.id))
    if (accept) {
      toastDone(`${request.email} joined`, {
        description: "We emailed them to say they're in.",
      })
      refreshMembers()
      void organization.reload()
      onAccepted()
    }
    if (block) {
      toastDone(`${request.email} is blocked`)
      onBlocked()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {full && (
        <p className="text-xs text-muted-foreground">
          {organization.name} is full. To accept a request, {room} first.
        </p>
      )}
      <MotionList>
        {requests.length === 0 ? (
          <MotionItem key="empty">
            <p className="pt-1.5 text-sm text-muted-foreground">No requests to join.</p>
          </MotionItem>
        ) : (
          requests.map((request) => (
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
                    Accept and notify
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
          ))
        )}
      </MotionList>
    </div>
  )
}

// ── Leave ────────────────────────────────────────────────────────────────────

/**
 * Clerk's "Leave organization": confirmed by typing its name.
 *
 * ⚠ THROUGH OUR API SINCE #335, NOT `user.leaveOrganization()`, so the only
 * owner is told to hand over first instead of leaving a workspace nobody can
 * run. The API's refusal is shown as it stands.
 */
function Leave({ organization }: { organization: OrganizationResource }) {
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
          const result = await leaveWorkspace()
          if (!result.ok) {
            toastError("Could not leave this workspace", { description: result.error })
            return false
          }
          try {
            await clerk.setActive({ organization: null })
          } catch (error) {
            toastError("You left, but could not switch workspace", clerkReason(error))
          }
          // Left on the server: the pickers drop it now, not on their next refetch.
          announceWorkspacesChanged()
          router.push("/")
          return true
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
