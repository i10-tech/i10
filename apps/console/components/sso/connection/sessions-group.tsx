"use client"

import * as React from "react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { changeSsoConnection, type ConnectionChange } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import {
  connectionWriteNeedsStepUp,
  isLocked,
  OwnerNote,
  scimSessionLimitNote,
  useSsoCall,
} from "../shared"

const HOUR = 3600
const MAX_SESSION: { value: string; label: string }[] = [
  { value: "none", label: "No limit" },
  { value: String(8 * HOUR), label: "8 hours" },
  { value: String(12 * HOUR), label: "12 hours" },
  { value: String(24 * HOUR), label: "24 hours" },
  { value: String(7 * 24 * HOUR), label: "7 days" },
  { value: String(30 * 24 * HOUR), label: "30 days" },
]

const IDLE: { value: string; label: string }[] = [
  { value: "none", label: "No limit" },
  { value: String(15 * 60), label: "15 minutes" },
  { value: String(HOUR), label: "1 hour" },
  { value: String(8 * HOUR), label: "8 hours" },
  { value: String(24 * HOUR), label: "24 hours" },
]

function withCurrent(
  options: { value: string; label: string }[],
  seconds: number | null,
) {
  if (seconds === null || options.some((o) => o.value === String(seconds)))
    return options
  return [
    ...options,
    { value: String(seconds), label: `${Math.round(seconds / 60)} minutes` },
  ]
}

export function SessionsGroup({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const locked = isLocked(connection, abilities)
  const sessionNote = scimSessionLimitNote(connection.directoryState)

  async function patch(change: ConnectionChange, done: string) {
    const result = await call(() => changeSsoConnection(connection.id, change), {
      stepUp: connectionWriteNeedsStepUp(connection, change),
      title: "Could not save that",
    })
    if (result) {
      onChange({ ...connection, ...result, domains: connection.domains })
      toastDone(done)
    }
  }

  return (
    <SettingsGroup>
      <SettingsRow
        title="Longest session"
        description="Sign out after this duration even if active."
        action={
          <div className="w-44">
            <MorphSelect
              label="Longest session"
              hideLabel
              disabled={locked}
              value={
                connection.maxSessionSeconds === null
                  ? "none"
                  : String(connection.maxSessionSeconds)
              }
              onValueChange={(v) =>
                void patch(
                  { maxSessionSeconds: v === "none" ? null : Number(v) },
                  "Session length saved",
                )
              }
              items={withCurrent(MAX_SESSION, connection.maxSessionSeconds)}
            />
          </div>
        }
      />

      <SettingsRow
        title="Sign out when idle"
        description="Sign out when inactive for this duration."
        action={
          <div className="w-44">
            <MorphSelect
              label="Sign out when idle"
              hideLabel
              disabled={locked}
              value={
                connection.idleTimeoutSeconds === null
                  ? "none"
                  : String(connection.idleTimeoutSeconds)
              }
              onValueChange={(v) =>
                void patch(
                  { idleTimeoutSeconds: v === "none" ? null : Number(v) },
                  "Idle timeout saved",
                )
              }
              items={withCurrent(IDLE, connection.idleTimeoutSeconds)}
            />
          </div>
        }
      />

      <div className="bg-muted/30 px-4 py-3 text-xs text-muted-foreground space-y-1 border-t border-border">
        <p>The shorter limit between this connection and the workspace policy wins.</p>
        {connection.provider === "entra" && (
          <p>
            Signing out of Microsoft does not sign people out of i10. Sessions end at
            the longest session limit, or when your directory deactivates someone.
          </p>
        )}
        {sessionNote && <p>{sessionNote}</p>}
        <OwnerNote abilities={abilities} />
      </div>
    </SettingsGroup>
  )
}
