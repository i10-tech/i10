"use client"

import * as React from "react"
import { useClerk, useOrganizationList, useUser } from "@clerk/nextjs"
import { ChevronRight, Plus } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { StepHeading } from "../../_components/step-heading"

/**
 * Clerk's `choose-organization` task, ours (2026-10-12) - what
 * `<TaskChooseOrganization />` was: the workspaces you belong to, the ones you
 * are invited to, and a way to make one.
 *
 * ⚠ MAKING ONE ASKS FOR NO NAME. Onboarding's first step is the workspace's
 * name, so a name typed here would be asked again a screen later. It is made
 * with a placeholder and named there - the console's switcher does the same.
 *
 * ⚠ IT CHOOSES AND STOPS; IT NEVER LEAVES. Choosing resolves this task, and a
 * session can owe another (`setup-mfa`) - the panel then renders that one, or
 * leaves for the console once none is left. Leaving from here skipped it.
 */
export function ChooseWorkspace() {
  const clerk = useClerk()
  const { user } = useUser()
  const { isLoaded, setActive, userMemberships, userInvitations } = useOrganizationList(
    {
      userMemberships: { pageSize: 50 },
      userInvitations: { status: "pending" },
    },
  )
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function choose(id: string, accept?: () => Promise<unknown>) {
    setBusy(id)
    setError(null)
    try {
      await accept?.()
      // Resolves the task; the panel moves on from here.
      await setActive?.({ organization: id })
    } catch {
      setError("That did not work. Try again.")
      setBusy(null)
    }
  }

  async function create() {
    setBusy("new")
    setError(null)
    try {
      const made = await clerk.createOrganization({
        name: placeholderName(user?.firstName),
      })
      await setActive?.({ organization: made.id })
    } catch {
      setError("Could not create a workspace. Try again.")
      setBusy(null)
    }
  }

  const memberships = userMemberships.data ?? []
  const invitations = userInvitations.data ?? []

  return (
    <div className="flex flex-col gap-6">
      <StepHeading title="Choose a workspace">
        Pick where to go, or start a new one.
      </StepHeading>
      {!isLoaded ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {memberships.map((m) => (
            <Row
              key={m.id}
              name={m.organization.name}
              image={m.organization.hasImage ? m.organization.imageUrl : undefined}
              detail={m.roleName}
              busy={busy === m.organization.id}
              disabled={busy !== null}
              onClick={() => void choose(m.organization.id)}
            />
          ))}
          {invitations.map((invitation) => (
            <Row
              key={invitation.id}
              name={invitation.publicOrganizationData.name}
              image={
                invitation.publicOrganizationData.hasImage
                  ? invitation.publicOrganizationData.imageUrl
                  : undefined
              }
              detail="Invited - join"
              busy={busy === invitation.publicOrganizationData.id}
              disabled={busy !== null}
              onClick={() =>
                void choose(invitation.publicOrganizationData.id, () =>
                  invitation.accept(),
                )
              }
            />
          ))}
          <li>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void create()}
              className="flex w-full items-center gap-3 rounded-2xl border border-dashed px-4 py-3 text-sm text-muted-foreground transition-colors duration-(--duration-fast) hover:border-[var(--border-strong)] hover:text-foreground disabled:opacity-60"
            >
              <span className="grid size-9 place-items-center rounded-lg bg-muted">
                {busy === "new" ? <Spinner /> : <Plus className="size-4" aria-hidden />}
              </span>
              Create a workspace
            </button>
          </li>
        </ul>
      )}
      {error && <p className="text-center text-sm text-danger">{error}</p>}
    </div>
  )
}

function Row({
  name,
  image,
  detail,
  busy,
  disabled,
  onClick,
}: {
  name: string
  image?: string
  detail: string
  busy: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-start transition-colors duration-(--duration-fast) hover:bg-muted/50 disabled:opacity-60"
      >
        <Avatar name={name} src={image} className="rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        </span>
        {busy ? (
          <Spinner />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        )}
      </button>
    </li>
  )
}

/** "Mohamed's workspace" until onboarding names it. */
export function placeholderName(firstName: string | null | undefined): string {
  return firstName?.trim() ? `${firstName.trim()}'s workspace` : "New workspace"
}
