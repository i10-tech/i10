"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { changeSsoConnection } from "@/lib/sso-actions"
import type { SsoConnection } from "@/lib/sso-types"
import { useSsoAttempt } from "../shared"
import { InlineError } from "./inline-error"

export function LiveStep({
  connection,
  providerLabel,
  onLive,
}: {
  connection: SsoConnection
  providerLabel: string
  onLive: (connection: SsoConnection) => void
}) {
  const attempt = useSsoAttempt()
  const [mode, setMode] = React.useState<"optional" | "required">("optional")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const domains = connection.domains.map((d) => d.name).join(", ")

  async function turnOn() {
    setBusy(true)
    setError(null)
    try {
      const live = await attempt(() =>
        changeSsoConnection(connection.id, {
          status: "active",
          enforcement: "optional",
          jitEnabled: true,
        }),
      )
      if (live === null) return
      if (!live.ok) {
        setError(live.error)
        return
      }
      if (mode === "optional") {
        onLive(live.data)
        return
      }
      const required = await changeSsoConnection(connection.id, {
        enforcement: "required_domain",
      })
      if (!required.ok) {
        setError(
          `Single sign-on is on, but we could not require it: ${required.error}`,
        )
        onLive(live.data)
        return
      }
      onLive(required.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <RadioCards
        aria-label="How people sign in"
        layout="list"
        value={mode}
        onValueChange={(value) => setMode(value as "optional" | "required")}
        options={[
          {
            value: "optional",
            label: "Offer it",
            description: `People at ${domains} can choose ${providerLabel} at sign-in. Their other ways in keep working.`,
          },
          {
            value: "required",
            label: "Require it",
            description: `Everyone at ${domains} must sign in through ${providerLabel}. Owners and admins it does not manage keep their passkey, so nobody gets locked out.`,
          },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        People who sign in for the first time get an account as a member. You can change
        this later.
      </p>
      <InlineError message={error} />
      <Button onClick={() => void turnOn()} loading={busy}>
        Turn on single sign-on
      </Button>
    </div>
  )
}
