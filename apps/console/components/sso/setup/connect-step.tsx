"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { saveOidc, saveOidcSecret } from "@/lib/sso-actions"
import type { OidcGuide } from "@/lib/sso-guides"
import { issuerFromInput, oidcIssuerCheck } from "@/lib/sso-setup-flow"
import type { OidcSetup } from "@/lib/sso-types"
import { Numbered, SetupLinkCard, SwitchProtocol } from "./guide-parts"
import { InlineError } from "./inline-error"

export function OidcConnectStep({
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
  setup: OidcSetup
  guide: OidcGuide
  providerLabel: string
  authOrigin: string | null
  onSaved: (setup: OidcSetup) => Promise<string | null>
  onSwitchProtocol?: () => void
  switchingProtocol?: boolean
}) {
  const [org, setOrg] = React.useState(setup.issuer ?? "")
  const [clientId, setClientId] = React.useState(setup.clientId ?? "")
  const [secret, setSecret] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [issuerRefusal, setIssuerRefusal] = React.useState<string | null>(null)
  const [secretRefusal, setSecretRefusal] = React.useState<string | null>(null)
  const [generalError, setGeneralError] = React.useState<string | null>(null)

  const check = React.useMemo(() => oidcIssuerCheck(setup.provider), [setup.provider])

  const hasSecret = setup.clientSecretSet
  const complete =
    org.trim() !== "" && clientId.trim() !== "" && (hasSecret || secret !== "")

  function clearErrors() {
    setIssuerRefusal(null)
    setSecretRefusal(null)
    setGeneralError(null)
  }

  async function save() {
    setBusy(true)
    clearErrors()
    try {
      const settings = await saveOidc(connectionId, {
        issuer: issuerFromInput(org),
        clientId: clientId.trim(),
        clientAuth: setup.clientAuth ?? setup.clientAuthMethods[0],
      })
      if (!settings.ok) {
        if (/issuer/i.test(settings.error)) setIssuerRefusal(settings.error)
        else setGeneralError(settings.error)
        return
      }
      let after = settings.data
      if (secret) {
        const saved = await saveOidcSecret(connectionId, secret)
        if (!saved.ok) {
          setSecretRefusal(saved.error)
          return
        }
        after = saved.data
      }
      setSecret("")
      const err = await onSaved(after)
      if (err && /issuer/i.test(err)) setIssuerRefusal(err)
      else if (err && /secret/i.test(err)) setSecretRefusal(err)
      else setGeneralError(err)
    } finally {
      setBusy(false)
    }
  }

  async function continueGoogle() {
    setBusy(true)
    clearErrors()
    try {
      const err = await onSaved(setup)
      if (err) setGeneralError(err)
    } finally {
      setBusy(false)
    }
  }

  if (guide.noFields) {
    return (
      <div className="space-y-4">
        {onSwitchProtocol && (
          <SwitchProtocol
            to="SAML"
            disabled={switchingProtocol}
            onClick={onSwitchProtocol}
          />
        )}
        <p className="text-sm text-muted-foreground">{guide.back.body}</p>
        <InlineError message={generalError} />
        <Button onClick={() => void continueGoogle()} loading={busy}>
          Continue
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {onSwitchProtocol && (
        <SwitchProtocol
          to="SAML"
          disabled={switchingProtocol}
          onClick={onSwitchProtocol}
        />
      )}

      <ol className="space-y-5">
        {guide.steps.map((step, i) => (
          <Numbered key={step.title} n={i + 1} title={step.title}>
            <p className="text-sm text-muted-foreground">{step.body}</p>
            {step.copy === "redirectUri" && (
              <CopyField value={setup.redirectUri} className="mt-2" />
            )}
          </Numbered>
        ))}
        <Numbered n={guide.steps.length + 1} title={guide.back.title}>
          <p className="text-sm text-muted-foreground">{guide.back.body}</p>
          <form
            className="space-y-3 pt-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (complete && !busy) void save()
            }}
          >
            <ValidatedInput
              id="issuer"
              label={guide.issuer.label}
              hint={guide.issuer.hint}
              value={org}
              onChange={(event) => {
                setOrg(event.target.value)
                clearErrors()
              }}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              check={check}
              refused={issuerRefusal ?? undefined}
              reserveHint
            />
            <FloatingInput
              label={guide.clientId.label}
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value)
                clearErrors()
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <FloatingInput
              label={hasSecret ? `${guide.secret.label} (saved)` : guide.secret.label}
              type="password"
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value)
                clearErrors()
              }}
              hint={secretRefusal ?? undefined}
              state={secretRefusal ? "invalid" : "idle"}
              reserveHint={Boolean(secretRefusal)}
              autoComplete="new-password"
            />
            <InlineError message={generalError} />
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
