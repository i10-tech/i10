"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { Switch } from "@repo/ui/components/i10/switch"
import { refreshSamlMetadata, saveSaml } from "@/lib/sso-actions"
import { toastDone, toastError } from "@/lib/toast"
import type { SamlSetup, SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import {
  connectionWriteNeedsStepUp,
  isLocked,
  OwnerNote,
  useSsoCall,
} from "../shared"
import { SamlCertificates } from "./saml-certificates"
import { SamlSpValues } from "./saml-sp-values"

export function SamlSettings({
  connection,
  abilities,
  data,
  setData,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  data: SamlSetup
  setData: (next: SamlSetup) => void
}) {
  const call = useSsoCall()
  const locked = isLocked(connection, abilities)
  const [form, setForm] = React.useState({
    idpEntityId: data.idpEntityId ?? "",
    ssoUrl: data.ssoUrl ?? "",
    sloUrl: data.idpSloUrl ?? "",
    metadataUrl: data.idpMetadataUrl ?? "",
    subjectAttribute: data.subjectAttribute ?? "",
    signRequests: data.signRequests,
    requireEncryption: data.requireEncryption,
    idpInitiated: data.idpInitiated,
  })
  const [busy, setBusy] = React.useState<string | null>(null)
  const file = React.useRef<HTMLInputElement>(null)

  async function apply(
    label: string,
    fn: () => ReturnType<typeof saveSaml>,
    done: string,
  ) {
    setBusy(label)
    try {
      const after = await call(fn, {
        stepUp: connectionWriteNeedsStepUp(connection),
        title: "Could not save the settings",
      })
      if (after) {
        setData(after)
        setForm({
          idpEntityId: after.idpEntityId ?? "",
          ssoUrl: after.ssoUrl ?? "",
          sloUrl: after.idpSloUrl ?? "",
          metadataUrl: after.idpMetadataUrl ?? "",
          subjectAttribute: after.subjectAttribute ?? "",
          signRequests: after.signRequests,
          requireEncryption: after.requireEncryption,
          idpInitiated: after.idpInitiated,
        })
        toastDone(done)
      }
      return after
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    const body: Parameters<typeof saveSaml>[1] = {}
    if (form.idpEntityId.trim() !== (data.idpEntityId ?? ""))
      body.idpEntityId = form.idpEntityId.trim()
    if (form.ssoUrl.trim() !== (data.ssoUrl ?? "")) body.ssoUrl = form.ssoUrl.trim()
    if (form.sloUrl.trim() !== (data.idpSloUrl ?? ""))
      body.sloUrl = form.sloUrl.trim() || null
    if (form.metadataUrl.trim() !== (data.idpMetadataUrl ?? ""))
      body.metadataUrl = form.metadataUrl.trim() || null
    if (form.subjectAttribute.trim() !== (data.subjectAttribute ?? ""))
      body.subjectAttribute = form.subjectAttribute.trim() || null
    if (form.signRequests !== data.signRequests) body.signRequests = form.signRequests
    if (form.requireEncryption !== data.requireEncryption)
      body.requireEncryption = form.requireEncryption
    if (form.idpInitiated !== data.idpInitiated) body.idpInitiated = form.idpInitiated
    if (Object.keys(body).length === 0) {
      toastDone("Nothing to save", "These are already the saved settings.")
      return
    }
    await apply("settings", () => saveSaml(connection.id, body), "Settings saved")
  }

  async function uploadMetadata(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0]
    event.target.value = ""
    if (!chosen) return
    if (chosen.size > 256 * 1024) {
      toastError("That file is too large", "A metadata file is at most 256 KiB.")
      return
    }
    const xml = await chosen.text()
    await apply(
      "metadata",
      () => saveSaml(connection.id, { metadataXml: xml }),
      "Metadata read",
    )
  }

  return (
    <div className="space-y-6">
      <SamlSpValues data={data} />

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Values from your provider</h4>
        <SettingsGroup>
          <div className="p-4 space-y-4">
            <FloatingInput
              label="Metadata URL"
              hint={
                connection.provider === "okta"
                  ? "In Okta: the app's Sign On tab, Metadata URL."
                  : undefined
              }
              value={form.metadataUrl}
              disabled={locked}
              onChange={(e) => setForm({ ...form, metadataUrl: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => file.current?.click()}
                loading={busy === "metadata"}
                disabled={locked}
              >
                Upload metadata file
              </Button>
              <input
                ref={file}
                type="file"
                accept=".xml,application/xml,text/xml"
                className="hidden"
                onChange={uploadMetadata}
              />
              {data.idpMetadataUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === "refresh"}
                  onClick={async () => {
                    setBusy("refresh")
                    try {
                      const after = await call(
                        () => refreshSamlMetadata(connection.id),
                        {
                          stepUp: false,
                          title: "Could not fetch metadata",
                        },
                      )
                      if (after) {
                        setData(after)
                        setForm({
                          idpEntityId: after.idpEntityId ?? "",
                          ssoUrl: after.ssoUrl ?? "",
                          sloUrl: after.idpSloUrl ?? "",
                          metadataUrl: after.idpMetadataUrl ?? "",
                          subjectAttribute: after.subjectAttribute ?? "",
                          signRequests: after.signRequests,
                          requireEncryption: after.requireEncryption,
                          idpInitiated: after.idpInitiated,
                        })
                        toastDone("Metadata refreshed")
                      }
                    } finally {
                      setBusy(null)
                    }
                  }}
                  disabled={locked}
                >
                  Refresh metadata
                </Button>
              )}
            </div>

            <FloatingInput
              label="Identity provider Entity ID"
              value={form.idpEntityId}
              disabled={locked}
              onChange={(e) => setForm({ ...form, idpEntityId: e.target.value })}
            />
            <FloatingInput
              label="Single sign-on URL"
              value={form.ssoUrl}
              disabled={locked}
              onChange={(e) => setForm({ ...form, ssoUrl: e.target.value })}
            />
            <FloatingInput
              label="Single logout URL (optional)"
              value={form.sloUrl}
              disabled={locked}
              onChange={(e) => setForm({ ...form, sloUrl: e.target.value })}
            />
            <FloatingInput
              label="Subject attribute (optional)"
              hint="Immutable attribute, if email is not the NameID."
              value={form.subjectAttribute}
              disabled={locked}
              onChange={(e) => setForm({ ...form, subjectAttribute: e.target.value })}
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

      <SamlCertificates
        connection={connection}
        data={data}
        setData={setData}
        locked={locked}
        abilities={abilities}
      />

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Signing and encryption</h4>
        <SettingsGroup>
          <SettingsRow
            title="Sign our requests"
            description="Sign SAML authentication requests with our private key."
            action={
              <Switch
                checked={form.signRequests}
                disabled={locked}
                onCheckedChange={(v) => {
                  setForm({ ...form, signRequests: v })
                  void apply(
                    "sign",
                    () => saveSaml(connection.id, { signRequests: v }),
                    "Saved",
                  )
                }}
                aria-label="Sign our requests"
              />
            }
          />
          <SettingsRow
            title="Require encrypted assertions"
            description="Refuse assertions that are not encrypted."
            action={
              <Switch
                checked={form.requireEncryption}
                disabled={locked}
                onCheckedChange={(v) => {
                  setForm({ ...form, requireEncryption: v })
                  void apply(
                    "encrypt",
                    () => saveSaml(connection.id, { requireEncryption: v }),
                    "Saved",
                  )
                }}
                aria-label="Require encrypted assertions"
              />
            }
          />
          <SettingsRow
            title="Identity provider initiated sign-in"
            description="Allow sign-in to start from your identity provider portal."
            action={
              <Switch
                checked={form.idpInitiated}
                disabled={locked}
                onCheckedChange={(v) => {
                  setForm({ ...form, idpInitiated: v })
                  void apply(
                    "idpInit",
                    () => saveSaml(connection.id, { idpInitiated: v }),
                    "Saved",
                  )
                }}
                aria-label="Identity provider initiated sign-in"
              />
            }
          />
        </SettingsGroup>
      </div>
    </div>
  )
}
