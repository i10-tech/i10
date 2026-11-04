"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { formatExact } from "@/lib/format"
import {
  NEXT_LABEL,
  daysInRange,
  deletionDate,
} from "@/lib/mailbox"
import { useResetOnOpen } from "@/lib/react"
import { chooseMailboxNext } from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type {
  MailboxNext,
  MailboxRow,
  Mailboxes,
  NextChoice,
} from "@/lib/sso-types"
import type { Member } from "./members"
import { useSsoCall } from "./shared"

export const NEXT_HELP: Record<MailboxNext, string> = {
  keep: "The mailbox stays, suspended. Nothing is forwarded or deleted.",
  forward_manager: "New mail is copied to their manager. The mailbox is kept.",
  delegate: "Someone you pick can open the mailbox and read it.",
  delete: "The mailbox and its mail are deleted on the date you confirm.",
}

export function NextDialog({
  row,
  data,
  members,
  onClose,
  onChosen,
}: {
  row: MailboxRow | null
  data: Mailboxes
  members: Member[] | null
  onClose: () => void
  onChosen: () => Promise<void>
}) {
  const call = useSsoCall()
  const [next, setNext] = React.useState<MailboxNext>("keep")
  const [delegate, setDelegate] = React.useState("")
  const [days, setDays] = React.useState("30")
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const open = row !== null
  const { minDays, maxDays } = data.limits
  const count = Number(days)

  useResetOnOpen(open, () => {
    setNext(row?.next ?? "keep")
    setDelegate(row?.targetUserId ?? "")
    setDays(String(row?.deleteAfterDays ?? data.leavers.days ?? 30))
    setConfirming(false)
    setBusy(false)
  })

  const choice: NextChoice | null =
    next === "delegate"
      ? delegate.trim()
        ? { next, delegateUserId: delegate.trim() }
        : null
      : next === "delete"
        ? daysInRange(count, data.limits)
          ? { next, days: count }
          : null
        : { next }

  async function apply(): Promise<boolean> {
    if (!row || !choice) return false
    setBusy(true)
    try {
      const done = await call(() => chooseMailboxNext(row.userId, choice), {
        title: "Could not save that",
      })
      if (!done) return false
      toastDone("Saved", `${row.address}: ${NEXT_LABEL[choice.next].toLowerCase()}.`)
      await onChosen()
      return true
    } finally {
      setBusy(false)
    }
  }

  const when = next === "delete" ? deletionDate(count, new Date()) : null

  return (
    <>
      <Dialog open={open && !confirming} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent
          title="What happens to this mailbox?"
          description={row ? `${row.address} was switched off by a directory.` : ""}
          style={{ width: "min(calc(100vw - 2rem), 480px)" }}
        >
          <div className="space-y-4 py-4">
            <RadioCards
              aria-label="What happens next"
              layout="list"
              value={next}
              onValueChange={(v) => setNext(v as MailboxNext)}
              options={(Object.keys(NEXT_LABEL) as MailboxNext[]).map((n) => ({
                value: n,
                label: NEXT_LABEL[n],
                description: NEXT_HELP[n],
              }))}
            />
            <Reveal show={next === "delegate"} spacing="pt-2">
              {members && members.length > 0 ? (
                <MorphSelect
                  label="Who can open it"
                  value={delegate || null}
                  onValueChange={setDelegate}
                  items={members
                    .filter((m) => m.userId !== row?.userId)
                    .map((m) => ({ value: m.userId, label: m.label }))}
                />
              ) : (
                <FloatingInput
                  label="Member's user id"
                  hint="Starts with user_"
                  value={delegate}
                  onChange={(e) => setDelegate(e.target.value)}
                />
              )}
            </Reveal>
            <Reveal show={next === "delete"} spacing="pt-2">
              <FloatingInput
                label="Days before deleting"
                type="number"
                inputMode="numeric"
                min={minDays}
                max={maxDays}
                value={days}
                state={daysInRange(count, data.limits) ? "idle" : "invalid"}
                hint={`${minDays} to ${maxDays} days from now.`}
                onChange={(e) => setDays(e.target.value)}
              />
            </Reveal>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!choice}
              variant={next === "delete" ? "danger" : "primary"}
              onClick={() => (next === "delete" ? setConfirming(true) : void apply())}
            >
              {next === "delete" ? "Continue" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={open && confirming}
        onOpenChange={(o) => {
          if (!o) setConfirming(false)
        }}
        title="Delete this mailbox?"
        description={
          row && when
            ? `${row.address} and all its mail will be deleted on ${formatExact(when.toISOString())}. Until then you can change your mind here.`
            : ""
        }
        confirmLabel="Delete on that date"
        doneLabel="Scheduled"
        onConfirm={apply}
      />
    </>
  )
}
