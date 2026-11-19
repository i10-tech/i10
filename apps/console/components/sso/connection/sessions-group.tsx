"use client"

import * as React from "react"
import { useBoneLoading } from "@repo/ui/components/bone/bone"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { changeSsoConnection, type ConnectionChange } from "@/lib/sso-actions"
import { SCIM_SESSION_LIMIT_NOTE } from "@/lib/sso-authorization"
import type { SsoConnectionShape } from "@/lib/shapes/sso-connection"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import {
  connectionWriteNeedsStepUp,
  isLocked,
  OwnerNote,
  RowBone,
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
  shape,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  shape: SsoConnectionShape
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const skeleton = useBoneLoading()
  const locked = isLocked(connection, abilities)

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
            <RowBone id="longest" loading={skeleton} width={176} height={40}>
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
            </RowBone>
          </div>
        }
      />

      <SettingsRow
        title="Sign out when idle"
        description="Sign out when inactive for this duration."
        action={
          <div className="w-44">
            <RowBone id="idle" loading={skeleton} width={176} height={40}>
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
            </RowBone>
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
        {/* ⚠ THE SHAPE SAYS WHETHER SCIM IS MISSING (the note is fixed copy), so the skeleton has the line too. */}
        {shape.sessionNote && <p>{SCIM_SESSION_LIMIT_NOTE}</p>}
        <OwnerNote abilities={abilities} />
      </div>
    </SettingsGroup>
  )
}
