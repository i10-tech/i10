"use client"

import * as React from "react"
import { motion } from "motion/react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { createDirectory, issueDirectoryToken } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoDirectories, SsoDirectory } from "@/lib/sso-types"
import { IdpMark } from "../idp-mark"
import { InlineError } from "../setup/inline-error"
import type { useSsoCall } from "../shared"
import { PROVIDER_LABEL } from "./types"

interface CreatedScim {
  directory: SsoDirectory
  baseUrl: string
  token: string
}

const PROVIDERS = [
  { id: "okta", label: "Okta" },
  { id: "entra", label: "Microsoft Entra ID" },
  { id: "google", label: "Google Workspace" },
  { id: "generic", label: "Custom SCIM" },
]

export function AddDirectoryFlow({
  data,
  call,
  onDone,
  onCancel,
}: {
  data: SsoDirectories
  call: ReturnType<typeof useSsoCall>
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [selected, setSelected] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [adminEmail, setAdminEmail] = React.useState("")
  const [domain, setDomain] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [scimResult, setScimResult] = React.useState<CreatedScim | null>(null)
  const [googleResult, setGoogleResult] = React.useState<SsoDirectory | null>(null)

  const isGoogle = selected === "google"

  function handleSelect(id: string) {
    setSelected(id)
    setName(PROVIDER_LABEL[id] ?? "Directory")
    setError(null)
  }

  async function handleCreate() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const made = await call(
        () =>
          createDirectory({
            name: name.trim(),
            provider: selected,
            ...(isGoogle
              ? { adminEmail: adminEmail.trim(), domain: domain.trim() }
              : {}),
          }),
        { title: "Could not add directory" },
      )
      if (!made) {
        setError("Could not create directory.")
        return
      }

      if (isGoogle) {
        setGoogleResult(made)
        toastDone("Google Workspace connected")
      } else {
        const tokenRes = await call(() => issueDirectoryToken(made.id, 0), {
          title: "Could not issue directory token",
        })
        if (tokenRes) {
          setScimResult({
            directory: made,
            baseUrl: tokenRes.baseUrl,
            token: tokenRes.token,
          })
          toastDone("Directory added", "Copy your credentials to your provider.")
        } else {
          setScimResult({
            directory: made,
            baseUrl: made.baseUrl ?? "",
            token: "",
          })
        }
      }
    } finally {
      setBusy(false)
    }
  }

  async function finish() {
    await onDone()
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Add a directory</p>
          <p className="text-xs text-muted-foreground">
            {scimResult || googleResult
              ? "Copy these values to your provider."
              : "Choose your company's directory provider to start."}
          </p>
        </div>
        {!scimResult && !googleResult && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>

      {!scimResult && !googleResult && (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PROVIDERS.map((p) => {
              const disabled = p.id === "google" && !data.google.available
              const isSelected = selected === p.id
              return (
                <motion.button
                  key={p.id}
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => handleSelect(p.id)}
                  whileTap={disabled ? undefined : { scale: 0.98 }}
                  transition={motionTokens.spring.snappy}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left text-sm font-medium transition-colors ${
                    isSelected
                      ? "border-foreground bg-muted"
                      : "border-border hover:border-foreground/30 hover:bg-muted/50"
                  } disabled:opacity-50`}
                >
                  <IdpMark idp={p.id} />
                  <span className="min-w-0 leading-snug">{p.label}</span>
                </motion.button>
              )
            })}
          </div>

          <Reveal show={selected !== null} spacing="pt-3">
            <div className="space-y-3">
              <FloatingInput
                label="Directory name"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />

              {isGoogle && (
                <>
                  <FloatingInput
                    label="Google admin to act as"
                    hint="An admin address on a verified domain of this workspace."
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                  />
                  <FloatingInput
                    label="Google domain"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                </>
              )}

              <InlineError message={error} />

              <div className="flex items-center gap-2 pt-1">
                <Button
                  loading={busy}
                  disabled={
                    !name.trim() ||
                    (isGoogle && (!adminEmail.trim() || !domain.trim()))
                  }
                  onClick={() => void handleCreate()}
                >
                  {isGoogle ? "Connect Google Workspace" : "Create directory"}
                </Button>
                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          </Reveal>
        </>
      )}

      {scimResult && (
        <div className="space-y-3 pt-2">
          {selected === "okta" && (
            <p className="text-sm text-muted-foreground">
              In Okta Admin Console, open Applications &gt; your app &gt; Provisioning &gt; Integration:
            </p>
          )}
          {selected === "entra" && (
            <p className="text-sm text-muted-foreground">
              In Microsoft Entra admin center, open Enterprise Applications &gt; your app &gt; Provisioning &gt; Admin Credentials:
            </p>
          )}
          {selected === "generic" && (
            <p className="text-sm text-muted-foreground">
              In your SCIM client, enter these integration credentials:
            </p>
          )}

          <div className="space-y-2">
            <div>
              <span className="text-xs font-medium text-muted-foreground">
                {selected === "entra" ? "Tenant URL" : "SCIM base URL"}
              </span>
              <CopyField value={scimResult.baseUrl} />
            </div>

            {selected === "okta" && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">
                  Unique identifier field for users
                </span>
                <CopyField value="userName" />
              </div>
            )}

            {scimResult.token && (
              <div>
                <span className="text-xs font-medium text-muted-foreground">
                  {selected === "okta"
                    ? "API token (shown once)"
                    : selected === "entra"
                      ? "Secret token (shown once)"
                      : "Bearer token (shown once)"}
                </span>
                <CopyField value={scimResult.token} />
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            The token is shown once and cannot be viewed again. Store it securely.
          </p>

          <Button size="sm" onClick={() => void finish()}>
            Done
          </Button>
        </div>
      )}

      {googleResult && (
        <div className="space-y-3 pt-2">
          <p className="text-sm text-muted-foreground">
            In Google Admin console under Security &gt; Access and data control &gt; API controls &gt; Manage Domain Wide Delegation:
          </p>

          <div className="space-y-2">
            <div>
              <span className="text-xs font-medium text-muted-foreground">Client ID</span>
              <CopyField value={googleResult.google?.clientId ?? ""} />
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground">OAuth scopes</span>
              <CopyField value={(googleResult.google?.scopes ?? []).join(",")} />
            </div>
          </div>

          <Button size="sm" onClick={() => void finish()}>
            Done
          </Button>
        </div>
      )}
    </div>
  )
}
