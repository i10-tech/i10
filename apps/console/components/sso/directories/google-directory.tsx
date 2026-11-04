"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import { describeGoogleError } from "@/lib/google-directory-errors"
import { checkDirectory, confirmDirectoryRemovals } from "@/lib/sso-actions"
import { toastDone, toastError } from "@/lib/toast"
import type { GoogleCheckResult, SsoAbilities, SsoDirectory } from "@/lib/sso-types"
import type { useSsoCall } from "../shared"

export function GoogleDirectory({
  directory,
  abilities,
  call,
  reload,
}: {
  directory: SsoDirectory
  abilities: SsoAbilities
  call: ReturnType<typeof useSsoCall>
  reload: () => Promise<void>
}) {
  const [checking, setChecking] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)

  const refusedRemovals =
    directory.lastSyncError === "large_drop"
      ? directory.lastSyncDetail?.removedUsers
      : undefined
  const canConfirmRemovals = abilities.owner && refusedRemovals !== undefined

  return (
    <div className="space-y-3">
      {directory.google && !directory.google.available && (
        <p className="text-sm text-muted-foreground">
          {directory.google.unavailableReason}
        </p>
      )}

      {directory.google?.available && directory.google.clientId && (
        <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3">
          <p className="text-xs font-medium text-foreground">
            In your Google Admin console, authorise this client for domain-wide
            delegation with the scopes below.
          </p>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Client ID</span>
            <CopyField value={directory.google.clientId} />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Scopes</span>
            <CopyField value={directory.google.scopes.join(",")} />
          </div>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Acting as {directory.adminEmail ?? "-"} for {directory.domain ?? "-"}.{" "}
        {directory.lastSyncAt ? (
          <>
            Last pull <Time iso={directory.lastSyncAt} />
            {directory.lastSyncStatus ? `: ${directory.lastSyncStatus}` : ""}.
          </>
        ) : (
          "Not pulled yet."
        )}
      </p>

      {directory.enabled && directory.liveUpdates === false && (
        <p className="text-sm text-muted-foreground">
          Live updates off, changes arrive within 15 minutes.
        </p>
      )}

      {(directory.lastSyncError || directory.lastSyncStatus === "failed") && (
        <p className="text-sm text-destructive">
          {describeGoogleError(directory.lastSyncError, {
            clientId: directory.google?.clientId,
            scopes: directory.google?.scopes,
            missingScopes: directory.lastSyncDetail?.missingScopes,
            removedUsers: directory.lastSyncDetail?.removedUsers,
            existingUsers: directory.lastSyncDetail?.existingUsers,
            canConfirmRemovals,
          })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={checking}
          onClick={async () => {
            setChecking(true)
            try {
              const result = await call(() => checkDirectory(directory.id), {
                stepUp: false,
                title: "Could not check access",
              })
              if (!result) return
              const checked: GoogleCheckResult = result
              if (checked.ok) toastDone("Google access works")
              else
                toastError(
                  "Google refused",
                  describeGoogleError(checked.error, {
                    clientId: directory.google?.clientId,
                    scopes: directory.google?.scopes,
                    missingScopes: Array.isArray(checked.missingScopes)
                      ? checked.missingScopes
                      : undefined,
                  }),
                )
            } finally {
              setChecking(false)
            }
          }}
        >
          Check access
        </Button>

        {canConfirmRemovals && (
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Remove {refusedRemovals} {refusedRemovals === 1 ? "person" : "people"}
          </Button>
        )}
      </div>

      {refusedRemovals !== undefined && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Remove ${refusedRemovals} ${refusedRemovals === 1 ? "person" : "people"}?`}
          description={`The next pull from Google removes ${refusedRemovals} ${refusedRemovals === 1 ? "person" : "people"} from this workspace. If more people than that would go, it asks you again. This go-ahead lasts 24 hours.`}
          confirmLabel={`Remove ${refusedRemovals}`}
          doneLabel="Confirmed"
          destructive
          onConfirm={async () => {
            const done = await call(
              () => confirmDirectoryRemovals(directory.id, refusedRemovals),
              { title: "Could not confirm the removals" },
            )
            if (!done) return false
            toastDone("Removals confirmed", "Pulling from Google now.")
            await reload()
            return true
          }}
        />
      )}
    </div>
  )
}
