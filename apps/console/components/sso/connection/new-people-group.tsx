"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { Switch } from "@repo/ui/components/i10/switch"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { Time } from "@/components/time"
import {
  approveRelink,
  changeSsoConnection,
  rejectRelink,
  relinkRequests,
  type ConnectionChange,
} from "@/lib/sso-actions"
import { mfaCapabilityNote } from "@/lib/sso-runs"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import {
  connectionWriteNeedsStepUp,
  isLocked,
  Loading,
  OwnerNote,
  ToggleRow,
  useRemote,
  useSsoCall,
} from "../shared"

const RELINK_HELP: Record<SsoConnection["relink"], string> = {
  ask: "Someone whose provider login changed (a renamed username or email, a recreated app) is refused until an owner approves the new one below.",
  auto: "When a provider login changes, i10 moves the person to the new one if their email is verified, on a domain above, and is the address on their account. It is recorded in the audit log.",
}

export function NewPeopleGroup({
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
  const live = connection.status === "active" || connection.status === "disabled"
  const caps = connection.capabilities
  const mfaBlocked = caps?.canProveMfa === "no"
  const mfaNote = mfaCapabilityNote(connection)

  const [loginsOpen, setLoginsOpen] = React.useState(false)
  const { data: relinks, setData: setRelinks, failed: relinksFailed } = useRemote(() =>
    relinkRequests(connection.id),
  )

  const entra = connection.provider === "entra"

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

  async function decide(requestId: string, approve: boolean) {
    const ok = await call(
      () =>
        approve
          ? approveRelink(connection.id, requestId)
          : rejectRelink(connection.id, requestId),
      { title: approve ? "Could not approve that" : "Could not reject that" },
    )
    if (ok && relinks) {
      setRelinks({ data: relinks.data.filter((r) => r.id !== requestId) })
      toastDone(approve ? "Login relinked" : "Request rejected")
    }
  }

  const pendingCount = relinks?.data.length ?? 0

  return (
    <SettingsGroup>
      <SettingsRow
        title="Create accounts at first sign-in (JIT)"
        description="Anyone your provider names at this connection's domains becomes a member the first time they sign in."
        action={
          <Switch
            checked={connection.jitEnabled}
            disabled={locked && !connection.jitEnabled}
            onCheckedChange={(v) =>
              void patch({ jitEnabled: v }, v ? "JIT on" : "JIT off")
            }
            aria-label="Create accounts at first sign-in"
          />
        }
      />

      <SettingsRow
        title="Require MFA at your provider"
        description="Refuse a sign-in your provider did not prove with a second factor."
        action={
          <Switch
            checked={connection.mfaRequired}
            disabled={
              (live && !abilities.owner && connection.mfaRequired) ||
              (mfaBlocked && !connection.mfaRequired)
            }
            onCheckedChange={(v) =>
              void patch(
                { mfaRequired: v },
                v ? "MFA required" : "MFA no longer required",
              )
            }
            aria-label="Require MFA at your provider"
          />
        }
      >
        <div className="space-y-1">
          {mfaNote && (
            <p
              className={
                mfaNote.tone === "warning"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {mfaNote.text}
            </p>
          )}
          {caps?.canProveFreshAuth === "with_setting" && caps.freshAuthSetting && (
            <p className="text-xs text-muted-foreground">
              For step-up re-verification: {caps.freshAuthSetting}
            </p>
          )}
          {caps?.canProveFreshAuth === "no" && (
            <p className="text-xs text-muted-foreground">
              {caps.label} cannot prove a fresh sign-in, so step-up prompts use i10&apos;s
              own verification.
            </p>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Changed logins"
        description="What happens when your provider sends a new login for someone who is already linked."
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLoginsOpen((v) => !v)}
            aria-expanded={loginsOpen}
          >
            {loginsOpen ? "Done" : "Manage"}
          </Button>
        }
      >
        <div className="text-sm font-medium text-foreground">
          {connection.relink === "ask" ? "Ask an owner" : "Relink automatically"}
          {pendingCount > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              ({pendingCount} waiting)
            </span>
          )}
        </div>

        <Reveal show={loginsOpen} spacing="pt-3" keepMounted>
          <div className="space-y-3">
            <MorphSelect
              label="When a login changes"
              value={connection.relink}
              disabled={!abilities.owner}
              onValueChange={(v) =>
                void patch({ relink: v as SsoConnection["relink"] }, "Saved")
              }
              items={[
                { value: "ask", label: "Ask an owner" },
                { value: "auto", label: "Relink automatically" },
              ]}
            />
            <p className="text-sm text-muted-foreground">
              {RELINK_HELP[connection.relink]}
            </p>

            {entra && (
              <ToggleRow
                label="Use the user principal name as the email when Entra sends none"
                description="Entra sends no email for members whose mail field is empty. Off, they are refused. On, their user principal name is used, but only on a domain above. Guest accounts never count."
                checked={connection.upnAsEmail}
                disabled={!abilities.owner}
                onChange={(v) =>
                  void patch({ upnAsEmail: v }, v ? "Using principal name" : "Saved")
                }
              />
            )}

            {!abilities.owner && (
              <p className="text-xs text-muted-foreground">
                Only an owner can change these settings or approve a login.
              </p>
            )}

            {!relinks ? (
              <Loading failed={relinksFailed} />
            ) : relinks.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No logins are waiting for approval.
              </p>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {relinks.data.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{r.email ?? r.clerkUserId}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Asked <Time iso={r.createdAt} />, expires <Time iso={r.expiresAt} />
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!abilities.owner}
                      onClick={() => void decide(r.id, false)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      disabled={!abilities.owner}
                      onClick={() => void decide(r.id, true)}
                    >
                      Approve
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <OwnerNote abilities={abilities} />
          </div>
        </Reveal>
      </SettingsRow>
    </SettingsGroup>
  )
}
