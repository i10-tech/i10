"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { saveLdapService } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { LdapSetup, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup } from "../settings-card"
import { useSsoCall } from "../shared"

export function LdapServiceAccount({
  connection,
  data,
  setData,
  locked,
  onAccountSaved,
}: {
  connection: SsoConnection
  data: LdapSetup
  setData: (next: LdapSetup) => void
  locked: boolean
  onAccountSaved: () => void
}) {
  const call = useSsoCall()
  const [bindDn, setBindDn] = React.useState("")
  const [bindSecret, setBindSecret] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  async function saveService() {
    setBusy(true)
    try {
      const after = await call(
        () => saveLdapService(connection.id, bindDn.trim(), bindSecret),
        { title: "Could not save the service account" },
      )
      if (after) {
        setData(after)
        setBindDn("")
        setBindSecret("")
        onAccountSaved()
        toastDone("Service account saved")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Service account</h4>
      <SettingsGroup>
        <div className="p-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {data.serviceSet
              ? "A service account is saved. Enter a new one to replace it."
              : "An account that may search the directory."}
          </p>
          <FloatingInput
            label="Bind DN"
            value={bindDn}
            disabled={locked}
            autoComplete="off"
            onChange={(e) => setBindDn(e.target.value)}
          />
          <FloatingInput
            label="Secret"
            type="password"
            autoComplete="off"
            value={bindSecret}
            disabled={locked}
            onChange={(e) => setBindSecret(e.target.value)}
          />
          <Button
            onClick={saveService}
            loading={busy}
            disabled={locked || !bindDn.trim() || !bindSecret}
          >
            {data.serviceSet ? "Replace service account" : "Save service account"}
          </Button>
        </div>
      </SettingsGroup>
    </div>
  )
}
