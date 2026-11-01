"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RowMenu } from "@/components/list/row-menu"
import { Time } from "@/components/time"
import {
  deprovisionedPeople,
  revokeDeprovisionedKey,
  rotateDeprovisionedKey,
} from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type { DeprovisionedKey, SsoAbilities } from "@/lib/sso-types"
import { ClerkMembers, memberLabel, type Member } from "./members"
import { Loading, ShownOnce, useRemote, useSsoCall } from "./shared"

/**
 * The API keys of people a directory removed (#345): who they are, what they
 * created that is still live, and, for an owner, rotating or revoking each.
 *
 * ⚠ NOTHING HAPPENS TO A KEY BY ITSELF WHEN SOMEONE LEAVES. A key belongs to
 * the workspace, and an integration must not stop because an employee left, so
 * this only shows the leftovers and lets an owner act on one key at a time.
 * Seeing them is an admin's; acting is an owner's, with a step-up, and the API
 * refuses the same move for anyone else.
 */
interface Target {
  userId: string
  key: DeprovisionedKey
}

export function DeprovisionedKeysPanel({
  abilities,
  clerkEnabled,
}: {
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const { data, failed, reload } = useRemote(deprovisionedPeople)
  const [members, setMembers] = React.useState<Member[] | null>(null)
  const [open, setOpen] = React.useState<string | null>(null)
  const call = useSsoCall()
  // ⚠ THE DIALOGS AND THE SHOWN-ONCE SECRET LIVE HERE, NOT IN A PERSON'S ROW:
  // acting on a person's last key drops them from the list, and a row that
  // unmounts would take the new secret with it before it was stored.
  const [revoking, setRevoking] = React.useState<Target | null>(null)
  const [rotating, setRotating] = React.useState<Target | null>(null)
  const [shown, setShown] = React.useState<{ name: string; secret: string } | null>(
    null,
  )

  async function revoke({ userId, key }: Target): Promise<boolean> {
    const done = await call(() => revokeDeprovisionedKey(userId, key.id), {
      title: "Could not revoke the key",
    })
    if (!done) return false
    toastDone("Key revoked", `${key.name} stops working within a minute.`)
    await reload()
    return true
  }

  async function rotate({ userId, key }: Target): Promise<boolean> {
    const done = await call(() => rotateDeprovisionedKey(userId, key.id), {
      title: "Could not rotate the key",
    })
    if (!done) return false
    setShown({ name: done.name, secret: done.secret })
    await reload()
    return true
  }
  if (!data)
    return (
      <>
        {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
        <Loading failed={failed} />
      </>
    )
  const people = data.data

  return (
    <div className="space-y-3">
      {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No removed person has a live API key.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {people.map((person) => (
            <li key={person.user_id} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {memberLabel(members, person.user_id)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Removed <Time iso={person.deprovisioned_at} />.
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={open === person.user_id}
                  onClick={() =>
                    setOpen(open === person.user_id ? null : person.user_id)
                  }
                >
                  {open === person.user_id ? "Hide keys" : "Show keys"}
                </Button>
              </div>
              {open === person.user_id && (
                <PersonKeys
                  keys={person.keys}
                  abilities={abilities}
                  onRotate={(key) => setRotating({ userId: person.user_id, key })}
                  onRevoke={(key) => setRevoking({ userId: person.user_id, key })}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => !open && setRotating(null)}
        title={`Rotate ${rotating?.key.name ?? "this key"}?`}
        description="A new key replaces it, owned by you, and the old one stops working within a minute. Anything still using the old key breaks until it has the new one."
        confirmLabel="Rotate"
        doneLabel="Rotated"
        destructive={false}
        onConfirm={async () => (rotating ? rotate(rotating) : false)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.key.name ?? "this key"}?`}
        description="It stops working within a minute and cannot be turned back on. Anything still using it breaks."
        confirmLabel="Revoke"
        doneLabel="Revoked"
        onConfirm={async () => (revoking ? revoke(revoking) : false)}
      />
      <ShownOnce
        open={shown !== null}
        title="New API key"
        description="This is the only time the key is shown. Store it before you close this."
        fields={
          shown
            ? [
                { label: "Name", value: shown.name },
                { label: "Key", value: shown.secret },
              ]
            : []
        }
        onClose={() => setShown(null)}
      />
    </div>
  )
}

function PersonKeys({
  keys,
  abilities,
  onRotate,
  onRevoke,
}: {
  keys: DeprovisionedKey[]
  abilities: SsoAbilities
  onRotate: (key: DeprovisionedKey) => void
  onRevoke: (key: DeprovisionedKey) => void
}) {
  return (
    <div className="mt-3 space-y-2">
      <ul className="divide-y rounded-lg border">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{key.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                <span className="font-mono">{key.prefix}</span> &middot;{" "}
                {key.last_used_at ? (
                  <>
                    Last used <Time iso={key.last_used_at} />
                  </>
                ) : (
                  "Never used"
                )}
                {key.expires_at && (
                  <>
                    {" "}
                    &middot; Expires <Time iso={key.expires_at} mode="exact" />
                  </>
                )}
              </span>
            </span>
            <Badge tone="neutral" size="sm">
              {key.mode}
            </Badge>
            {abilities.owner && (
              <RowMenu label={key.name}>
                <DropdownMenuItem onSelect={() => onRotate(key)}>
                  Rotate
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(key)}>
                  Revoke
                </DropdownMenuItem>
              </RowMenu>
            )}
          </li>
        ))}
      </ul>
      {!abilities.owner && (
        <p className="text-xs text-muted-foreground">
          Only an owner can rotate or revoke these keys. Ask an owner.
        </p>
      )}
    </div>
  )
}
