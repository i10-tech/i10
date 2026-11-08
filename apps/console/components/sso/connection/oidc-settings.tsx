"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import { saveOidc, saveOidcSecret } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { OidcSetup, SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import { connectionWriteNeedsStepUp, isLocked, OwnerNote, useSsoCall } from "../shared"
import { OidcKeys } from "./oidc-keys"

const CLIENT_AUTH_LABEL: Record<string, string> = {
  client_secret_basic: "Client secret (basic)",
  client_secret_post: "Client secret (post)",
  private_key_jwt: "Private key JWT",
}

export function OidcSettings({
  connection,
  abilities,
  data,
  setData,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  data: OidcSetup
  setData: (next: OidcSetup) => void
}) {
  const call = useSsoCall()
  const locked = isLocked(connection, abilities)
  const [form, setForm] = React.useState({
    issuer: data.issuer ?? "",
    discoveryUrl: data.discoveryUrl ?? "",
    clientId: data.clientId ?? "",
    clientAuth: data.clientAuth ?? data.clientAuthMethods[0] ?? "client_secret_basic",
    scopes: (data.scopes ?? data.defaults.scopes ?? []).join(" "),
    mfaAcrValues: data.mfaAcrValues.join(", "),
  })
  const [secret, setSecret] = React.useState("")
  const [secretExpiresAt, setSecretExpiresAt] = React.useState(
    data.secretExpiresAt ? data.secretExpiresAt.slice(0, 10) : "",
  )
  const [busy, setBusy] = React.useState<string | null>(null)

  async function save() {
    setBusy("settings")
    try {
      const body: Parameters<typeof saveOidc>[1] = {}
      if (form.issuer.trim() !== (data.issuer ?? "")) body.issuer = form.issuer.trim()
      if (form.discoveryUrl.trim() !== (data.discoveryUrl ?? ""))
        body.discoveryUrl = form.discoveryUrl.trim() || null
      if (form.clientId.trim() !== (data.clientId ?? ""))
        body.clientId = form.clientId.trim()
      if (form.clientAuth !== data.clientAuth) body.clientAuth = form.clientAuth
      const sc = form.scopes
        .split(/\s+/)
        .map((v) => v.trim())
        .filter(Boolean)
      const currentSc = data.scopes ?? data.defaults.scopes ?? []
      if (sc.join(" ") !== currentSc.join(" ")) body.scopes = sc
      const acr = form.mfaAcrValues
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
      if (acr.join(",") !== data.mfaAcrValues.join(",")) body.mfaAcrValues = acr
      const currentExp = data.secretExpiresAt ? data.secretExpiresAt.slice(0, 10) : ""
      if (secretExpiresAt !== currentExp)
        body.secretExpiresAt = secretExpiresAt.trim()
          ? new Date(secretExpiresAt.trim()).toISOString()
          : null
      if (Object.keys(body).length === 0) {
        toastDone("Nothing to save", "These are already the saved settings.")
        return
      }
      const after = await call(() => saveOidc(connection.id, body), {
        stepUp: connectionWriteNeedsStepUp(connection),
        title: "Could not save the settings",
      })
      if (after) {
        setData(after)
        setForm({
          issuer: after.issuer ?? "",
          discoveryUrl: after.discoveryUrl ?? "",
          clientId: after.clientId ?? "",
          clientAuth:
            after.clientAuth ?? after.clientAuthMethods[0] ?? "client_secret_basic",
          scopes: (after.scopes ?? after.defaults.scopes ?? []).join(" "),
          mfaAcrValues: after.mfaAcrValues.join(", "),
        })
        setSecretExpiresAt(
          after.secretExpiresAt ? after.secretExpiresAt.slice(0, 10) : "",
        )
        toastDone("Settings saved")
      }
    } finally {
      setBusy(null)
    }
  }

  async function saveSecret() {
    setBusy("secret")
    try {
      const exp = secretExpiresAt.trim()
        ? new Date(secretExpiresAt.trim()).toISOString()
        : null
      const after = await call(() => saveOidcSecret(connection.id, secret, exp), {
        stepUp: connectionWriteNeedsStepUp(connection),
        title: "Could not save the secret",
      })
      if (after) {
        setData(after)
        setSecret("")
        setSecretExpiresAt(
          after.secretExpiresAt ? after.secretExpiresAt.slice(0, 10) : "",
        )
        toastDone("Secret saved")
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Values to give your provider</h4>
        <SettingsGroup>
          <SettingsRow
            title="Sign-in redirect URI"
            description="Paste this into your provider's app configuration."
          >
            <CopyField value={data.redirectUri} />
          </SettingsRow>
          {data.clientAuth === "private_key_jwt" && (
            <SettingsRow
              title="JWKS URL"
              description="Where your provider can fetch public signing keys."
            >
              <CopyField value={data.jwksUrl} />
            </SettingsRow>
          )}
        </SettingsGroup>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Values from your provider</h4>
        <SettingsGroup>
          <div className="p-4 space-y-4">
            <FloatingInput
              label="Issuer"
              hint="The provider's base URL, for example https://accounts.google.com"
              value={form.issuer}
              disabled={locked}
              onChange={(e) => setForm({ ...form, issuer: e.target.value })}
            />
            <FloatingInput
              label="Client ID"
              value={form.clientId}
              disabled={locked}
              onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            />
            <MorphSelect
              label="Client authentication"
              value={form.clientAuth}
              disabled={locked}
              onValueChange={(v) => setForm({ ...form, clientAuth: v })}
              items={data.clientAuthMethods.map((m) => ({
                value: m,
                label: CLIENT_AUTH_LABEL[m] ?? m,
              }))}
            />
            <FloatingInput
              label="Discovery URL (optional)"
              value={form.discoveryUrl}
              disabled={locked}
              onChange={(e) => setForm({ ...form, discoveryUrl: e.target.value })}
            />
            <FloatingInput
              label="Scopes (optional)"
              hint="Space-separated list, must include openid"
              value={form.scopes}
              disabled={locked}
              onChange={(e) => setForm({ ...form, scopes: e.target.value })}
            />
            <FloatingInput
              label="MFA ACR values (optional)"
              hint="Comma-separated values that prove MFA"
              value={form.mfaAcrValues}
              disabled={locked}
              onChange={(e) => setForm({ ...form, mfaAcrValues: e.target.value })}
            />
            <div className="flex items-center gap-3 pt-2">
              <Button onClick={save} loading={busy === "settings"} disabled={locked}>
                Save settings
              </Button>
              <OwnerNote abilities={abilities} />
            </div>
          </div>
        </SettingsGroup>
      </div>

      {form.clientAuth !== "private_key_jwt" ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Client secret</h4>
          <SettingsGroup>
            <div className="p-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                {data.clientSecretSet
                  ? "A client secret is saved. Enter a new one to rotate it."
                  : "Enter the client secret provided by your provider."}
                {data.secretExpiresAt && (
                  <span className="block mt-1 text-xs">
                    Current secret expires: <Time iso={data.secretExpiresAt} />
                  </span>
                )}
              </p>
              <FloatingInput
                label="New client secret"
                type="password"
                value={secret}
                disabled={locked}
                autoComplete="off"
                onChange={(e) => setSecret(e.target.value)}
              />
              <FloatingInput
                label="Secret expiration date (optional)"
                type="date"
                value={secretExpiresAt}
                disabled={locked}
                onChange={(e) => setSecretExpiresAt(e.target.value)}
              />
              <Button
                onClick={saveSecret}
                loading={busy === "secret"}
                disabled={locked || !secret.trim()}
              >
                Save secret
              </Button>
            </div>
          </SettingsGroup>
        </div>
      ) : (
        <OidcKeys
          connection={connection}
          data={data}
          setData={setData}
          locked={locked}
        />
      )}
    </div>
  )
}
