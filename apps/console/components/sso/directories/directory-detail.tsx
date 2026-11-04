"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { changeDirectory } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoDirectory } from "@/lib/sso-types"
import { DirectoryMail } from "../directory-mail"
import { ToggleRow, type useSsoCall } from "../shared"
import { ConflictsDialog } from "./conflicts-dialog"
import { GoogleDirectory } from "./google-directory"
import { ScimDirectory } from "./scim-directory"

export function DirectoryDetail({
  directory,
  abilities,
  onChange,
  reload,
  call,
}: {
  directory: SsoDirectory
  abilities: SsoAbilities
  onChange: (directory: SsoDirectory) => void
  reload: () => Promise<void>
  call: ReturnType<typeof useSsoCall>
}) {
  const [conflicts, setConflicts] = React.useState(false)
  const isGoogle = directory.provider === "google"

  return (
    <div className="space-y-4 pt-2">
      <ToggleRow
        label="Enabled"
        description={
          directory.enabled
            ? "Changes from your provider are applied."
            : abilities.owner
              ? "Changes are ignored. Enabling it starts applying them."
              : "Only an owner can enable a directory."
        }
        checked={directory.enabled}
        disabled={!directory.enabled && !abilities.owner}
        onChange={async (enabled) => {
          const after = await call(() => changeDirectory(directory.id, { enabled }), {
            title: enabled ? "Could not enable it" : "Could not disable it",
          })
          if (after) {
            onChange({ ...directory, ...after, tokens: directory.tokens })
            toastDone(enabled ? "Directory enabled" : "Directory disabled")
          }
        }}
      />

      <DirectoryMail
        directory={directory}
        abilities={abilities}
        onChange={onChange}
        call={call}
      />

      {isGoogle ? (
        <GoogleDirectory
          directory={directory}
          abilities={abilities}
          call={call}
          reload={reload}
        />
      ) : (
        <ScimDirectory
          directory={directory}
          abilities={abilities}
          call={call}
          reload={reload}
        />
      )}

      {directory.conflicts > 0 && (
        <div className="pt-1">
          <Button variant="secondary" size="sm" onClick={() => setConflicts(true)}>
            {directory.conflicts} {directory.conflicts === 1 ? "conflict" : "conflicts"}
          </Button>
        </div>
      )}

      <ConflictsDialog
        directory={directory}
        open={conflicts}
        onOpenChange={setConflicts}
        call={call}
        reload={reload}
      />
    </div>
  )
}
