"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import {
  makeOktaHookSecret,
  oktaHookSetup,
  removeOktaHookSecret,
} from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { OktaHookSetup, SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import { Loading, ShownOnce, useRemote, useSsoCall, Value } from "../shared"

/**
 * An Okta connection's event hook: how Okta tells i10 that a person's account
 * changed, so their mail sign-in stops working at once instead of after i10's
 * short memory of their password runs out.
 *
 * ⚠ THE SECRET IS SHOWN ONCE, IN `ShownOnce`, AND LIVES ONLY IN THIS
 * COMPONENT'S STATE UNTIL THE DIALOG CLOSES. The API keeps a hash, so nothing
 * can show it again; the view state below never holds it.
 *
 * ⚠ AN OWNER'S MOVE ON EVERY CONNECTION STATUS, WITH STEP-UP: whoever holds the
 * secret can make i10 re-ask Okta about anyone on the connection.
 */
export function OktaEventHookRow({
  connection,
  abilities,
  initial,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  /** Read on the server. Undefined means it could not be, and this asks again. */
  initial?: OktaHookSetup
}) {
  const { data, setData, failed } = useRemote(
    () => oktaHookSetup(connection.id),
    initial,
  )
  if (!data) {
    return (
      <HookShell>
        <Loading failed={failed} />
      </HookShell>
    )
  }
  return (
    <HookContent
      connection={connection}
      abilities={abilities}
      data={data}
      setData={setData}
    />
  )
}

function HookShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Okta event hook</h4>
      <SettingsGroup>
        <div className="px-4 py-3.5">{children}</div>
      </SettingsGroup>
    </div>
  )
}

function HookContent({
  connection,
  abilities,
  data,
  setData,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  data: OktaHookSetup
  setData: (next: OktaHookSetup) => void
}) {
  const call = useSsoCall()
  const [secret, setSecret] = React.useState<string | null>(null)
  const [asking, setAsking] = React.useState<"rotate" | "remove" | null>(null)
  const [busy, setBusy] = React.useState(false)
  const canChange = abilities.owner

  async function make() {
    const made = await call(() => makeOktaHookSecret(connection.id), {
      title: data.secretSet
        ? "Could not rotate the secret"
        : "Could not create the secret",
    })
    if (!made) return false
    const { secret: value, ...view } = made
    setData(view)
    setSecret(value)
    return true
  }

  async function create() {
    setBusy(true)
    try {
      await make()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    const after = await call(() => removeOktaHookSecret(connection.id), {
      title: "Could not remove the secret",
    })
    if (!after) return false
    setData(after)
    toastDone("Event hook secret removed")
    return true
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Okta event hook</h4>
      <SettingsGroup>
        <SettingsRow
          title="Keep mail access in step with Okta"
          description="When someone's Okta password changes, they are suspended, or they lose the app, their mail sign-in stops working right away instead of a few minutes later."
          action={
            <Badge tone={data.secretSet ? "success" : "neutral"} size="sm">
              {data.secretSet ? "On" : "Not set up"}
            </Badge>
          }
        >
          <div className="space-y-3">
            <Value
              label="Paste this URL into Okta as the hook's URL"
              value={data.url}
            />
            {data.secretSet ? (
              <p className="text-sm text-muted-foreground">
                A secret is set
                {data.hint && (
                  <>
                    {" "}
                    (starts with <span className="font-mono text-xs">{data.hint}</span>)
                  </>
                )}
                {data.issuedAt && (
                  <>
                    , made <Time iso={data.issuedAt} />
                  </>
                )}
                . In Okta, give it as the value of the{" "}
                <span className="font-mono text-xs">{data.header}</span> field.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Create a secret, then give it to Okta as the value of the{" "}
                <span className="font-mono text-xs">{data.header}</span> field. You will
                see it once.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Subscribe the hook to: {data.events.join(", ")}.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {data.secretSet ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={!canChange}
                    onClick={() => setAsking("rotate")}
                  >
                    Rotate secret
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!canChange}
                    onClick={() => setAsking("remove")}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Button disabled={!canChange} loading={busy} onClick={create}>
                  Create secret
                </Button>
              )}
              {!canChange && (
                <p className="text-xs text-muted-foreground">
                  Only a workspace owner can change the event hook. Ask an owner.
                </p>
              )}
            </div>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog
        open={asking === "rotate"}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Rotate the secret?"
        description="The old secret stops working at once. You will get a new one to paste into Okta straight away; events Okta sends in between are lost."
        confirmLabel="Rotate"
        doneLabel="Rotated"
        destructive={false}
        onConfirm={make}
      />
      <ConfirmDialog
        open={asking === "remove"}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Remove the secret?"
        description="Okta's events stop being accepted, so mail access follows Okta's changes only after a few minutes. You can create a new secret later."
        confirmLabel="Remove"
        doneLabel="Removed"
        onConfirm={remove}
      />
      <ShownOnce
        open={secret !== null}
        title="Your event hook secret"
        description="Paste it into Okta now. You will not see this again. If you lose it, make a new one."
        fields={[{ label: "Secret", value: secret ?? "" }]}
        onClose={() => setSecret(null)}
      />
    </div>
  )
}
