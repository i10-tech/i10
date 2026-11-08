"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { Time } from "@/components/time"
import { makeOidcKey } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { OidcSetup, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup } from "../settings-card"
import { connectionWriteNeedsStepUp, useSsoCall } from "../shared"

export function OidcKeys({
  connection,
  data,
  setData,
  locked,
}: {
  connection: SsoConnection
  data: OidcSetup
  setData: (next: OidcSetup) => void
  locked: boolean
}) {
  const call = useSsoCall()
  const [busy, setBusy] = React.useState(false)

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Signing keys</h4>
      <SettingsGroup>
        <div className="p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Private key JWT uses asymmetric keys to sign authentication requests.
          </p>
          {data.keys.length > 0 && (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {data.keys.map((k) => (
                <li key={k.kid} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {k.kid}
                  </span>
                  <Time iso={k.createdAt} className="text-xs text-muted-foreground" />
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="secondary"
            disabled={locked}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const after = await call(() => makeOidcKey(connection.id), {
                  stepUp: connectionWriteNeedsStepUp(connection),
                  title: "Could not generate signing key",
                })
                if (after) {
                  setData(after)
                  toastDone("New signing key generated")
                }
              } finally {
                setBusy(false)
              }
            }}
          >
            Generate new signing key
          </Button>
        </div>
      </SettingsGroup>
    </div>
  )
}
