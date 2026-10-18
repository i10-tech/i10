"use client"

import * as React from "react"
import { useOrganizationList } from "@clerk/nextjs"
import { ChevronRight } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { StepHeading } from "../../_components/step-heading"

/**
 * Clerk's `choose-organization` task, ours (2026-10-12) - what
 * `<TaskChooseOrganization />` was: the workspaces you belong to and the ones
 * you are invited to.
 *
 * ⚠ IT MAKES NO WORKSPACE (#325). It used to make one with a placeholder name
 * on a click, which is exactly the workspace nobody asked for. Clerk raises
 * this task only while "membership required" is on, and it is off: somebody
 * with no workspace goes straight to the console, whose onboarding is where
 * one is named (or Personal picked) and created. Turning that setting back on
 * would strand anybody with no workspace here.
 *
 * ⚠ IT CHOOSES AND STOPS; IT NEVER LEAVES. Choosing resolves this task, and a
 * session can owe another (`setup-mfa`) - the panel then renders that one, or
 * leaves for the console once none is left. Leaving from here skipped it.
 */
export function ChooseWorkspace() {
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

  const memberships = userMemberships.data ?? []
  const invitations = userInvitations.data ?? []

  /*
   * ⚠ ONE WORKSPACE AND NOTHING TO ACCEPT IS NOT A CHOICE (2026-10-13). The
   * list would hold a single row to press, so it is pressed for them and the
   * panel reads as the sign-in finishing. A failure falls back to the list.
   */
  const only =
    isLoaded &&
    !userMemberships.isLoading &&
    !userInvitations.isLoading &&
    !userMemberships.hasNextPage &&
    memberships.length === 1 &&
    invitations.length === 0
      ? memberships[0]!.organization.id
      : null
  const autoChosen = React.useRef(false)
  React.useEffect(() => {
    if (!only || autoChosen.current) return
    autoChosen.current = true
    void choose(only)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the one workspace
  }, [only])

  if (only && error === null) {
    return (
      <div className="flex min-h-40 items-center justify-center" aria-live="polite">
        <TextShimmer className="text-sm text-muted-foreground">
          Finishing sign-in
        </TextShimmer>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <StepHeading title="Choose a workspace">Pick where to go.</StepHeading>
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
