"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { Textarea } from "@repo/ui/components/i10/textarea"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import {
  addSamlCertificate,
  makeOidcKey,
  makeSamlSpKey,
  oidcSetup,
  refreshSamlMetadata,
  removeSamlCertificate,
  samlSetup,
  saveOidc,
  saveOidcSecret,
  saveSaml,
} from "@/lib/sso-actions"
import { Time } from "@/components/time"
import { toastDone, toastError } from "@/lib/toast"
import type { OidcSetup, SamlSetup } from "@/lib/sso-types"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import {
  Block,
  Loading,
  OwnerNote,
  ToggleRow,
  Value,
  isLocked,
  useRemote,
  useSsoCall,
} from "./shared"

/**
 * The identity provider's settings, and the values to give the IdP (sso.md
 * 2.10). The secrets are write-only: once saved the page can say only THAT one
 * is set, because no route returns it.
 */

const CLIENT_AUTH_LABEL: Record<string, string> = {
  client_secret_basic: "Client secret (basic)",
  client_secret_post: "Client secret (post)",
  private_key_jwt: "Private key JWT",
}

export function IdpSetup(props: {
  connection: SsoConnection
  abilities: SsoAbilities
}) {
  return props.connection.protocol === "saml" ? (
    <SamlSetupForm {...props} />
  ) : (
    <OidcSetupForm {...props} />
  )
}

// ── OIDC ────────────────────────────────────────────────────────────────────

function OidcSetupForm(props: { connection: SsoConnection; abilities: SsoAbilities }) {
  const { data, setData, failed } = useRemote(() => oidcSetup(props.connection.id))
  if (!data) return <Loading failed={failed} />
  return <OidcForm {...props} data={data} setData={setData} />
}

function OidcForm({
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
    mfaAcrValues: data.mfaAcrValues.join(", "),
  })
  const [secret, setSecret] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)

  const google = data.provider === "google"

  async function save() {
    setBusy("settings")
    try {
      const body: Parameters<typeof saveOidc>[1] = {}
      if (form.issuer.trim() !== (data.issuer ?? "")) body.issuer = form.issuer.trim()
      if (form.discoveryUrl.trim() !== (data.discoveryUrl ?? ""))
        body.discoveryUrl = form.discoveryUrl.trim() || null
      if (form.clientId.trim() !== (data.clientId ?? ""))
        body.clientId = form.clientId.trim()
      // ⚠ AGAINST WHAT IS STORED, NOT WHAT IS SHOWN. A new connection shows the
      // first method as chosen while none is saved; comparing with the shown
      // default never sent it, and the connection could never become ready.
      if (form.clientAuth !== data.clientAuth) body.clientAuth = form.clientAuth
      const acr = form.mfaAcrValues
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
      if (acr.join(",") !== data.mfaAcrValues.join(",")) body.mfaAcrValues = acr
      if (Object.keys(body).length === 0) {
        toastDone("Nothing to save", "These are already the saved settings.")
        return
      }
      const after = await call(() => saveOidc(connection.id, body), {
        title: "Could not save the settings",
      })
      if (after) {
        setData(after)
        toastDone("Settings saved")
      }
    } finally {
      setBusy(null)
    }
  }

  async function saveSecret() {
    setBusy("secret")
    try {
      const after = await call(() => saveOidcSecret(connection.id, secret), {
        title: "Could not save the secret",
      })
      if (after) {
        setData(after)
        setSecret("")
        toastDone(data.clientSecretSet ? "Secret replaced" : "Secret saved")
      }
    } finally {
      setBusy(null)
    }
  }

  async function newKey() {
    setBusy("key")
    try {
      const after = await call(() => makeOidcKey(connection.id), {
        title: "Could not make a key",
      })
      if (after) {
        setData(after)
        toastDone("Signing key made", "Give your provider the keys URL below.")
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Block
        title="Give your identity provider these"
        description={`Paste them into ${data.label} when you create the application.`}
      >
        <Value label="Redirect URI" value={data.redirectUri} />
        {form.clientAuth === "private_key_jwt" && !google && (
          <Value label="Public keys URL (JWKS)" value={data.jwksUrl} />
        )}
        {data.requires.length > 0 && (
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {data.requires.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Block>

      {google ? (
        <Block
          title="Nothing to enter"
          description="Google Workspace sign-in uses i10's own Google client. Only people whose Google domain is one of this connection's verified domains can sign in."
        />
      ) : (
        <>
          <Block
            title="Your provider's settings"
            description="Copy these from the application you created."
          >
            <FloatingInput
              label="Issuer"
              hint={data.issuerHint ? `Looks like ${data.issuerHint}` : undefined}
              value={form.issuer}
              disabled={locked}
              onChange={(e) => setForm({ ...form, issuer: e.target.value })}
            />
            <FloatingInput
              label="Discovery URL (optional)"
              value={form.discoveryUrl}
              disabled={locked}
              onChange={(e) => setForm({ ...form, discoveryUrl: e.target.value })}
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
              label="Authentication context values that prove MFA (optional)"
              hint="Comma separated. Needed only when you require MFA at the provider and it sends an acr."
              value={form.mfaAcrValues}
              disabled={locked}
              onChange={(e) => setForm({ ...form, mfaAcrValues: e.target.value })}
            />
            <div className="flex items-center gap-3">
              <Button onClick={save} loading={busy === "settings"} disabled={locked}>
                Save settings
              </Button>
              <OwnerNote abilities={abilities} />
            </div>
          </Block>

          {form.clientAuth === "private_key_jwt" ? (
            <Block
              title="Signing key"
              description="We sign our requests to your provider with a key we make. Give the provider the public keys URL above."
            >
              {data.keys.length > 0 ? (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {data.keys.map((k) => (
                    <li key={k.kid}>
                      <span className="font-mono">{k.kid}</span> &middot; made{" "}
                      <Time iso={k.createdAt} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No key made yet.</p>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={newKey}
                loading={busy === "key"}
                disabled={locked}
              >
                {data.keys.length ? "Rotate the key" : "Make a key"}
              </Button>
            </Block>
          ) : (
            <Block
              title="Client secret"
              description={
                data.clientSecretSet
                  ? "A secret is saved. It cannot be shown again; enter a new one to replace it."
                  : "Paste the client secret from your provider. It is stored encrypted and is never shown again."
              }
            >
              <FloatingInput
                label={data.clientSecretSet ? "New client secret" : "Client secret"}
                type="password"
                autoComplete="off"
                value={secret}
                disabled={locked}
                onChange={(e) => setSecret(e.target.value)}
              />
              <Button
                onClick={saveSecret}
                loading={busy === "secret"}
                disabled={locked || secret.trim().length === 0}
              >
                {data.clientSecretSet ? "Replace secret" : "Save secret"}
              </Button>
            </Block>
          )}
        </>
      )}
      <ReadyNote ready={data.ready} />
    </>
  )
}

function ReadyNote({ ready }: { ready: boolean }) {
  return (
    <p className="pt-4 text-sm text-muted-foreground">
      {ready
        ? "These settings are complete. Run a test sign-in on the Test tab."
        : "Finish these settings before you can test or activate the connection."}
    </p>
  )
}

// ── SAML ────────────────────────────────────────────────────────────────────

function SamlSetupForm(props: { connection: SsoConnection; abilities: SsoAbilities }) {
  const { data, setData, failed } = useRemote(() => samlSetup(props.connection.id))
  if (!data) return <Loading failed={failed} />
  return <SamlForm {...props} data={data} setData={setData} />
}

function SamlForm({
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
  const [pem, setPem] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const file = React.useRef<HTMLInputElement>(null)

  async function apply(
    label: string,
    fn: () => ReturnType<typeof saveSaml>,
    done: string,
  ) {
    setBusy(label)
    try {
      const after = await call(fn, { title: "Could not save the settings" })
      if (after) {
        setData(after)
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
    // The API caps the document at 256 KiB; refuse a larger file here rather than send it.
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

  const spCert = data.spCertificates[0]

  return (
    <>
      <Block
        title="Give your identity provider these"
        description={`Paste them into ${data.label} when you create the application.`}
      >
        <Value label="Entity ID (Audience)" value={data.entityId} />
        <Value label="ACS URL (Reply URL)" value={data.acsUrl} />
        <Value label="Logout URL" value={data.sloUrl} />
        <Value label="Metadata URL" value={data.metadataUrl} />
        {data.requires.length > 0 && (
          <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {data.requires.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        title="Your provider's metadata"
        description="The quickest way: give us the metadata URL, or upload the file. Or enter the values by hand below."
      >
        <FloatingInput
          label="Metadata URL"
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
                  const after = await call(() => refreshSamlMetadata(connection.id), {
                    stepUp: false,
                    title: "Could not fetch the metadata",
                  })
                  if (after) {
                    setData(after)
                    toastDone("Metadata fetched")
                  }
                } finally {
                  setBusy(null)
                }
              }}
            >
              Fetch it now
            </Button>
          )}
        </div>
        {data.metadataFetchedAt && (
          <p className="text-xs text-muted-foreground">
            Last fetched <Time iso={data.metadataFetchedAt} />
          </p>
        )}
        {data.metadataError && (
          <p className="text-xs text-destructive">
            The last fetch failed: {data.metadataError}
          </p>
        )}
      </Block>

      <Block
        title="Provider values"
        description="Filled in from the metadata when you give us one."
      >
        <FloatingInput
          label="Provider entity ID"
          hint={data.entityIdHint ? `Looks like ${data.entityIdHint}` : undefined}
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
          hint="An immutable attribute such as an employee id, if the name id is the email."
          value={form.subjectAttribute}
          disabled={locked}
          onChange={(e) => setForm({ ...form, subjectAttribute: e.target.value })}
        />
        <ToggleRow
          label="Sign our requests"
          description="Upload our certificate below at your provider so it can check them."
          checked={form.signRequests}
          disabled={locked}
          onChange={(v) => setForm({ ...form, signRequests: v })}
        />
        <ToggleRow
          label="Require encrypted assertions"
          description="Refuse any response your provider did not encrypt to our certificate."
          checked={form.requireEncryption}
          disabled={locked}
          onChange={(v) => setForm({ ...form, requireEncryption: v })}
        />
        <ToggleRow
          label="Allow sign-in started at your provider"
          description="Lets people open i10 from your provider's app list. Off, only sign-ins we start are accepted."
          checked={form.idpInitiated}
          disabled={locked}
          onChange={(v) => setForm({ ...form, idpInitiated: v })}
        />
        <div className="flex items-center gap-3">
          <Button onClick={save} loading={busy === "settings"} disabled={locked}>
            Save settings
          </Button>
          <OwnerNote abilities={abilities} />
        </div>
      </Block>

      <Block
        title="Provider certificates"
        description="Responses must be signed by one of these. A metadata file or URL fills them in; you can also add one."
      >
        {data.certificates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No certificate yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {data.certificates.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.subject}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {c.fingerprint}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Valid until <Time iso={c.notAfter} mode="exact" />
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={async () => {
                    const after = await call(
                      () => removeSamlCertificate(connection.id, c.id),
                      { title: "Could not remove the certificate" },
                    )
                    if (after) {
                      setData(after)
                      toastDone("Certificate removed")
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          aria-label="Certificate (PEM)"
          placeholder="-----BEGIN CERTIFICATE-----"
          rows={4}
          value={pem}
          disabled={locked}
          onChange={(e) => setPem(e.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          loading={busy === "certificate"}
          disabled={locked || pem.trim().length === 0}
          onClick={async () => {
            const after = await apply(
              "certificate",
              () => addSamlCertificate(connection.id, pem.trim()),
              "Certificate added",
            )
            if (after) setPem("")
          }}
        >
          Add certificate
        </Button>
      </Block>

      <Block
        title="Our certificate"
        description="Give this to your provider if you sign requests or want encrypted assertions."
      >
        {spCert ? (
          <>
            <Value label="Fingerprint" value={spCert.fingerprint} />
            <Value label="Certificate (PEM)" value={spCert.certificate} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            It is made the first time you save these settings.
          </p>
        )}
        {spCert && (
          <Button
            variant="secondary"
            size="sm"
            loading={busy === "spkey"}
            disabled={locked}
            onClick={async () => {
              setBusy("spkey")
              try {
                const after = await call(() => makeSamlSpKey(connection.id), {
                  title: "Could not rotate our certificate",
                })
                if (after) {
                  setData(after)
                  toastDone("New certificate made", "Give it to your provider.")
                }
              } finally {
                setBusy(null)
              }
            }}
          >
            Rotate our certificate
          </Button>
        )}
      </Block>
      <ReadyNote ready={data.ready} />
    </>
  )
}
