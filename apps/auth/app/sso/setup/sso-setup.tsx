"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { StepHeading } from "../../_components/step-heading"
import { takeToken } from "./token"

/**
 * The IT contact's setup page (#340). Every call goes through
 * `/api/sso/setup`; the token is kept in memory and sessionStorage and sent in
 * the body, never in a URL this app serves.
 *
 * ⚠ SHOWS NOTHING BUT WHAT THE LINK'S ROUTES RETURN: the connection's name and
 * protocol, our values to give the identity provider, and the provider's
 * non-secret settings. No secret is ever read back; a saved secret is just
 * "set".
 */

interface View {
  connection: {
    id: string
    name: string
    protocol: "oidc" | "saml" | "test"
    provider: string
    status: string
  }
  oidc: {
    provider: string
    label: string
    redirectUri: string
    jwksUrl: string
    requires: string[]
    issuerHint: string | null
    issuer: string | null
    discoveryUrl: string | null
    clientId: string | null
    clientAuth: string | null
    clientSecretSet: boolean
    ready: boolean
  } | null
  saml: {
    label: string
    entityId: string
    acsUrl: string
    sloUrl: string
    metadataUrl: string
    requires: string[]
    idpEntityId: string | null
    ssoUrl: string | null
    idpMetadataUrl: string | null
    certificates: {
      id: string
      fingerprint: string
      subject: string
      notAfter: string
    }[]
    ready: boolean
  } | null
}

type Op = "view" | "oidc" | "oidc-secret" | "saml" | "saml-certificate" | "test"

async function ask(
  token: string,
  op: Op,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const response = await fetch("/api/sso/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, token, payload }),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: response.ok, status: response.status, body }
  } catch {
    return {
      ok: false,
      status: 503,
      body: { message: "Setup is temporarily unavailable. Try again in a moment." },
    }
  }
}

export function SsoSetup() {
  /*
   * ⚠ THE FIRST THING THAT RUNS: it moves the token out of the address bar.
   * `undefined` on the server and until the browser has looked; `takeToken` is
   * safe to call again (it then reads sessionStorage), which a store read must be.
   */
  const token = useSyncExternalStore(
    () => () => {},
    takeToken,
    () => undefined,
  )
  const [view, setView] = useState<View | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!token) return
    let live = true
    void ask(token, "view").then((answer) => {
      if (!live) return
      if (answer.ok) {
        setView(answer.body as unknown as View)
        setProblem(null)
      } else
        setProblem(
          typeof answer.body.message === "string"
            ? answer.body.message
            : "This setup link is not valid. Ask your contact for a new one.",
        )
      // A finished test comes back with its result in the fragment.
      const result = new URLSearchParams(window.location.hash.slice(1)).get("sso_test")
      if (result) {
        window.history.replaceState(null, "", "/sso/setup")
        setNotice(
          result === "passed"
            ? "The test sign-in passed. Tell your contact; they can activate the connection."
            : "The test sign-in failed. Check the settings below and try again; your contact can see why.",
        )
      }
    })
    return () => {
      live = false
    }
  }, [token, version])

  if (token === undefined) return null
  if (token === null)
    return (
      <StepHeading title="This link is not valid">
        Ask your contact for a new setup link.
      </StepHeading>
    )
  if (problem)
    return <StepHeading title="This link is not valid">{problem}</StepHeading>
  if (!view)
    return <p className="text-center text-sm text-muted-foreground">Loading…</p>

  const refresh = () => setVersion((v) => v + 1)
  return (
    <div className="flex flex-col gap-8">
      <StepHeading title={`Set up ${view.connection.name}`}>
        Enter your identity provider&rsquo;s settings, then run a test sign-in.
      </StepHeading>
      {notice && (
        <p className="rounded-lg border bg-muted/40 p-3 text-center text-sm">
          {notice}
        </p>
      )}
      {view.oidc && <OidcPart token={token} view={view.oidc} onSaved={refresh} />}
      {view.saml && <SamlPart token={token} view={view.saml} onSaved={refresh} />}
      <TestPart
        token={token}
        ready={(view.oidc ?? view.saml)?.ready === true}
        status={view.connection.status}
      />
    </div>
  )
}

function Values({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="space-y-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all select-all">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Requires({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}

function useSave(token: string, op: Op, onSaved: () => void) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const save = async (payload: Record<string, unknown>) => {
    setBusy(true)
    setMessage(null)
    const answer = await ask(token, op, payload)
    setBusy(false)
    if (answer.ok) {
      setMessage("Saved.")
      onSaved()
      return true
    }
    setMessage(
      typeof answer.body.message === "string" ? answer.body.message : "Not saved.",
    )
    return false
  }
  return { busy, message, save }
}

function OidcPart({
  token,
  view,
  onSaved,
}: {
  token: string
  view: NonNullable<View["oidc"]>
  onSaved: () => void
}) {
  const [issuer, setIssuer] = useState(view.issuer ?? "")
  const [clientId, setClientId] = useState(view.clientId ?? "")
  const [secret, setSecret] = useState("")
  const settings = useSave(token, "oidc", onSaved)
  const secrets = useSave(token, "oidc-secret", onSaved)
  return (
    <>
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Give {view.label} these</h2>
        <Values rows={[["Redirect URI", view.redirectUri]]} />
        <Requires lines={view.requires} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Your settings</h2>
        <FloatingInput
          label="Issuer"
          hint={view.issuerHint ? `Looks like ${view.issuerHint}` : undefined}
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
        />
        <FloatingInput
          label="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
        <Button
          loading={settings.busy}
          onClick={() =>
            void settings.save({ issuer: issuer.trim(), clientId: clientId.trim() })
          }
        >
          Save settings
        </Button>
        {settings.message && (
          <p className="text-sm text-muted-foreground">{settings.message}</p>
        )}
        {view.provider !== "google" && (
          <>
            <FloatingInput
              label={view.clientSecretSet ? "New client secret" : "Client secret"}
              type="password"
              autoComplete="off"
              hint={
                view.clientSecretSet
                  ? "A secret is saved. It is never shown again."
                  : undefined
              }
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <Button
              variant="secondary"
              loading={secrets.busy}
              disabled={secret.trim().length === 0}
              onClick={async () => {
                if (await secrets.save({ clientSecret: secret })) setSecret("")
              }}
            >
              {view.clientSecretSet ? "Replace secret" : "Save secret"}
            </Button>
            {secrets.message && (
              <p className="text-sm text-muted-foreground">{secrets.message}</p>
            )}
          </>
        )}
      </section>
    </>
  )
}

function SamlPart({
  token,
  view,
  onSaved,
}: {
  token: string
  view: NonNullable<View["saml"]>
  onSaved: () => void
}) {
  const [metadataUrl, setMetadataUrl] = useState(view.idpMetadataUrl ?? "")
  const [entityId, setEntityId] = useState(view.idpEntityId ?? "")
  const [ssoUrl, setSsoUrl] = useState(view.ssoUrl ?? "")
  const [pem, setPem] = useState("")
  const file = useRef<HTMLInputElement>(null)
  const settings = useSave(token, "saml", onSaved)
  const certificates = useSave(token, "saml-certificate", onSaved)

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0]
    event.target.value = ""
    // The API takes a metadata document of at most 256 KiB.
    if (!chosen || chosen.size > 256 * 1024) return
    await settings.save({ metadataXml: await chosen.text() })
  }

  return (
    <>
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Give {view.label} these</h2>
        <Values
          rows={[
            ["Entity ID (Audience)", view.entityId],
            ["ACS URL (Reply URL)", view.acsUrl],
            ["Logout URL", view.sloUrl],
            ["Metadata URL", view.metadataUrl],
          ]}
        />
        <Requires lines={view.requires} />
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">Your settings</h2>
        <FloatingInput
          label="Metadata URL"
          value={metadataUrl}
          onChange={(e) => setMetadataUrl(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              void settings.save({ metadataUrl: metadataUrl.trim() || null })
            }
            loading={settings.busy}
          >
            Use this metadata URL
          </Button>
          <Button variant="secondary" onClick={() => file.current?.click()}>
            Upload a metadata file
          </Button>
          <input
            ref={file}
            type="file"
            accept=".xml,application/xml,text/xml"
            className="hidden"
            onChange={upload}
          />
        </div>
        <FloatingInput
          label="Provider entity ID"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
        />
        <FloatingInput
          label="Single sign-on URL"
          value={ssoUrl}
          onChange={(e) => setSsoUrl(e.target.value)}
        />
        <Button
          loading={settings.busy}
          onClick={() =>
            void settings.save({ idpEntityId: entityId.trim(), ssoUrl: ssoUrl.trim() })
          }
        >
          Save settings
        </Button>
        {settings.message && (
          <p className="text-sm text-muted-foreground">{settings.message}</p>
        )}
        {view.certificates.length > 0 && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {view.certificates.map((c) => (
              <li key={c.id} className="break-all">
                {c.subject} <span className="font-mono text-xs">{c.fingerprint}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          aria-label="Provider certificate (PEM)"
          placeholder="-----BEGIN CERTIFICATE-----"
          rows={4}
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          className="w-full rounded-lg border bg-background p-3 font-mono text-xs"
        />
        <Button
          variant="secondary"
          loading={certificates.busy}
          disabled={pem.trim().length === 0}
          onClick={async () => {
            if (await certificates.save({ certificate: pem.trim() })) setPem("")
          }}
        >
          Add certificate
        </Button>
        {certificates.message && (
          <p className="text-sm text-muted-foreground">{certificates.message}</p>
        )}
      </section>
    </>
  )
}

function TestPart({
  token,
  ready,
  status,
}: {
  token: string
  ready: boolean
  status: string
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const testable = ready && status === "testing"
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Test sign-in</h2>
      <p className="text-sm text-muted-foreground">
        {testable
          ? "Sign in at your identity provider as yourself. Nobody is signed in; the result is recorded for your contact."
          : ready
            ? "Your contact needs to move the connection to testing before you can run a test."
            : "Finish the settings above to run a test."}
      </p>
      <Button
        loading={busy}
        disabled={!testable}
        onClick={async () => {
          setBusy(true)
          setMessage(null)
          const answer = await ask(token, "test")
          if (answer.ok && typeof answer.body.redirectUrl === "string") {
            window.location.assign(answer.body.redirectUrl)
            return
          }
          setBusy(false)
          setMessage(
            typeof answer.body.message === "string"
              ? answer.body.message
              : "We could not start the test.",
          )
        }}
      >
        Run a test sign-in
      </Button>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </section>
  )
}
