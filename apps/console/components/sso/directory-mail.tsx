"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { changeDirectory } from "@/lib/sso-actions"
import { clearGroupMail, setGroupMail } from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoDirectory } from "@/lib/sso-types"
import { ToggleRow, type useSsoCall } from "./shared"

/**
 * Mail from one directory (#344): whether it gives each person it activates a
 * mailbox, and which of its groups are mailing lists or shared mailboxes.
 *
 * ⚠ ONLY AN OWNER TURNS MAILBOX CREATION ON - it makes addresses that receive
 * the workspace's mail - but an admin can turn it off. A group's list address
 * is an admin's. The API refuses the rest; every refusal is shown in its own
 * words by the toast.
 *
 * ⚠ THE GROUP IS NAMED BY ITS ID. The API has no route that lists a
 * directory's groups, so there is nothing to pick from: the id is the one the
 * directory itself uses for the group.
 */

const KINDS = [
  { value: "list", label: "Mailing list" },
  { value: "shared", label: "Shared mailbox" },
]

export function DirectoryMail({
  directory,
  abilities,
  onChange,
  call,
}: {
  directory: SsoDirectory
  abilities: SsoAbilities
  onChange: (directory: SsoDirectory) => void
  call: ReturnType<typeof useSsoCall>
}) {
  return (
    <>
      <ToggleRow
        label="Create mailboxes"
        description={
          directory.createMailboxes
            ? "Each person this directory activates gets a mailbox."
            : abilities.owner
              ? "Off. Turning it on gives each person this directory activates a mailbox, and looks at the people it already activated."
              : "Only an owner can turn this on: it makes addresses that receive your mail."
        }
        checked={directory.createMailboxes}
        disabled={!directory.createMailboxes && !abilities.owner}
        onChange={async (createMailboxes) => {
          const after = await call(
            () => changeDirectory(directory.id, { createMailboxes }),
            {
              title: createMailboxes
                ? "Could not turn mailboxes on"
                : "Could not turn mailboxes off",
            },
          )
          if (after) {
            onChange({ ...directory, ...after, tokens: directory.tokens })
            toastDone(createMailboxes ? "Mailboxes on" : "Mailboxes off")
          }
        }}
      />
      <GroupMail directory={directory} call={call} />
    </>
  )
}

function GroupMail({
  directory,
  call,
}: {
  directory: SsoDirectory
  call: ReturnType<typeof useSsoCall>
}) {
  const [groupId, setGroupId] = React.useState("")
  const [address, setAddress] = React.useState("")
  const [kind, setKind] = React.useState<"list" | "shared">("list")
  const [busy, setBusy] = React.useState<"in" | "out" | null>(null)
  const id = groupId.trim()

  async function optIn() {
    setBusy("in")
    try {
      const done = await call(
        () => setGroupMail(directory.id, id, { address: address.trim(), kind }),
        { title: "Could not make that group a list" },
      )
      if (done) toastDone(kind === "list" ? "List saved" : "Shared mailbox saved")
    } finally {
      setBusy(null)
    }
  }

  async function optOut() {
    setBusy("out")
    try {
      const done = await call(() => clearGroupMail(directory.id, id), {
        title: "Could not change that group",
      })
      if (done) toastDone("Group opted out of mail")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">Group mail</p>
        <p className="text-sm text-muted-foreground">
          Make one of this directory&rsquo;s groups a mailing list or a shared mailbox,
          or opt it out. The address must be on a domain this workspace hosts mail for.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FloatingInput
          label="Group id"
          hint="The id your directory uses for the group."
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
        />
        <MorphSelect
          label="As a"
          value={kind}
          onValueChange={(v) => setKind(v as "list" | "shared")}
          items={KINDS}
        />
      </div>
      <FloatingInput
        label="Address"
        type="email"
        hint="For example team@yourcompany.com"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={busy === "in"}
          disabled={!id || !address.trim() || busy !== null}
          onClick={() => void optIn()}
        >
          Save group mail
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={busy === "out"}
          disabled={!id || busy !== null}
          onClick={() => void optOut()}
        >
          Opt the group out
        </Button>
      </div>
    </div>
  )
}
