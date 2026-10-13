"use client"

import * as React from "react"
import { useAuth, useClerk, useOrganization, useSession, useUser } from "@clerk/nextjs"
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
  sendInvitations,
  teamAccessDomains,
  teamCapacity,
  teamInvitations,
  teamJoinRequests,
  teamJoins,
  withdrawInvitation,
  type AccessDomain,
  type JoinRecord,
  type JoinRequest,
  type PendingInvitation,
  type TeamCapacity,
} from "@/lib/actions"
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

  /*
   * ⚠ ONE READ OF THE WORKSPACE'S SEATS FOR THE WHOLE PAGE (#327): the
   * invitation form warns on the last spot and refuses past it, and Accept
   * says what would make room. Re-read after anything that moves a seat.
   */
  const [capacity, setCapacity] = React.useState<TeamCapacity | null>(null)
  const loadCapacity = React.useCallback(() => {
    void teamCapacity().then((result) =>
      setCapacity(result.ok ? (result.data.data ?? null) : null),
    )
  }, [])
  React.useEffect(loadCapacity, [loadCapacity])
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
            onRemoved={() => {
              setListsVersion((v) => v + 1)
              loadCapacity()
            }}
          />
        </ProfileRow>
        {manage && (
          <ProfileRow label="Invitations">
            <Invitations
              roles={roles}
              capacity={capacity}
              version={invitesVersion}
              onChanged={() => {
                setInvitesVersion((v) => v + 1)
                loadCapacity()
              }}
            />
          </ProfileRow>
        )}
        {manage && (
          <ProfileRow label="Requests">
            <Requests
              organization={organization}
              capacity={capacity}
              onAccepted={loadCapacity}
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
  roles,
  capacity,
  version,
  onChanged,
}: {
  roles: { value: string; label: string }[]
  capacity: TeamCapacity | null
  version: number
  onChanged: () => void
}) {
  const [pending, setPending] = React.useState<PendingInvitation[] | null>(null)
  const [open, setOpen] = React.useState(false)
  const [emails, setEmails] = React.useState<string[]>([])
  const [role, setRole] = React.useState<string | null>(null)
  const [expiry, setExpiry] = React.useState<Expiry>(() => defaultExpiry())
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [withdrawing, setWithdrawing] = React.useState<PendingInvitation | null>(null)
  const follow = useFollowOpen<HTMLFormElement>(open)

  const load = React.useCallback(() => {
    void teamInvitations().then((result) =>
      setPending(result.ok ? result.data.data : []),
    )
  }, [])
  React.useEffect(load, [load, version])

  const chosenRole =
    role ??
    roles.find((r) => r.value === "org:member")?.value ??
    roles[0]?.value ??
    null
  const roleName = (key: string) => roles.find((r) => r.value === key)?.label ?? key

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
        {(pending ?? []).map((invitation) => (
          <MotionItem key={invitation.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate text-sm">{invitation.email}</span>
                <span className="block text-xs text-muted-foreground">
                  {expiresLine(new Date(invitation.expires_at), now)} ·{" "}
                  {roleName(invitation.role)}
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
          <InviteExpiry
            value={expiry}
            onChange={(next) => {
              setError(null)
              setExpiry(next)
            }}
          />
          {tooMany && capacity && (
            <p className="-mt-3 text-xs text-danger">
              {capacity.free === 0
                ? "This workspace is full."
                : `Only ${capacity.free} ${capacity.free === 1 ? "spot is" : "spots are"} free.`}{" "}
              To make room, {roomText(capacity.reasons)}.
            </p>
          )}
          {warning && <p className="-mt-3 text-xs text-warning">{warning}</p>}
          {error && <p className="-mt-3 text-xs text-danger">{error}</p>}
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
  onAccepted,
  onBlocked,
}: {
  organization: OrganizationResource
  capacity: TeamCapacity | null
  onAccepted: () => void
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
      void memberships?.revalidate?.()
      void organization.reload()
      onAccepted()
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
