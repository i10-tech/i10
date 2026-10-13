"use client"

import * as React from "react"
import { Alert } from "@repo/ui/components/alert/alert"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import type { KeyImpact } from "@/components/transfer-domain-dialog"
import { moveDomain } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"

/**
 * Moving a domain into another workspace you are in (2026-10-13).
 *
 * ⚠ A TRANSFER WITH NOBODY TO WAIT FOR. Both ends are yours, so there is no
 * offer to email and no inbox to accept from: the domain moves when you
 * confirm, with its records and verification, and your DNS does not change.
 *
 * ⚠ THE SAME FRICTION AS A TRANSFER, IN THE SAME ORDER - the name typed out,
 * then the step-up, then the request - because the domain leaves this
 * workspace as surely as if it were deleted. And the keys it changes are
 * spelled out first, as the transfer does.
 */
export function MoveDomainDialog({
  id,
  name,
  targets,
  keys = [],
  open,
  onOpenChange,
  onMoved,
}: {
  id: string
  name: string
  /** The other workspaces this person is in. */
  targets: { id: string; name: string }[]
  keys?: KeyImpact[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onMoved: () => void
}) {
  const stepUp = useStepUp()
  const [workspace, setWorkspace] = React.useState(targets[0]?.id ?? "")
  useResetOnOpen(open, () => setWorkspace(targets[0]?.id ?? ""))
  const chosen = targets.find((t) => t.id === workspace)

  const revoked = keys.filter((k) => k.keeps.length === 0)
  const narrowed = keys.filter((k) => k.keeps.length > 0)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Move ${name}?`}
      description="It moves with its records and verification, so nothing changes in your DNS - and it stops sending from this workspace at once."
      confirmLabel="Move domain"
      doneLabel="Moved"
      confirmWord={name}
      ready={chosen !== undefined}
      onConfirm={async () => {
        if (!chosen) return false
        if (!(await stepUp())) return false
        const result = await moveDomain(id, chosen.id)
        if (!result.ok) {
          toastError("Could not move the domain", { description: result.error })
          return false
        }
        toastDone(`${name} moved to ${chosen.name}`, {
          description: "Switch to that workspace to send from it.",
        })
        onMoved()
        return true
      }}
    >
      <MorphSelect
        label="Move to"
        items={targets.map((t) => ({ value: t.id, label: t.name }))}
        value={workspace}
        onValueChange={setWorkspace}
      />

      {keys.length > 0 && (
        <Alert tone="warning" title="Your API keys here change">
          {revoked.map((key) => (
            <span key={key.id} className="block not-first:mt-1.5">
              <span className="font-medium text-foreground">{key.name}</span> is revoked
              - it only sends from {name}.
            </span>
          ))}
          {narrowed.map((key) => (
            <span key={key.id} className="block not-first:mt-1.5">
              <span className="font-medium text-foreground">{key.name}</span> will only
              send from <span className="font-mono">{key.keeps.join(", ")}</span>, not{" "}
              <span className="font-mono">{name}</span>.
            </span>
          ))}
          <span className="block not-first:mt-1.5">
            Keys never move with a domain - make one in the other workspace to send from
            it there.
          </span>
        </Alert>
      )}
    </ConfirmDialog>
  )
}
