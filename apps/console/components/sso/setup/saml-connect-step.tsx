"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import { Textarea } from "@repo/ui/components/i10/textarea"
import { httpsUrlProblem, type Check } from "@repo/ui/checks"
import SegmentedControl from "@repo/ui/components/segmented-control/segmented-control"
import { addSamlCertificate, refreshSamlMetadata, saveSaml } from "@/lib/sso-actions"
import type { SamlGuide } from "@/lib/sso-guides"
import type { SamlSetup } from "@/lib/sso-types"
import { Numbered, SetupLinkCard, SwitchProtocol } from "./guide-parts"
import { InlineError } from "./inline-error"

const OKTA_METADATA_HINT =
  "Okta's public metadata URL uses the app's exk key, not 0oa. Copy the Metadata URL from the app's Sign On tab."

const TABS = [
  { value: "url", label: "Metadata URL" },
  { value: "file", label: "Upload a file" },
  { value: "manual", label: "Enter by hand" },
]

export function SamlConnectStep({
  connectionId,
  setup,
  guide,
  providerLabel,
  authOrigin,
  onSaved,
  onSwitchProtocol,
  switchingProtocol,
}: {
  connectionId: string
  setup: SamlSetup
  guide: SamlGuide
  providerLabel: string
  authOrigin: string | null
  onSaved: (setup: SamlSetup) => Promise<string | null>
  onSwitchProtocol?: () => void
  switchingProtocol?: boolean
}) {
  const [tab, setTab] = React.useState<string>("url")
  const [metadataUrl, setMetadataUrl] = React.useState(setup.idpMetadataUrl ?? "")
  const [fileName, setFileName] = React.useState<string | null>(null)
  const [xmlContent, setXmlContent] = React.useState<string | null>(null)
  const [idpEntityId, setIdpEntityId] = React.useState(setup.idpEntityId ?? "")
  const [ssoUrl, setSsoUrl] = React.useState(setup.ssoUrl ?? "")
  const [sloUrl, setSloUrl] = React.useState(setup.idpSloUrl ?? "")
  const [pem, setPem] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const samlMetadataCheck: Check = React.useCallback(
    (value: string) => {
      const problem = httpsUrlProblem(value)
      if (problem) return problem
      if (setup.provider === "okta" && value.includes("/app/0oa")) {
        return OKTA_METADATA_HINT
      }
      return null
    },
    [setup.provider],
  )

  const metadataRefusal =
    tab === "url"
      ? (error ??
        (setup.metadataError
          ? setup.provider === "okta" && setup.idpMetadataUrl?.includes("0oa")
            ? OKTA_METADATA_HINT
            : `We could not read that metadata: ${setup.metadataError}`
          : undefined))
      : undefined

  const hasCert = setup.certificates.length > 0
  const complete =
    tab === "url"
      ? metadataUrl.trim() !== "" || setup.ready
      : tab === "file"
        ? xmlContent !== null || setup.ready
        : idpEntityId.trim() !== "" &&
          ssoUrl.trim() !== "" &&
          (hasCert || pem.trim() !== "")

  async function onFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (file.size > 256 * 1024) {
      setError("That file is too large. A metadata file is at most 256 KiB.")
      return
    }
    try {
      const text = await file.text()
      setXmlContent(text)
      setFileName(file.name)
      setError(null)
    } catch {
      setError("Could not read that file.")
    }
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      let after: SamlSetup | null = null

      if (tab === "url") {
        const url = metadataUrl.trim()
        if (setup.provider === "okta" && url.includes("/app/0oa")) {
          setError(OKTA_METADATA_HINT)
          return
        }
        const saved = await saveSaml(connectionId, { metadataUrl: url })
        if (!saved.ok) {
          setError(saved.error)
          return
        }
        after = saved.data
        if (!after.ready && after.idpMetadataUrl) {
          const refreshed = await refreshSamlMetadata(connectionId)
          if (refreshed.ok) after = refreshed.data
        }
      } else if (tab === "file") {
        if (!xmlContent) {
          setError("Choose a metadata XML file first.")
          return
        }
        const saved = await saveSaml(connectionId, { metadataXml: xmlContent })
        if (!saved.ok) {
          setError(saved.error)
          return
        }
        after = saved.data
      } else {
        const saved = await saveSaml(connectionId, {
          idpEntityId: idpEntityId.trim(),
          ssoUrl: ssoUrl.trim(),
          sloUrl: sloUrl.trim() || null,
        })
        if (!saved.ok) {
          setError(saved.error)
          return
        }
        after = saved.data
        if (pem.trim()) {
          const certSaved = await addSamlCertificate(connectionId, pem.trim())
          if (!certSaved.ok) {
            setError(certSaved.error)
            return
          }
          after = certSaved.data
          setPem("")
        }
      }

      if (!after) return
      const err = await onSaved(after)
      if (err) setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {onSwitchProtocol && (
        <SwitchProtocol
          to="OIDC"
          disabled={switchingProtocol}
          onClick={onSwitchProtocol}
        />
      )}

      <ol className="space-y-5">
        {guide.steps.map((step, i) => (
          <Numbered key={step.title} n={i + 1} title={step.title}>
            <p className="text-sm text-muted-foreground">{step.body}</p>
            {step.copyFields && (
              <div className="space-y-2 pt-1">
                {step.copyFields.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {field.label}
                      {field.hint && (
                        <span className="ml-1 opacity-75">({field.hint})</span>
                      )}
                    </p>
                    <CopyField value={setup[field.key] ?? ""} />
                  </div>
                ))}
              </div>
            )}
          </Numbered>
        ))}

        <Numbered n={guide.steps.length + 1} title={guide.back.title}>
          <p className="text-sm text-muted-foreground">{guide.back.body}</p>
          <div className="pt-2">
            <SegmentedControl
              options={TABS}
              value={tab}
              onValueChange={setTab}
              label="How to provide SAML metadata"
            />
          </div>

          <form
            className="space-y-3 pt-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (complete && !busy) void save()
            }}
          >
            <StepStage step={tab} morph={false}>
              {tab === "url" && (
                <div>
                  <ValidatedInput
                    id="metadata-url"
                    label="Metadata URL"
                    hint={guide.metadataUrlHint}
                    value={metadataUrl}
                    onChange={(event) => {
                      setMetadataUrl(event.target.value)
                      setError(null)
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                    check={samlMetadataCheck}
                    refused={metadataRefusal}
                    reserveHint
                  />
                </div>
              )}

              {tab === "file" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {fileName ? "Choose a different file" : "Choose metadata file"}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xml,application/xml,text/xml"
                      className="hidden"
                      onChange={(e) => void onFileSelected(e)}
                    />
                    {fileName && (
                      <span className="truncate text-xs text-muted-foreground">
                        {fileName}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload the XML metadata file exported from your provider.
                  </p>
                </div>
              )}

              {tab === "manual" && (
                <div className="space-y-3">
                  <FloatingInput
                    label="Provider entity ID"
                    hint={guide.entityIdHint}
                    value={idpEntityId}
                    onChange={(event) => setIdpEntityId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FloatingInput
                    label="Single sign-on URL"
                    value={ssoUrl}
                    onChange={(event) => setSsoUrl(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FloatingInput
                    label="Single logout URL (optional)"
                    value={sloUrl}
                    onChange={(event) => setSloUrl(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      {hasCert
                        ? "Certificate saved. Paste another to add or replace."
                        : "Certificate (PEM)"}
                    </p>
                    <Textarea
                      aria-label="Certificate (PEM)"
                      placeholder="-----BEGIN CERTIFICATE-----"
                      rows={3}
                      value={pem}
                      onChange={(event) => setPem(event.target.value)}
                    />
                  </div>
                </div>
              )}
            </StepStage>

            <InlineError message={tab === "url" ? null : error} />

            <Button type="submit" loading={busy} disabled={!complete}>
              Save and continue
            </Button>
          </form>
        </Numbered>
      </ol>

      <SetupLinkCard
        connectionId={connectionId}
        providerLabel={providerLabel}
        authOrigin={authOrigin}
      />
    </div>
  )
}
