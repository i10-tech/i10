"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Switch } from "@repo/ui/components/i10/switch"
import { saveOidcMail } from "@/lib/sso-actions"
import {
  canChangeOidcMail,
  oidcMailBody,
  oidcMailDirty,
  oidcMailEnableBlock,
  oidcMailForm,
  oidcMailSavable,
  oidcProviderName,
  passwordOf,
} from "@/lib/sso-mail"
import { toastDone } from "@/lib/toast"
import type { OidcMailSetup, SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import { useSsoCall, Value } from "../shared"

/**
 * The OIDC lane of "Mail sign-in": the provider checks the password.
 *
 * ⚠ SAVING SETTINGS TURNS THE CHECK OFF, AND THE COPY SAYS SO. A different
 * issuer, client or field is a different place for passwords to go, so the API
 * switches the lane off and wants an explicit "on" afterwards. The switch is
 * therefore blocked while the form has unsaved changes, so what is switched
 * on is always what was saved.
 *
 * ⚠ AN OWNER'S, ON EVERY STATUS, with step-up: the token endpoint is where
 * every managed person's mail password is sent. Turning it off stays an
 * admin's, so the switch is only blocked in the on direction.
 */
export function OidcMailLane({
  connection,
  abilities,
  data,
  setData,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  data: OidcMailSetup
  setData: (next: OidcMailSetup) => void
}) {
  const call = useSsoCall()
  const [form, setForm] = React.useState(() => oidcMailForm(data))
  const [busy, setBusy] = React.useState(false)
  const canChange = canChangeOidcMail(abilities)

  const name = oidcProviderName(data, connection.provider)
  const preset = data.presets.find((p) => p.id === form.preset)
  const dirty = oidcMailDirty(form, data)
  const block = oidcMailEnableBlock(data, form, abilities)

  async function save() {
    setBusy(true)
    try {
      const after = await call(
        () =>
          saveOidcMail(
            connection.id,
            oidcMailBody(form, preset?.extras.map((e) => e.key) ?? []),
          ),
        { title: "Could not save the settings" },
      )
      if (after) {
        setData(after)
        setForm(oidcMailForm(after))
        toastDone(
          "Settings saved",
          data.enabled
            ? "The password check is off until you turn it back on."
            : undefined,
        )
      }
    } finally {
      setBusy(false)
    }
  }

  async function toggle(enabled: boolean) {
    const after = await call(() => saveOidcMail(connection.id, { enabled }), {
      title: enabled ? "Could not turn it on" : "Could not turn it off",
    })
    if (after) {
      setData(after)
      toastDone(enabled ? "Password check on" : "Password check off")
    }
  }

  return (
    <div className="space-y-6 pt-2">
      <SettingsGroup>
        <SettingsRow
          title={`Check mail passwords at ${name}`}
          description={`People sign in to mail with their ${passwordOf(name)}. i10 never stores it; ${name} checks it each time.`}
          action={
            <Switch
              checked={data.enabled}
              disabled={!data.enabled && block !== null}
              onCheckedChange={(v) => void toggle(v)}
              aria-label={`Check mail passwords at ${name}`}
            />
          }
        >
          {!data.enabled && block && (
            <p className="text-xs text-muted-foreground">{block}</p>
          )}
        </SettingsRow>
      </SettingsGroup>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Settings</h4>
        <SettingsGroup>
          <div className="space-y-4 p-4">
            <MorphSelect
              label="Provider type"
              value={form.preset}
              disabled={!canChange}
              onValueChange={(v) => setForm({ ...form, preset: v, extra: {} })}
              items={data.presets.map((p) => ({ value: p.id, label: p.label }))}
            />
            <FloatingInput
              label="Issuer URL"
              hint={preset ? `For example ${preset.issuerHint}` : undefined}
              value={form.issuer}
              disabled={!canChange}
              onChange={(e) => setForm({ ...form, issuer: e.target.value })}
            />
            <FloatingInput
              label="Client ID"
              hint={
                preset
                  ? `The public client you made for mail, like ${preset.clientIdHint}`
                  : undefined
              }
              value={form.clientId}
              disabled={!canChange}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            />
            {preset?.extras.map((field) => (
              <FloatingInput
                key={`${form.preset}:${field.key}`}
                label={`${field.label} (optional)`}
                value={form.extra[field.key] ?? ""}
                disabled={!canChange}
                autoComplete="off"
                onChange={(e) =>
                  setForm({
                    ...form,
                    extra: { ...form.extra, [field.key]: e.target.value },
                  })
                }
              />
            ))}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={save}
                  loading={busy}
                  disabled={!canChange || !dirty || !oidcMailSavable(form)}
                >
                  Save settings
                </Button>
                {!canChange && (
                  <p className="text-xs text-muted-foreground">
                    Only a workspace owner can change where mail passwords are checked.
                    Ask an owner.
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {data.enabled
                  ? "Saving changes turns the password check off. Turn it back on once the settings are saved."
                  : "Saving changes keeps the password check off until you turn it on."}
              </p>
            </div>
          </div>
        </SettingsGroup>
      </div>

      {data.tokenEndpoint && (
        <Value label="Mail passwords are checked at" value={data.tokenEndpoint} />
      )}

      <p className="max-w-prose text-xs text-muted-foreground">
        This uses OpenID Connect&apos;s password grant. In {name}, mail needs its own
        public client with the password grant allowed and a sign-in policy that asks for
        the password only.
      </p>
    </div>
  )
}
