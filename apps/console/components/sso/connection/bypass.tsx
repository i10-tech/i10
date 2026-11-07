"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import { addBypass, bypassList, removeBypass } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { isLocked, Loading, OwnerNote, useRemote, useSsoCall } from "../shared"
import { Advanced } from "../settings-card"
import { ClerkMembers, type Member } from "../members"

export function Bypass({
  connection,
  abilities,
  clerkEnabled,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(() => bypassList(connection.id))
  const locked = isLocked(connection, abilities)
  const [members, setMembers] = React.useState<Member[] | null>(null)
  const [userId, setUserId] = React.useState("")
  const [reason, setReason] = React.useState("")
  const label = (id: string) => members?.find((m) => m.userId === id)?.label ?? id

  async function add() {
    const made = await call(
      () => addBypass(connection.id, userId.trim(), reason.trim()),
      {
        title: "Could not add them to the list",
      },
    )
    if (made && data) {
      setUserId("")
      setReason("")
      toastDone("Added to emergency access")
      const fresh = await bypassList(connection.id)
      if (fresh.ok) setData(fresh.data)
    }
  }

  return (
    <Advanced
      label="Emergency access"
      summary={
        data
          ? data.data.length === 0
            ? "Nobody yet"
            : `${data.data.length} ${data.data.length === 1 ? "person" : "people"}`
          : undefined
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          People who can still get in without SSO if your provider is down. Every use is
          audited, so keep it short.
        </p>
        {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
        {!data ? (
          <Loading failed={failed} />
        ) : (
          <>
            {data.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody is on the list.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {data.data.map((entry) => (
                  <li
                    key={entry.userId}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{label(entry.userId)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.reason} &middot; <Time iso={entry.createdAt} />
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={locked}
                      onClick={async () => {
                        const ok = await call(
                          () => removeBypass(connection.id, entry.userId),
                          {
                            title: "Could not remove them",
                          },
                        )
                        if (ok)
                          setData({
                            data: data.data.filter((e) => e.userId !== entry.userId),
                          })
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {members && members.length > 0 ? (
                <MorphSelect
                  label="Member"
                  value={userId || null}
                  disabled={locked}
                  onValueChange={setUserId}
                  items={members.map((m) => ({ value: m.userId, label: m.label }))}
                />
              ) : (
                <FloatingInput
                  label="Member's user id"
                  hint="Starts with user_"
                  value={userId}
                  disabled={locked}
                  onChange={(e) => setUserId(e.target.value)}
                />
              )}
              <FloatingInput
                label="Why"
                value={reason}
                disabled={locked}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={locked || !userId.trim() || !reason.trim()}
              onClick={add}
            >
              Add to the list
            </Button>
            <OwnerNote abilities={abilities} />
          </>
        )}
      </div>
    </Advanced>
  )
}
