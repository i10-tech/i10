"use client"

import * as React from "react"
import { useOrganization, useOrganizationList } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, Plus, Settings } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/i10/menu"
import { SkeletonBlock as Skeleton } from "@repo/ui/components/i10/skeleton-block"
import { TextMorph } from "@repo/ui/components/text-morph/text-morph"
import { clerkReason } from "@/components/account/shared"
import { afterSwitch } from "@/lib/after-switch"
import { useCreateWorkspace } from "@/lib/create-workspace"
import { toastDone, toastError } from "@/lib/toast"
import { useWorkspacesChanged } from "@/lib/workspace-name"
import { useJoinSuggestions } from "@/lib/join-suggestions"

/**
 * The workspace switcher, ours (2026-10-12) - what Clerk's
 * `<OrganizationSwitcher hidePersonal />` was in the rail: the workspace you
 * are in, its logo and name; and on open, that workspace with "Manage", the
 * others you belong to, invitations and suggestions to join, and "Create
 * workspace".
 *
 * ⚠ CLERK STILL ANSWERS WHO BELONGS WHERE. Every list here is Clerk's
 * (`useOrganizationList`), and switching is Clerk's `setActive`; only the
 * drawing and the motion are ours - Arc's menu, with its highlight gliding
 * between rows.
 *
 * ⚠ SWITCHING STAYS ON THE PAGE (2026-10-12), only its context changes: the
 * domains list becomes the other workspace's domains list, settings stay
 * settings. The one exception is a page about ONE thing that belongs to the
 * old workspace - a domain, an email, an endpoint - which the new one does
 * not have and would answer 404 for; those go up to their list. See
 * `afterSwitch`. Creating one still goes to set-up, as Clerk's
 * `afterCreateOrganizationUrl="/onboarding"` did.
 */
export function WorkspaceSwitcher() {
  const router = useRouter()
  const { organization, membership } = useOrganization()
  const { isLoaded, setActive, userMemberships, userInvitations } = useOrganizationList(
    {
      userMemberships: { pageSize: 50 },
      userInvitations: { status: "pending" },
    },
  )
  // Ours, not Clerk's `userSuggestions` - see lib/join-suggestions.
  const joinable = useJoinSuggestions()
  const { creating, create } = useCreateWorkspace()
  const [busy, setBusy] = React.useState<string | null>(null)
  /** A switch closed the menu: focus is not handed back to the trigger. */
  const switched = React.useRef(false)
  // A rename, a logo or a delete elsewhere: Clerk's cached copies are re-read.
  useWorkspacesChanged(() => {
    void organization?.reload().catch(() => {})
    void userMemberships.revalidate?.()
  })

  if (!isLoaded) {
    return <Skeleton className="h-7 w-full rounded-md" />
  }

  async function switchTo(id: string) {
    switched.current = true
    setBusy(id)
    try {
      await setActive?.({ organization: id })
      router.replace(afterSwitch(window.location.pathname, window.location.search))
      router.refresh()
    } catch (error) {
      toastError("Could not switch workspace", clerkReason(error))
    } finally {
      setBusy(null)
    }
  }

  const others = (userMemberships.data ?? []).filter(
    (m) => m.organization.id !== organization?.id,
  )
  const invitations = userInvitations.data ?? []
  const suggestions = (joinable.list ?? []).filter((s) => !s.requested)
  const name = organization?.name ?? "Workspace"

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar-accent"
          >
            <Avatar
              name={name}
              src={organization?.hasImage ? organization.imageUrl : undefined}
              size="sm"
              className="rounded-md"
            />
            {/* A switch glides to the new name rather than cutting to it. */}
            <span className="min-w-0 flex-1 truncate text-start font-medium">
              <TextMorph>{name}</TextMorph>
            </span>
            <ChevronsUpDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-72"
          onCloseAutoFocus={(event) => {
            if (!switched.current) return
            switched.current = false
            event.preventDefault()
          }}
        >
          {organization && (
            <>
              <div className="flex items-center gap-3 px-2 py-2">
                <Avatar
                  name={name}
                  src={organization.hasImage ? organization.imageUrl : undefined}
                  className="rounded-lg"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {membership?.roleName ?? "Member"}
                  </span>
                </span>
              </div>
              <DropdownMenuItem onSelect={() => router.push("/settings")}>
                <Settings aria-hidden />
                Manage
              </DropdownMenuItem>
            </>
          )}

          {others.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
              {others.map((m) => (
                <DropdownMenuItem
                  key={m.organization.id}
                  disabled={busy !== null}
                  onSelect={() => void switchTo(m.organization.id)}
                >
                  <Avatar
                    name={m.organization.name}
                    src={m.organization.hasImage ? m.organization.imageUrl : undefined}
                    size="sm"
                    className="rounded-md"
                  />
                  <span className="truncate">{m.organization.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          {(invitations.length > 0 || suggestions.length > 0) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Join a workspace</DropdownMenuLabel>
              {invitations.map((invitation) => (
                <DropdownMenuItem
                  key={invitation.id}
                  disabled={busy !== null}
                  onSelect={async () => {
                    setBusy(invitation.id)
                    try {
                      await invitation.accept()
                      await userInvitations.revalidate?.()
                      await switchTo(invitation.publicOrganizationData.id)
                    } catch (error) {
                      toastError("Could not join", clerkReason(error))
                      setBusy(null)
                    }
                  }}
                >
                  <Avatar
                    name={invitation.publicOrganizationData.name}
                    src={
                      invitation.publicOrganizationData.hasImage
                        ? invitation.publicOrganizationData.imageUrl
                        : undefined
                    }
                    size="sm"
                    className="rounded-md"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {invitation.publicOrganizationData.name}
                  </span>
                  <span className="text-xs text-muted-foreground">Join</span>
                </DropdownMenuItem>
              ))}
              {suggestions.map((suggestion) => (
                <DropdownMenuItem
                  key={suggestion.tenant_id}
                  disabled={busy !== null}
                  onSelect={async () => {
                    const result = await joinable.ask(suggestion.tenant_id)
                    if (!result.ok) {
                      toastError("Could not ask to join", { description: result.error })
                      return
                    }
                    toastDone(
                      `Asked to join ${suggestion.name}`,
                      "An admin there will let you in.",
                    )
                  }}
                >
                  <Avatar
                    name={suggestion.name}
                    src={suggestion.image_url ?? undefined}
                    size="sm"
                    className="rounded-md"
                  />
                  <span className="min-w-0 flex-1 truncate">{suggestion.name}</span>
                  <span className="text-xs text-muted-foreground">Request to join</span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          <DropdownMenuSeparator />
          {/* No naming dialog: onboarding's first step is the name. */}
          <DropdownMenuItem
            disabled={creating}
            onSelect={() =>
              void create().catch((error: unknown) =>
                toastError("Could not create a workspace", clerkReason(error)),
              )
            }
          >
            <Plus aria-hidden />
            Create workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
