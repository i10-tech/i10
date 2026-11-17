"use client"

import * as React from "react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  deleteMailbox,
  restoreMailbox,
  retryMailboxExport,
  resumeMailbox,
  setMailboxStorage,
  suspendMailbox,
  type ActionResult,
} from "@/lib/actions"
import { formatBytes } from "@/lib/format"
import { gigabytesToBytes, storageProblem } from "@/lib/mailbox-create"
import {
  DELETE_GRACE_DAYS,
  forwardTargets,
  gigabytesText,
  mailboxActionRefusal,
  refusalTitle,
  type ConsoleMailbox,
  type DeletionOutcome,
  type MailboxAction,
  type StoragePool,
} from "@/lib/mailbox-view"
import { resumeNote } from "@/lib/mailbox"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen, useResetWhen } from "@/lib/react"
import type { LoginBlock } from "@/lib/sso-types"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastNote } from "@/lib/toast"

/** What a resume answered with nothing still blocking; one shared value, not a new array per call. */
const NO_BLOCKS: readonly LoginBlock[] = []

/**
 * Every owner or admin action on a mailbox, from wherever it is started: the
 * mailbox's own page and the list's row menu.
 *
 * ⚠ ONE SET OF DIALOGS, TWO WAYS IN, for the reason `DeleteDomainDialog` gives:
 * two copies of a destructive flow drift, and the drift is invisible until
 * somebody deletes from the list and gets a conversation the page never had.
 * Callers own the trigger (a button, a menu item) and nothing else.
 *
 * ⚠ THE DIALOGS STAY MOUNTED AFTER THEIR ACTION SUCCEEDS, which is the reason
 * for the hook: a suspend flips the status, the page re-renders and the
 * "Suspend" button is replaced by "Resume", and a dialog mounted inside that
 * button would be unmounted mid-tick. Here the open state lives above whatever
 * the status decides to render.
 *
 * ⚠ EVERY REFUSAL IS SAID IN THE DIALOG AS AN ALERT, NOT IN A TOAST, as in
 * `CreateMailbox`: it sits beside the fields it is about, the dialog stays open
 * with everything chosen, and it is announced. Only a success is a toast.
 */
export function useMailboxActions({
  mailboxes,
  pool,
}: {
  /** The mailbox acted on, and the others a deleted one can forward to. */
  mailboxes: readonly ConsoleMailbox[]
  /** The storage pool, for the storage dialog. Null where it was not read. */
  pool: StoragePool | null
}) {
  const [request, setRequest] = React.useState<{
    action: MailboxAction
    address: string
    open: boolean
  } | null>(null)

  const mailbox = request ? mailboxes.find((m) => m.address === request.address) : null

  // ⚠ CLOSING KEEPS THE REQUEST, SO THE DIALOG PLAYS ITS EXIT WITH ITS CONTENT.
  const onOpenChange = (open: boolean) => setRequest((r) => (r ? { ...r, open } : r))

  const dialogs =
    request && mailbox ? (
      <MailboxActionDialog
        action={request.action}
        mailbox={mailbox}
        mailboxes={mailboxes}
        pool={pool}
        open={request.open}
        onOpenChange={onOpenChange}
      />
    ) : null

  return {
    start: (action: MailboxAction, address: string) =>
      setRequest({ action, address, open: true }),
    dialogs,
  }
}

function MailboxActionDialog({
  action,
  mailbox,
  mailboxes,
  pool,
  open,
  onOpenChange,
}: {
  action: MailboxAction
  mailbox: ConsoleMailbox
  mailboxes: readonly ConsoleMailbox[]
  pool: StoragePool | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  switch (action) {
    case "storage":
      return (
        <StorageDialog
          mailbox={mailbox}
          pool={pool}
          open={open}
          onOpenChange={onOpenChange}
        />
      )
    case "suspend":
      return (
        <LifecycleDialog
          action="suspend"
          open={open}
          onOpenChange={onOpenChange}
          title={`Suspend ${mailbox.address}?`}
          description="The person can no longer sign in to this mailbox. Mail keeps arriving and nothing is deleted. You can resume it at any time."
          confirmLabel="Suspend mailbox"
          doneLabel="Suspended"
          run={() => suspendMailbox(mailbox.address)}
        />
      )
    case "resume":
      return (
        <LifecycleDialog
          action="resume"
          open={open}
          onOpenChange={onOpenChange}
          title={`Resume ${mailbox.address}?`}
          description="The person can sign in to this mailbox again. If something else still blocks their sign-in, such as an unpaid plan, we tell you what."
          confirmLabel="Resume mailbox"
          doneLabel="Resumed"
          run={() => resumeMailbox(mailbox.address)}
          onDone={(data) => {
            const blocks = data.still_blocked ?? NO_BLOCKS
            // ⚠ A RESUME THAT LEFT SOMETHING BLOCKING IS SAID, NOT CELEBRATED:
            // "resumed" on its own reads as a sign-in that works.
            if (blocks.length > 0) {
              toastNote(
                "Resumed, but it cannot sign in yet",
                resumeNote(mailbox.address, blocks),
              )
            } else {
              toastDone("Mailbox resumed", resumeNote(mailbox.address, blocks))
            }
          }}
        />
      )
    case "restore":
      return (
        <LifecycleDialog
          action="restore"
          open={open}
          onOpenChange={onOpenChange}
          title={`Restore ${mailbox.address}?`}
          description="The mailbox comes back as it was, and the person can sign in again right away."
          confirmLabel="Restore mailbox"
          doneLabel="Restored"
          run={() => restoreMailbox(mailbox.address)}
          onDone={() =>
            toastDone("Mailbox restored", `${mailbox.address} can sign in again.`)
          }
        />
      )
    case "retry_export":
      return (
        <LifecycleDialog
          action="retry_export"
          open={open}
          onOpenChange={onOpenChange}
          title={`Start the export of ${mailbox.address} again?`}
          description="We export all its mail again and make it downloadable. The mailbox is erased only after this export has finished and its download window has passed."
          confirmLabel="Start export"
          doneLabel="Started"
          run={() => retryMailboxExport(mailbox.address)}
          onDone={() =>
            toastDone("Export started", `We are exporting ${mailbox.address} again.`)
          }
        />
      )
    case "delete":
      return (
        <DeleteDialog
          mailbox={mailbox}
          mailboxes={mailboxes}
          open={open}
          onOpenChange={onOpenChange}
        />
      )
  }
}

/**
 * The shape every confirm-and-ask dialog here shares: prove it is you, call the
 * API, and put a refusal in the dialog.
 *
 * ⚠ THE STEP-UP COMES BEFORE THE CALL AND ITS DECLINE LEAVES THE DIALOG OPEN WITH
 * NOTHING DONE, as in `DeleteDomainsDialog`. The API refuses a stale session on
 * its own, so this is the prompt, not the protection.
 */
function LifecycleDialog<T>({
  action,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  doneLabel,
  destructive = false,
  confirmWord,
  ready,
  initialFocus,
  run,
  onDone,
  editKey,
  children,
}: {
  action: MailboxAction
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  doneLabel: string
  destructive?: boolean
  confirmWord?: string
  ready?: boolean
  initialFocus?: string
  run: () => Promise<ActionResult<T>>
  onDone?: (data: T) => void
  /** Changes when the person edits a choice, which retires the last refusal: it was about the old one. */
  editKey?: string
  children?: React.ReactNode
}) {
  const stepUp = useStepUp()
  const [refusal, setRefusal] = React.useState<string | null>(null)
  useResetOnOpen(open, () => setRefusal(null))
  useResetWhen(editKey, () => setRefusal(null))

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      doneLabel={doneLabel}
      destructive={destructive}
      confirmWord={confirmWord}
      ready={ready}
      initialFocus={initialFocus}
      onConfirm={async () => {
        setRefusal(null)
        if (!(await stepUp())) return false
        const result = await run()
        if (!result.ok) {
          setRefusal(mailboxActionRefusal(result, action))
          return false
        }
        onDone?.(result.data)
        return true
      }}
    >
      {children}
      {refusal && (
        <Alert tone="danger" title={refusalTitle(action)}>
          {refusal}
        </Alert>
      )}
    </ConfirmDialog>
  )
}

/**
 * What a deleted mailbox's mail becomes, in the words an admin chooses by.
 *
 * ⚠ NO DEFAULT. Every one of the three stops the sign-in and starts the same 30
 * days, but only one of them keeps the mail, and the one that is pre-selected is
 * the one that gets picked by Enter. The button waits for a choice.
 */
const OUTCOMES: { value: DeletionOutcome; label: string; description: string }[] = [
  {
    value: "delete",
    label: "Delete everything",
    description: `After ${DELETE_GRACE_DAYS} days the mailbox, all its mail and the address are erased for good.`,
  },
  {
    value: "export_then_delete",
    label: "Export first, then delete",
    description: `We export all its mail now, and the export becomes downloadable. After ${DELETE_GRACE_DAYS} days the mailbox is erased, once the export has finished and its download window has passed.`,
  },
  {
    value: "forward",
    label: "Forward to another mailbox",
    description: `After ${DELETE_GRACE_DAYS} days the mailbox is erased, but the address and all its aliases stay and deliver to a mailbox you pick.`,
  },
]

function DeleteDialog({
  mailbox,
  mailboxes,
  open,
  onOpenChange,
}: {
  mailbox: ConsoleMailbox
  mailboxes: readonly ConsoleMailbox[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [outcome, setOutcome] = React.useState<DeletionOutcome | null>(null)
  const [target, setTarget] = React.useState<string | null>(null)
  useResetOnOpen(open, () => {
    setOutcome(null)
    setTarget(null)
  })

  const targets = forwardTargets(mailboxes, mailbox.address)
  const options = OUTCOMES.map((option) =>
    option.value === "forward" && targets.length === 0
      ? {
          ...option,
          disabled: true,
          disabledReason:
            "No other mailbox in this workspace can receive mail right now.",
        }
      : option,
  )
  const ready = outcome !== null && (outcome !== "forward" || target !== null)

  return (
    <LifecycleDialog
      action="delete"
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${mailbox.address}?`}
      description={`Sign-in stops right away. You can restore the mailbox for ${DELETE_GRACE_DAYS} days, and mail keeps arriving until then. Choose what happens after that.`}
      confirmLabel="Delete mailbox"
      doneLabel="Deleted"
      destructive
      confirmWord={mailbox.address}
      ready={ready}
      // ⚠ NOT THE TYPE-THE-ADDRESS FIELD, WHICH IS WHAT ConfirmDialog FOCUSES BY
      // DEFAULT: the choice above it comes first, so focus goes to the first
      // control in the dialog by naming an id that is not there.
      initialFocus="mailbox-delete-outcome"
      editKey={`${outcome}|${target}`}
      run={() =>
        deleteMailbox(mailbox.address, {
          outcome: outcome ?? "delete",
          ...(outcome === "forward" && target ? { forward_to: target } : {}),
        })
      }
    >
      <div className="space-y-4">
        <RadioCards
          aria-label="What happens to the mail"
          layout="list"
          options={options}
          value={outcome}
          onValueChange={(value) => setOutcome(value as DeletionOutcome)}
        />
        {outcome === "forward" && (
          <MorphSelect
            label="Forward to"
            items={targets.map((m) => ({
              value: m.address,
              label: m.address,
              keywords: [m.owner.name, m.displayName].filter(Boolean).join(" "),
              ...(m.owner.name ? { meta: m.owner.name } : {}),
            }))}
            value={target}
            onValueChange={setTarget}
            searchable={targets.length > 6}
            placeholder="Choose a mailbox"
          />
        )}
      </div>
    </LifecycleDialog>
  )
}

/**
 * A mailbox's share of the storage pool.
 *
 * ⚠ THE MOST IT CAN TAKE IS WHAT THE POOL HAS LEFT PLUS WHAT IT HOLDS NOW. The
 * API replaces this mailbox's allocation, not adds to it, so checking against
 * `remaining` alone would refuse keeping a mailbox at its own size.
 *
 * ⚠ EMPTY MEANS "NO CAP" ONLY ON PAY AS YOU GO. On a prepaid pool every mailbox
 * needs a number, so the field is required there and the hint says so.
 */
function StorageDialog({
  mailbox,
  pool,
  open,
  onOpenChange,
}: {
  mailbox: ConsoleMailbox
  pool: StoragePool | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const stepUp = useStepUp()
  const outcome = useOutcome()
  const current = mailbox.storage.allocatedBytes
  const initial = gigabytesText(current)
  const [text, setText] = React.useState(initial)
  const [refusal, setRefusal] = React.useState<string | null>(null)

  useResetOnOpen(open, () => {
    outcome.reset()
    setText(gigabytesText(mailbox.storage.allocatedBytes))
    setRefusal(null)
  })

  const required = pool?.kind === "pool"
  const most =
    pool?.kind === "pool" && pool.remaining !== null
      ? pool.remaining + (current ?? 0)
      : null
  const bytes = gigabytesToBytes(text)
  const empty = text.trim() === ""

  const valid = empty ? !required : storageProblem(text, most, formatBytes) === null
  const ready = valid && text.trim() !== initial

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle" || !ready) return
    setRefusal(null)

    await outcome.run(
      async () => {
        if (!(await stepUp())) return false
        const result = await setMailboxStorage(mailbox.address, empty ? null : bytes)
        if (!result.ok) {
          setRefusal(mailboxActionRefusal(result, "storage"))
          return false
        }
        toastDone(
          "Storage updated",
          result.data.quota === "deferred"
            ? "Saved. The mail server picks up the new limit shortly."
            : `${mailbox.address} now has ${empty ? "no storage limit" : formatBytes(bytes ?? 0)}.`,
        )
        return true
      },
      () => onOpenChange(false),
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={outcome.state === "pending" ? () => {} : onOpenChange}
    >
      <DialogContent
        title="Change storage"
        description={`How much of your storage pool ${mailbox.address} can use.`}
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <form onSubmit={submit} {...outcome.formProps}>
          <div className="space-y-4 py-4">
            <ValidatedInput
              id="mailbox-storage-allocation"
              label={required ? "Storage in GB" : "Storage limit in GB (optional)"}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setRefusal(null)
              }}
              inputMode="decimal"
              autoComplete="off"
              check={(value) =>
                value.trim() === "" ? null : storageProblem(value, most, formatBytes)
              }
              required={
                required
                  ? "Enter how much storage this mailbox gets, like 5."
                  : undefined
              }
              hint={
                required
                  ? most === null
                    ? "Taken from your storage pool."
                    : `Up to ${formatBytes(most)}: what is left in your pool plus what this mailbox has now.`
                  : "Leave it empty for no limit. You pay for what the mailbox uses."
              }
            />
            {refusal && (
              <Alert tone="danger" title={refusalTitle("storage")}>
                {refusal}
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={outcome.state === "pending"}
            >
              Cancel
            </Button>
            <StateButton
              type="submit"
              state={outcome.state}
              pendingLabel="Save storage"
              doneLabel="Saved"
              disabled={!ready}
            >
              Save storage
            </StateButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
