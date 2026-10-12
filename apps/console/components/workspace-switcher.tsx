"use client"

import * as React from "react"
import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, Plus, Settings } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
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
import { toastDone, toastError } from "@/lib/toast"

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
  const { isLoaded, setActive, userMemberships, userInvitations, userSuggestions } =
    useOrganizationList({
      userMemberships: { pageSize: 50 },
      userInvitations: { status: "pending" },
      userSuggestions: { status: "pending" },
    })
  const [creating, setCreating] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)

  if (!isLoaded) {
    return <Skeleton className="h-7 w-full rounded-md" />
  }

  async function switchTo(id: string) {
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
  const suggestions = (userSuggestions.data ?? []).filter((s) => s.status === "pending")
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
        <DropdownMenuContent align="start" className="w-72">
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
                  key={suggestion.id}
                  disabled={busy !== null}
                  onSelect={async () => {
                    try {
                      await suggestion.accept()
                      await userSuggestions.revalidate?.()
                      toastDone(
                        `Asked to join ${suggestion.publicOrganizationData.name}`,
                        "An admin there will let you in.",
                      )
                    } catch (error) {
                      toastError("Could not ask to join", clerkReason(error))
                    }
                  }}
                >
                  <Avatar
                    name={suggestion.publicOrganizationData.name}
                    src={
                      suggestion.publicOrganizationData.hasImage
                        ? suggestion.publicOrganizationData.imageUrl
                        : undefined
                    }
                    size="sm"
                    className="rounded-md"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {suggestion.publicOrganizationData.name}
                  </span>
                  <span className="text-xs text-muted-foreground">Request to join</span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus aria-hidden />
            Create workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

/** Clerk's create-organization screen, ours: a name, then set-up. */
function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const clerk = useClerk()
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await clerk.createOrganization({ name: name.trim() })
      await clerk.setActive({ organization: created.id })
      onOpenChange(false)
      setName("")
      router.push("/onboarding")
      router.refresh()
    } catch (error) {
      setError(clerkReason(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Create workspace"
        description="A workspace has its own domains, keys, contacts and bill. You can invite people to it next."
      >
        <form noValidate onSubmit={create} className="flex flex-col gap-7">
          <FloatingInput
            id="create-workspace-name"
            label="Workspace name"
            value={name}
            onChange={(event) => {
              setError(null)
              setName(event.target.value)
            }}
            hint={error ?? undefined}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Create workspace
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
