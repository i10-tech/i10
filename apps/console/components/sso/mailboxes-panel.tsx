"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import { formatExact } from "@/lib/format"
import {
  LEAVER_HELP,
  LEAVER_LABEL,
  NEXT_LABEL,
  daysInRange,
  deletionDate,
  nextSummary,
} from "@/lib/mailbox"
import { useResetOnOpen } from "@/lib/react"
import {
  chooseMailboxNext,
  mailboxes,
  saveLeaverDefault,
} from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type {
  LeaverAction,
  MailboxNext,
  MailboxRow,
  Mailboxes,
  NextChoice,
  SsoAbilities,
} from "@/lib/sso-types"
import { ClerkMembers, memberLabel, type Member } from "./members"
import { Block, Loading, useRemote, useSsoCall } from "./shared"

/**
 * Directory mail, the workspace side (#344): what happens by default to the
 * mailbox of a person a directory switches off, and, for each suspended one,
 * what happens next. A directory-given mailbox that is still active is listed
 * so the whole picture is in one place.
 *
 * ⚠ DELETING IS NEVER ONE CLICK. Both places that can choose it say the date
 * it will happen on before they ask. The default is an owner's, a single
 * mailbox's next step is an admin's; the API enforces both, the screen only
 * shows the reason.
 */

const NEXT_HELP: Record<MailboxNext, string> = {
  keep: "The mailbox stays, suspended. Nothing is forwarded or deleted.",
  forward_manager: "New mail is copied to their manager. The mailbox is kept.",
  delegate: "Someone you pick can open the mailbox and read it.",
  delete: "The mailbox and its mail are deleted on the date you confirm.",
}

export function MailboxesPanel({
  abilities,
  clerkEnabled,
}: {
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const { data, setData, failed } = useRemote(mailboxes)
  const [members, setMembers] = React.useState<Member[] | null>(null)
  const [deciding, setDeciding] = React.useState<MailboxRow | null>(null)

  if (!data)
    return (
      <>
        {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
        <Loading failed={failed} />
      </>
    )

  const nameOf = (id: string) => memberLabel(members, id)
  const suspended = data.data.filter((r) => r.state === "suspended")
  const active = data.data.filter((r) => r.state === "active")

  return (
    <div>
      {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
      <LeaverDefault
        data={data}
        abilities={abilities}
        onSaved={(leavers) => setData({ ...data, leavers })}
      />
      <Block
        title="Suspended mailboxes"
        description="People a directory switched off. Pick what happens to each mailbox."
      >
        {suspended.length === 0 ? (
          <p className="text-sm text-muted-foreground">No suspended mailboxes.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {suspended.map((row) => (
              <li
                key={row.userId}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.address}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {nextSummary(row, nameOf)}
                    {row.suspendedAt && (
                      <>
                        {" "}
                        Switched off <Time iso={row.suspendedAt} />.
                      </>
                    )}
                    {row.next === "delete" && row.deleteAt && (
                      <>
                        {" "}
                        Deletes <Time iso={row.deleteAt} mode="exact" />.
                      </>
                    )}
                  </span>
                </span>
                <Badge tone="warning" size="sm">
                  Suspended
                </Badge>
                <Button variant="secondary" size="sm" onClick={() => setDeciding(row)}>
                  Decide
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block
        title="Directory mailboxes"
        description="Mailboxes your directories gave to people who are still active."
      >
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No directory has given a mailbox yet. Turn on Create mailboxes on a
            directory to start.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {active.map((row) => (
              <li key={row.userId} className="px-3 py-2 text-sm">
                <span className="block truncate">{row.address}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {nameOf(row.userId) === row.userId ? "" : nameOf(row.userId)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <NextDialog
        row={deciding}
        data={data}
        members={members}
        onClose={() => setDeciding(null)}
        onChosen={async () => {
          setDeciding(null)
          const fresh = await mailboxes()
          if (fresh.ok) setData(fresh.data)
        }}
      />
    </div>
  )
}

// ── The workspace default ───────────────────────────────────────────────────

function LeaverDefault({
  data,
  abilities,
  onSaved,
}: {
  data: Mailboxes
  abilities: SsoAbilities
  onSaved: (leavers: Mailboxes["leavers"]) => void
}) {
  const call = useSsoCall()
  const [action, setAction] = React.useState<LeaverAction>(data.leavers.action)
  const [days, setDays] = React.useState(String(data.leavers.days ?? 30))
  const [confirming, setConfirming] = React.useState(false)
  const { minDays, maxDays } = data.limits
  const count = Number(days)
  const saved = data.leavers
  const unchanged =
    action === saved.action && (action !== "delete_after" || count === saved.days)
  const invalid = action === "delete_after" && !daysInRange(count, data.limits)
  // Choosing or keeping deletion is an owner's; an admin may still move away from it.
  const blocked = action === "delete_after" && !abilities.owner

  async function save() {
    const result = await call(
      () =>
        saveLeaverDefault(
          action === "delete_after" ? { action, days: count } : { action },
        ),
      { title: "Could not save the default" },
    )
    if (!result) return false
    onSaved(result)
    toastDone("Default saved")
    return true
  }

  return (
    <Block
      title="When someone is switched off"
      description="What happens to a person's mailbox when their directory switches them off. You can still decide each mailbox yourself."
    >
      <MorphSelect
        label="Default"
        value={action}
        onValueChange={(v) => setAction(v as LeaverAction)}
        items={(Object.keys(LEAVER_LABEL) as LeaverAction[]).map((a) => ({
          value: a,
          label: LEAVER_LABEL[a],
          disabled: a === "delete_after" && !abilities.owner,
        }))}
      />
      <p className="text-sm text-muted-foreground">{LEAVER_HELP[action]}</p>
      {action === "delete_after" && (
        <FloatingInput
          label="Days before deleting"
          type="number"
          inputMode="numeric"
          min={minDays}
          max={maxDays}
          value={days}
          disabled={!abilities.owner}
          state={invalid ? "invalid" : "idle"}
          hint={`${minDays} to ${maxDays} days.`}
          onChange={(e) => setDays(e.target.value)}
        />
      )}
      {!abilities.owner && (
        <p className="text-xs text-muted-foreground">
          Only an owner can choose to delete the mailboxes of everyone a directory
          switches off. Ask an owner.
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={unchanged || invalid || blocked}
        onClick={() => (action === "delete_after" ? setConfirming(true) : void save())}
      >
        Save default
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete mailboxes by default?"
        description={`From now on, the mailbox of every person a directory switches off is deleted ${count} days after, with all its mail. Anyone switched off before this is not affected.`}
        confirmLabel="Save default"
        doneLabel="Saved"
        onConfirm={save}
      />
    </Block>
  )
}

// ── One suspended mailbox ───────────────────────────────────────────────────

function NextDialog({
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
            {next === "delegate" &&
              (members && members.length > 0 ? (
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
              ))}
            {next === "delete" && (
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
            )}
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
