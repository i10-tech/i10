"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@repo/ui/components/button/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { deleteSsoConnection } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoConnection } from "@/lib/sso-types"
import { useSsoCall } from "../shared"

export function DeleteDraft({ connection }: { connection: SsoConnection }) {
  const call = useSsoCall()
  const router = useRouter()
  const [deleting, setDeleting] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  if (connection.status !== "draft") return null

  return (
    <div className="pt-8 border-t border-border flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">Delete this draft</p>
        <p className="text-xs text-muted-foreground">
          Remove this draft connection and all of its settings.
        </p>
      </div>
      <Button
        variant="danger"
        size="sm"
        disabled={busy}
        onClick={() => setDeleting(true)}
      >
        Delete draft
      </Button>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => !open && setDeleting(false)}
        title="Delete this draft?"
        description="It is removed for good, with its settings and test runs. The audit log keeps a record."
        confirmLabel="Delete"
        doneLabel="Deleted"
        destructive
        onConfirm={async () => {
          setBusy(true)
          try {
            const deleted = await call(() => deleteSsoConnection(connection.id), {
              title: "Could not delete the connection",
            })
            if (!deleted) return false
            toastDone("Connection deleted")
            router.push("/settings/sso")
            router.refresh()
            return true
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}
