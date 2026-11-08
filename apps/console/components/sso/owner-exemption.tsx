"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Time } from "@/components/time"
import {
  approveExemptionOff,
  enableExemption,
  ownerExemption,
  requestExemptionOff,
  withdrawExemptionOff,
} from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { OwnerExemption, SsoAbilities } from "@/lib/sso-types"
import { Loading, useRemote, useSsoCall } from "./shared"
import { SettingsRow } from "./settings-card"

/**
 * The owner exemption (decision 7): owners and admins who are not managed by
 * SSO are never forced through it, so a broken identity provider cannot lock
 * the people who could fix it out. It is on by default. Turning it off takes a
 * request from one owner and approval from a second, different one within 24
 * hours; turning it on takes one.
 *
 * ⚠ WITH IT OFF, an unmanaged owner can only get in through a connection's
 * bypass list, because SSO never signs them in. That is why it takes two.
 */
export function OwnerExemptionPanel({
  abilities,
  initial,
}: {
  abilities: SsoAbilities
  initial?: OwnerExemption | null
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(ownerExemption, initial)
  const [busy, setBusy] = React.useState(false)

  if (!data) return <Loading failed={failed} />

  async function act(
    fn: () => ReturnType<typeof requestExemptionOff>,
    done: string,
    options: { stepUp?: boolean } = {},
  ) {
    setBusy(true)
    try {
      const after = await call(fn, {
        ...options,
        title: "Could not change the exemption",
      })
      if (after) {
        setData(after)
        toastDone(done)
      }
    } finally {
      setBusy(false)
    }
  }

  const pending = data.pending
  const mine = pending !== null && pending.requestedBy === abilities.userId

  return (
    <SettingsRow
      title="Owner exemption"
      description={
        data.enabled
          ? "Owners and admins who are not managed keep signing in with a passkey when SSO is required, and must have one."
          : "Owners and admins are covered by required SSO like everyone else, and can only get in through a bypass list."
      }
      action={
        <Badge tone={data.enabled ? "success" : "warning"} size="sm">
          {data.enabled ? "On" : "Off"}
        </Badge>
      }
    >
      <div className="space-y-3">
        {pending && (
          <p className="text-sm text-muted-foreground">
            {mine ? "You asked" : "An owner asked"} to turn it off{" "}
            <Time iso={pending.requestedAt} />. A different owner has to approve before{" "}
            <Time iso={pending.expiresAt} mode="exact" />.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {data.enabled && !pending && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!abilities.owner || busy}
              onClick={() => void act(requestExemptionOff, "Request made")}
            >
              Ask to turn it off
            </Button>
          )}
          {data.enabled && pending && !mine && (
            <Button
              size="sm"
              variant="danger"
              disabled={!abilities.owner || busy}
              onClick={() => void act(approveExemptionOff, "Exemption turned off")}
            >
              Approve turning it off
            </Button>
          )}
          {data.enabled && pending && mine && (
            <p className="text-xs text-muted-foreground">
              You cannot approve your own request.
            </p>
          )}
          {data.enabled && pending && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!abilities.owner || busy}
              onClick={() =>
                void act(withdrawExemptionOff, "Request withdrawn", { stepUp: false })
              }
            >
              Withdraw the request
            </Button>
          )}
          {!data.enabled && (
            <Button
              size="sm"
              disabled={!abilities.owner || busy}
              onClick={() => void act(enableExemption, "Exemption turned on")}
            >
              Turn it on
            </Button>
          )}
        </div>
        {!abilities.owner && (
          <p className="text-xs text-muted-foreground">
            Only an owner can change this.
          </p>
        )}
      </div>
    </SettingsRow>
  )
}
