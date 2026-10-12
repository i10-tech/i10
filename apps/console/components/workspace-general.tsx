"use client"

import * as React from "react"
import { useAuth, useClerk, useOrganization } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { TextMorph } from "@repo/ui/components/text-morph/text-morph"
import {
  ProfileBlock,
  ProfileRow,
  clerkReason,
  useFollowOpen,
} from "@/components/account/shared"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DeletionWarning } from "@/components/deletion-warning"
import { PhotoField } from "@/components/photo-field"
import { renameWorkspace } from "@/lib/actions"
import { formatExact } from "@/lib/format"
import { useReverify } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"
import type { BillingState } from "@/lib/types"
import { announceWorkspaceName } from "@/lib/workspace-name"

/**
 * General settings, drawn like the account page (2026-10-12): the same
 * blocks and rows, and a workspace profile that opens the way your own
 * profile does - the logo and name in one card that takes a dropped image
 * anywhere on it. What Clerk's `<OrganizationProfile />` "General" page was.
 */
export function WorkspaceGeneral({
  tenant,
  billing,
}: {
  tenant: { id: string; slug: string; name: string; created_at: string } | null
  billing: BillingState | null
}) {
  const { organization } = useOrganization()
  const { has } = useAuth()
  const canEdit = has?.({ permission: "org:sys_profile:manage" }) ?? false
  const canDelete = has?.({ permission: "org:sys_profile:delete" }) ?? false

  return (
    <div>
      <ProfileBlock title="Workspace">
        <ProfileRow label="Profile">
          <WorkspaceProfile
            current={tenant?.name ?? organization?.name ?? ""}
            editable={canEdit}
          />
        </ProfileRow>
        <ProfileRow label="Identifiers">
          <div className="grid max-w-md gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Workspace ID</p>
              <CopyField value={tenant?.id ?? "-"} label="Copy workspace ID" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Slug</p>
              <CopyField value={tenant?.slug ?? "-"} label="Copy slug" />
            </div>
            <p className="text-xs text-muted-foreground">
              Quote the workspace ID if you ever contact support - it is what we look
              you up by.
            </p>
          </div>
        </ProfileRow>
        <ProfileRow label="Created">
          <p className="pt-1.5 text-sm text-muted-foreground">
            {tenant ? formatExact(tenant.created_at) : "-"}
          </p>
        </ProfileRow>
      </ProfileBlock>

      {canDelete && organization && (
        <ProfileBlock title="Danger zone">
          <ProfileRow label="Delete workspace">
            <DeleteWorkspace name={organization.name} billing={billing} />
          </ProfileRow>
        </ProfileBlock>
      )}
    </div>
  )
}

/**
 * The workspace's logo and name - your profile row's twin: the two shown,
 * "Update workspace" opening one card with both, the whole card a drop zone,
 * and Save only for a changed name, since the logo saves itself.
 */
function WorkspaceProfile({
  current,
  editable,
}: {
  current: string
  editable: boolean
}) {
  const { organization } = useOrganization()
  const [open, setOpen] = React.useState(false)
  // The name as last saved; the server prop stays as it rendered.
  const [saved, setSaved] = React.useState(current)
  const [name, setName] = React.useState(current)
  const [saving, setSaving] = React.useState(false)
  const follow = useFollowOpen<HTMLFormElement>(open)
  if (!organization) return null
  const org = organization

  function begin() {
    setName(saved)
    setOpen(true)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const next = name.trim()
    if (!next || next === saved) return
    setSaving(true)
    try {
      const result = await renameWorkspace(next)
      if (!result.ok) {
        toastError("Could not rename the workspace", { description: result.error })
        return
      }
      setSaved(next)
      // The breadcrumb's copy, and Clerk's, which the switcher reads.
      announceWorkspaceName(next)
      await org.reload()
      toastDone("Workspace updated")
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const logo = org.hasImage ? org.imageUrl : undefined
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={saved} src={logo} size="lg" className="rounded-xl" />
          <span className="truncate text-sm font-medium">
            <TextMorph>{saved}</TextMorph>
          </span>
        </span>
        {editable && !open && (
          <Button variant="ghost" size="sm" onClick={begin}>
            Update workspace
          </Button>
        )}
      </div>

      <Reveal show={open} spacing="pt-5">
        <form ref={follow} onSubmit={save} className="scroll-mb-6 rounded-2xl border">
          <PhotoField
            name={saved}
            src={logo}
            shape="square"
            className="flex flex-col gap-7 p-4"
            onUpload={async (file) => {
              try {
                await org.setLogo({ file })
                toastDone("Logo updated")
                // Finished, as a saved name is: the card closes.
                setOpen(false)
              } catch (error) {
                toastError("Could not upload that logo", clerkReason(error))
                throw error
              }
            }}
            onRemove={async () => {
              try {
                await org.setLogo({ file: null })
              } catch (error) {
                toastError("Could not remove the logo", clerkReason(error))
              }
            }}
          >
            <FloatingInput
              id="workspace-name"
              label="Workspace name"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              hint="On your invoices, and in the workspace switcher for everyone."
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={saving}
                // Only a changed name wakes it; the logo saves on its own.
                disabled={!name.trim() || name.trim() === saved}
              >
                Save
              </Button>
            </div>
          </PhotoField>
        </form>
      </Reveal>
    </div>
  )
}

/**
 * Deleting the workspace, here rather than behind a link to the Team page:
 * typed confirmation, the step-up, and what it does to the bill said in the
 * dialog where the decision is made, as the account's delete does.
 */
function DeleteWorkspace({
  name,
  billing,
}: {
  name: string
  billing: BillingState | null
}) {
  const { organization } = useOrganization()
  const clerk = useClerk()
  const router = useRouter()
  const reverify = useReverify()
  const [open, setOpen] = React.useState(false)
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Delete this workspace, its domains, keys, contacts and every message it has
        sent.
      </p>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Delete workspace
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete workspace"
        description="There is no undo and no export afterwards."
        confirmLabel="Delete workspace"
        doneLabel="Deleted"
        confirmWord={name}
        onConfirm={async () => {
          if (!organization) return false
          try {
            const done = await reverify(() => organization.destroy())
            if (done === null) return false
            await clerk.setActive({ organization: null })
            router.push("/")
            return true
          } catch (error) {
            toastError("Could not delete the workspace", clerkReason(error))
            return false
          }
        }}
      >
        <DeletionWarning billing={billing} scope="workspace" />
      </ConfirmDialog>
    </div>
  )
}
