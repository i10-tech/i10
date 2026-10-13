"use client"

import * as React from "react"
import { useAuth, useClerk, useOrganization, useSession, useUser } from "@clerk/nextjs"
import type {
  OrganizationInvitationResource,
  OrganizationMembershipResource,
  OrganizationResource,
} from "@clerk/shared/types"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { VerifiedSeal } from "@repo/ui/components/i10/verified-seal"
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
  setTeamDomain,
  teamDomainSuggestions,
  teamJoinRequests,
  type JoinRequest,
} from "@/lib/actions"
import { useCreateWorkspace } from "@/lib/create-workspace"
import { announceWorkspacesChanged } from "@/lib/workspace-name"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { useReverify } from "@/lib/step-up"
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

  return (
    <div>
      <ProfileBlock title="Members">
        <ProfileRow label="Members">
          <Members manage={manage} roles={roles} />
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
            <Requests />
          </ProfileRow>
        )}
      </ProfileBlock>
      {domains && (
        <ProfileBlock title="Verified domains">
          <ProfileRow label="Domains">
            <Domains />
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
}: {
  manage: boolean
  roles: { value: string; label: string }[]
}) {
  const [removing, setRemoving] = React.useState<OrganizationMembershipResource | null>(
    null,
  )
  const reverify = useReverify()
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
                      {` · Joined ${shortDate(member.createdAt)}`}
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
                        onSelect={() => setRemoving(member)}
                      >
                        Remove member
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
        title="Remove member"
        description={`${removing ? who(removing.publicUserData).name : "This member"} will lose access to this workspace - its domains, keys and contacts.`}
        confirmLabel="Remove"
        doneLabel="Removed"
        onConfirm={async () => {
          if (!removing) return false
          try {
            const done = await reverify(() => removing.destroy())
            if (done) load()
            return done !== null
          } catch (error) {
            toastError("Could not remove that member", clerkReason(error))
            return false
          }
        }}
      />
    </div>
  )
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
 * People who asked to join through a join suggestion, each to accept or
 * decline - ours since 2026-10-13 (Clerk's membership requests need a Clerk
 * plan we do not have). Accepting adds them to the workspace as a member.
 */
function Requests() {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [requests, setRequests] = React.useState<JoinRequest[] | null>(null)
  const { memberships } = useOrganization({ memberships: { pageSize: 50 } })

  const load = React.useCallback(() => {
    void teamJoinRequests().then((result) =>
      setRequests(result.ok ? result.data.data : []),
    )
  }, [])
  React.useEffect(load, [load])

  async function answer(request: JoinRequest, accept: boolean) {
    setBusy(request.id)
    const result = await answerJoinRequest(request.id, accept)
    setBusy(null)
    if (!result.ok) {
      toastError("Could not answer that request", { description: result.error })
      return
    }
    setRequests((list) => (list ?? []).filter((r) => r.id !== request.id))
    if (accept) {
      toastDone(`${request.email} joined`)
      void memberships?.revalidate?.()
    }
  }

  if (!requests)
    return <p className="pt-1.5 text-sm text-muted-foreground">Loading requests…</p>
  if (requests.length === 0)
    return <p className="pt-1.5 text-sm text-muted-foreground">No requests to join.</p>

  return (
    <MotionList>
      {requests.map((request) => (
        <MotionItem key={request.id}>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block truncate text-sm">{request.email}</span>
              <span className="block text-xs text-muted-foreground">
                Asked {shortDate(new Date(request.created_at))} · suggested by{" "}
                {request.email.split("@")[1]}
              </span>
            </span>
            <span className="flex gap-1">
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
                disabled={busy !== null}
                onClick={() => void answer(request, true)}
              >
                Accept
              </Button>
            </span>
          </div>
        </MotionItem>
      ))}
    </MotionList>
  )
}

// ── Verified domains ─────────────────────────────────────────────────────────

const ENROLLMENT = [
  { value: "on", label: "Suggest to join" },
  { value: "off", label: "Off" },
]

/**
 * Join suggestions, one picker per verified domain - run by us since
 * 2026-10-13, because Clerk's verified organization domains are not on our
 * Clerk plan.
 *
 * ⚠ THE LIST IS THE DOMAINS VERIFIED ON /domains, SO THERE IS NOTHING TO
 * LOSE. On: people signed in with a verified address there are suggested this
 * workspace, ask to join, and an admin accepts. Off: they are not. Removing a
 * domain on /domains takes its suggestions with it.
 *
 * ⚠ DNS IS THE PROOF, AND THE API CHECKS IT AND THE ADMIN AGAIN. Joining with
 * no request is SSO's job (i10-tech/i10#319).
 */
function Domains() {
  /** Verified names and the ones suggesting; `false` when the API could not say. */
  const [state, setState] = React.useState<
    { names: string[]; enabled: string[] } | false | null
  >(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  React.useEffect(() => {
    void teamDomainSuggestions().then((result) =>
      setState(
        result.ok
          ? { names: result.data.data, enabled: result.data.enabled ?? [] }
          : false,
      ),
    )
  }, [])

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  async function choose(name: string, on: boolean) {
    if (!state) return
    setBusy(name)
    const result = await setTeamDomain(name, on)
    setBusy(null)
    if (!result.ok) {
      toastError(`Could not change ${name}`, { description: result.error })
      return
    }
    setState({
      ...state,
      enabled: on
        ? [...state.enabled.filter((n) => !same(n, name)), name.toLowerCase()]
        : state.enabled.filter((n) => !same(n, name)),
    })
  }

  if (state === null)
    return <p className="pt-1.5 text-sm text-muted-foreground">Loading domains…</p>
  if (state === false)
    return (
      <p className="pt-1.5 text-sm text-muted-foreground">
        Could not load this workspace&rsquo;s domains. Reload to try again.
      </p>
    )

  if (state.names.length === 0)
    return (
      <p className="pt-1.5 text-sm text-muted-foreground">
        Verify a domain on{" "}
        <Link href="/domains" className="text-foreground underline underline-offset-4">
          Domains
        </Link>{" "}
        and it shows up here, ready to suggest this workspace to people with an address
        at it.
      </p>
    )

  return (
    <MotionList>
      {state.names.map((name) => {
        const on = state.enabled.some((n) => same(n, name))
        return (
          <MotionItem key={name}>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm">
                  <span className="truncate font-mono">{name}</span>
                  <VerifiedSeal />
                </span>
                <span className="block text-xs text-muted-foreground">
                  {on
                    ? `People signed in with an @${name} address are suggested to join.`
                    : `We recommend turning this on: people with an @${name} address can then ask to join, and you approve each one.`}
                </span>
              </span>
              <MorphSelect
                label={`Join suggestions for ${name}`}
                hideLabel
                className="shrink-0"
                items={ENROLLMENT}
                value={on ? "on" : "off"}
                disabled={busy !== null}
                onValueChange={(value) => void choose(name, value === "on")}
              />
            </div>
          </MotionItem>
        )
      })}
    </MotionList>
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
