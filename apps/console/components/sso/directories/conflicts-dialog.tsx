"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { useResetOnOpen } from "@/lib/react"
import { directoryConflicts, retryDirectoryUser } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { DirectoryConflict, SsoDirectory } from "@/lib/sso-types"
import type { useSsoCall } from "../shared"

export function ConflictsDialog({
  directory,
  open,
  onOpenChange,
  call,
  reload,
}: {
  directory: SsoDirectory
  open: boolean
  onOpenChange: (open: boolean) => void
  call: ReturnType<typeof useSsoCall>
  reload: () => Promise<void>
}) {
  const [rows, setRows] = React.useState<DirectoryConflict[] | null>(null)
  useResetOnOpen(open, () => setRows(null))

  React.useEffect(() => {
    if (!open) return
    let live = true
    void directoryConflicts(directory.id).then((r) => {
      if (live) setRows(r.ok ? r.data.data : [])
    })
    return () => {
      live = false
    }
  }, [open, directory.id])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Conflicts"
        description="People your directory sends that could not be fully applied, and why. Fix the cause, then retry."
        style={{ width: "min(calc(100vw - 2rem), 560px)" }}
      >
        <div className="max-h-96 overflow-auto py-4">
          {rows === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conflicts.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {row.displayName ?? row.userName}
                      {row.email ? ` (${row.email})` : ""}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.conflict ?? "Waiting to be applied"}
                      {row.deleted ? " - removed in the directory" : ""}
                    </span>
                  </span>
                  {!row.active && <Badge size="sm">Inactive</Badge>}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      const ok = await call(
                        () => retryDirectoryUser(directory.id, row.id),
                        {
                          stepUp: false,
                          title: "Could not retry",
                        },
                      )
                      if (ok) {
                        toastDone("Retrying")
                        await reload()
                      }
                    }}
                  >
                    Retry
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
