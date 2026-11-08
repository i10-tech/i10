"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import { formatExact } from "@/lib/format"
import {
  LEAVER_HELP,
  LEAVER_LABEL,
  daysInRange,
  deletionDate,
  nextSummary,
  resumeNote,
} from "@/lib/mailbox"
import { mailboxes, resumeMailbox, saveLeaverDefault } from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type { LeaverAction, MailboxRow, Mailboxes, SsoAbilities } from "@/lib/sso-types"
import { NextDialog } from "./mailbox-dialog"
import { ClerkMembers, memberLabel, type Member } from "./members"
import { Block, Loading, useRemote, useSsoCall } from "./shared"

export function MailboxesPanel({
  abilities,
  clerkEnabled,
}: {
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const { data, setData, failed } = useRemote(mailboxes)
  const call = useSsoCall()
  const [members, setMembers] = React.useState<Member[] | null>(null)
  const [deciding, setDeciding] = React.useState<MailboxRow | null>(null)
  const [resuming, setResuming] = React.useState<MailboxRow | null>(null)

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
    <div className="space-y-4">
      {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
      <LeaverDefault
        data={data}
        abilities={abilities}
        onSaved={(leavers) => setData({ ...data, leavers })}
      />
      <Block
        title="Suspended mailboxes"
        description="People a directory switched off and members who were removed. Resume a mailbox to give back its sign-in, or pick what happens to it."
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
                <Button variant="secondary" size="sm" onClick={() => setResuming(row)}>
                  Resume
                </Button>
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
      <ConfirmDialog
        open={resuming !== null}
        onOpenChange={(o) => {
          if (!o) setResuming(null)
        }}
        title="Resume this mailbox?"
        description={
          resuming
            ? `${resuming.address} will be able to sign in again. Forwarding, shared access or a scheduled deletion you set for it is cancelled. A payment hold or a ban is not lifted.`
            : ""
        }
        confirmLabel="Resume mailbox"
        doneLabel="Resumed"
        destructive={false}
        onConfirm={async () => {
          if (!resuming) return false
          const done = await call(() => resumeMailbox(resuming.userId), {
            title: "Could not resume the mailbox",
          })
          if (!done) return false
          toastDone("Mailbox resumed", resumeNote(resuming.address, done.stillBlocked))
          const fresh = await mailboxes()
          if (fresh.ok) setData(fresh.data)
          return true
        }}
      />
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
  const blocked = action === "delete_after" && !abilities.owner

  async function save() {
    const result = await call(
      () =>
        saveLeaverDefault(
          action === "delete_after" ? { action, days: count } : { action },
        ),
      { title: "Could not save the default" },
    )
    if (result) {
      toastDone("Default saved")
      onSaved(result)
    }
  }

  const when = action === "delete_after" ? deletionDate(count, new Date()) : null

  return (
    <Block
      title="When someone is switched off"
      description="The default for mailboxes given by a directory when the person is deactivated."
    >
      <div className="space-y-4">
        <RadioCards
          aria-label="What happens by default"
          layout="list"
          value={action}
          onValueChange={(v) => setAction(v as LeaverAction)}
          options={(Object.keys(LEAVER_LABEL) as LeaverAction[]).map((a) => ({
            value: a,
            label: LEAVER_LABEL[a],
            description: LEAVER_HELP[a],
            disabled: a === "delete_after" && !abilities.owner,
          }))}
        />
        <Reveal show={action === "delete_after"} spacing="pt-2">
          <FloatingInput
            label="Days before deleting"
            type="number"
            inputMode="numeric"
            min={minDays}
            max={maxDays}
            value={days}
            disabled={!abilities.owner}
            state={daysInRange(count, data.limits) ? "idle" : "invalid"}
            hint={
              abilities.owner
                ? `${minDays} to ${maxDays} days from now.`
                : "Only an owner can choose to delete mailboxes."
            }
            onChange={(e) => setDays(e.target.value)}
          />
        </Reveal>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={unchanged || invalid || blocked}
            onClick={() =>
              action === "delete_after" ? setConfirming(true) : void save()
            }
          >
            {action === "delete_after" ? "Save deletion default" : "Save default"}
          </Button>
          {!abilities.owner && (
            <p className="text-xs text-muted-foreground">
              Only an owner can choose to delete mailboxes.
            </p>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete leavers' mailboxes by default?"
        description={
          when
            ? `Anyone switched off by a directory will have their mailbox and mail deleted ${count} days later (first possible deletion: ${formatExact(when.toISOString())}). You can still pick a different next step for a single mailbox.`
            : ""
        }
        confirmLabel="Save deletion default"
        doneLabel="Saved"
        onConfirm={async () => {
          await save()
          return true
        }}
      />
    </Block>
  )
}
