"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import { useResetOnOpen } from "@/lib/react"
import {
  changeDirectory,
  checkDirectory,
  createDirectory,
  directoryConflicts,
  issueDirectoryToken,
  retryDirectoryUser,
  revokeDirectoryToken,
  ssoDirectories,
} from "@/lib/sso-actions"
import { toastDone, toastError } from "@/lib/toast"
import type {
  DirectoryConflict,
  SsoAbilities,
  SsoDirectories,
  SsoDirectory,
} from "@/lib/sso-types"
import { Loading, ShownOnce, ToggleRow, Value, useRemote, useSsoCall } from "./shared"

/**
 * Directories (sso.md 2.7 and 2.9): SCIM from Okta, Entra or any provider, and
 * Google Workspace through domain-wide delegation. A directory creates and
 * removes accounts, so making one, issuing its token and enabling it are an
 * owner's; an admin can read, rename, disable and revoke.
 *
 * ⚠ A SCIM TOKEN IS SHOWN ONCE, when it is made. Only its hash is kept; to
 * "rotate", issue a new one - the old ones keep working for the overlap you
 * choose, so the provider can be updated without a gap - then revoke them.
 */

const PROVIDER_LABEL: Record<string, string> = {
  okta: "Okta (SCIM)",
  entra: "Microsoft Entra ID (SCIM)",
  google: "Google Workspace",
  generic: "Other SCIM provider",
}

const OVERLAP = [
  { value: "0", label: "End the old tokens now" },
  { value: String(3600), label: "Keep them for 1 hour" },
  { value: String(24 * 3600), label: "Keep them for 1 day" },
  { value: String(7 * 24 * 3600), label: "Keep them for 7 days" },
]

const GOOGLE_CHECK: Record<string, string> = {
  not_configured: "Set the admin address and domain first.",
  domain_not_verified:
    "The domain or the admin's address is not one of this workspace's verified domains.",
}

export function DirectoriesPanel({ abilities }: { abilities: SsoAbilities }) {
  const call = useSsoCall()
  const { data, setData, failed, reload } = useRemote(ssoDirectories)
  const [making, setMaking] = React.useState(false)
  const [issued, setIssued] = React.useState<{ token: string; baseUrl: string } | null>(
    null,
  )

  if (!data) return <Loading failed={failed} />

  return (
    <div className="space-y-3">
      {data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No directory yet. A directory keeps this workspace&rsquo;s members in step
          with your company&rsquo;s: people are added, changed and removed there.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.data.map((d) => (
            <Directory
              key={d.id}
              directory={d}
              abilities={abilities}
              onChange={(next) =>
                setData({
                  ...data,
                  data: data.data.map((x) => (x.id === next.id ? next : x)),
                })
              }
              onIssued={setIssued}
              reload={reload}
              call={call}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!abilities.owner || data.data.length >= data.max}
          onClick={() => setMaking(true)}
        >
          New directory
        </Button>
        {!abilities.owner && (
          <p className="text-xs text-muted-foreground">
            Only an owner can make a directory: it creates and removes accounts.
          </p>
        )}
      </div>
      <NewDirectory
        open={making}
        onOpenChange={setMaking}
        data={data}
        onMake={async (input) => {
          const made = await call(() => createDirectory(input), {
            title: "Could not make the directory",
          })
          if (!made) return false
          await reload()
          toastDone(
            "Directory made",
            made.provider === "google" ? undefined : "Issue its token next.",
          )
          return true
        }}
      />
      <ShownOnce
        open={issued !== null}
        title="Your directory token"
        description="Paste it into your provider as the SCIM bearer token. It is shown once and cannot be found again."
        fields={
          issued
            ? [
                { label: "Base URL", value: issued.baseUrl },
                { label: "Token", value: issued.token },
              ]
            : []
        }
        onClose={() => setIssued(null)}
      />
    </div>
  )
}

function Directory({
  directory,
  abilities,
  onChange,
  onIssued,
  reload,
  call,
}: {
  directory: SsoDirectory
  abilities: SsoAbilities
  onChange: (directory: SsoDirectory) => void
  onIssued: (value: { token: string; baseUrl: string }) => void
  reload: () => Promise<void>
  call: ReturnType<typeof useSsoCall>
}) {
  const [overlap, setOverlap] = React.useState(String(24 * 3600))
  const [checking, setChecking] = React.useState(false)
  const [conflicts, setConflicts] = React.useState(false)
  const google = directory.provider === "google"
  const liveTokens = directory.tokens.filter((t) => !t.revokedAt)

  return (
    <li className="rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{directory.name}</p>
          <p className="text-xs text-muted-foreground">
            {PROVIDER_LABEL[directory.provider] ?? directory.provider} &middot;{" "}
            {directory.users} {directory.users === 1 ? "person" : "people"}
            {directory.pending > 0 ? ` - ${directory.pending} waiting` : ""}
          </p>
        </div>
        {directory.conflicts > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setConflicts(true)}>
            {directory.conflicts} {directory.conflicts === 1 ? "conflict" : "conflicts"}
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <ToggleRow
          label="Enabled"
          description={
            directory.enabled
              ? "Changes from your provider are applied."
              : abilities.owner
                ? "Changes are ignored. Enabling it starts applying them."
                : "Only an owner can enable a directory."
          }
          checked={directory.enabled}
          disabled={!directory.enabled && !abilities.owner}
          onChange={async (enabled) => {
            const after = await call(() => changeDirectory(directory.id, { enabled }), {
              title: enabled ? "Could not enable it" : "Could not disable it",
            })
            if (after) {
              onChange({ ...directory, ...after, tokens: directory.tokens })
              toastDone(enabled ? "Directory enabled" : "Directory disabled")
            }
          }}
        />

        {google ? (
          <>
            {directory.google && !directory.google.available && (
              <p className="text-sm text-muted-foreground">
                {directory.google.unavailableReason}
              </p>
            )}
            {directory.google?.available && directory.google.clientId && (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                <p className="text-xs font-medium">
                  In your Google Admin console, authorise this client for domain-wide
                  delegation with the scopes below.
                </p>
                <Value label="Client ID" value={directory.google.clientId} />
                <Value label="Scopes" value={directory.google.scopes.join(",")} />
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Acting as {directory.adminEmail ?? "-"} for {directory.domain ?? "-"}.{" "}
              {directory.lastSyncAt ? (
                <>
                  Last pull <Time iso={directory.lastSyncAt} />
                  {directory.lastSyncStatus ? `: ${directory.lastSyncStatus}` : ""}
                  {directory.lastSyncError ? ` (${directory.lastSyncError})` : ""}.
                </>
              ) : (
                "Not pulled yet."
              )}
            </p>
            <Button
              variant="secondary"
              size="sm"
              loading={checking}
              onClick={async () => {
                setChecking(true)
                try {
                  const result = await call(() => checkDirectory(directory.id), {
                    stepUp: false,
                    title: "Could not check access",
                  })
                  if (!result) return
                  if (result.ok) toastDone("Google access works")
                  else
                    toastError(
                      "Google refused",
                      GOOGLE_CHECK[result.error ?? ""] ??
                        "Check the delegation in your Google Admin console, then try again.",
                    )
                } finally {
                  setChecking(false)
                }
              }}
            >
              Check access
            </Button>
          </>
        ) : (
          <>
            {directory.baseUrl && (
              <Value label="SCIM base URL" value={directory.baseUrl} />
            )}
            {liveTokens.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {liveTokens.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block font-mono text-xs">{t.hint}…</span>
                      <span className="block text-xs text-muted-foreground">
                        Made <Time iso={t.createdAt} />
                        {t.lastUsedAt ? (
                          <>
                            {" "}
                            - used <Time iso={t.lastUsedAt} />
                          </>
                        ) : (
                          " - never used"
                        )}
                        {t.expiresAt ? (
                          <>
                            {" "}
                            - ends <Time iso={t.expiresAt} mode="exact" />
                          </>
                        ) : (
                          ""
                        )}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const ok = await call(
                          () => revokeDirectoryToken(directory.id, t.id),
                          {
                            title: "Could not revoke the token",
                          },
                        )
                        if (ok) {
                          toastDone("Token revoked")
                          await reload()
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              {liveTokens.length > 0 && (
                <div className="w-56">
                  <MorphSelect
                    label="When rotating"
                    value={overlap}
                    onValueChange={setOverlap}
                    items={OVERLAP}
                  />
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={!abilities.owner}
                onClick={async () => {
                  const made = await call(
                    () => issueDirectoryToken(directory.id, Number(overlap)),
                    { title: "Could not issue a token" },
                  )
                  if (made) {
                    onIssued({ token: made.token, baseUrl: made.baseUrl })
                    await reload()
                  }
                }}
              >
                {liveTokens.length > 0 ? "Rotate token" : "Issue token"}
              </Button>
            </div>
            {!abilities.owner && (
              <p className="text-xs text-muted-foreground">
                Only an owner can issue a token: it is the credential itself.
              </p>
            )}
          </>
        )}
      </div>
      <Conflicts
        directory={directory}
        open={conflicts}
        onOpenChange={setConflicts}
        call={call}
        reload={reload}
      />
    </li>
  )
}

function NewDirectory({
  open,
  onOpenChange,
  data,
  onMake,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  data: SsoDirectories
  onMake: (input: {
    name: string
    provider: string
    adminEmail?: string
    domain?: string
  }) => Promise<boolean>
}) {
  const [name, setName] = React.useState("")
  const [provider, setProvider] = React.useState("generic")
  const [adminEmail, setAdminEmail] = React.useState("")
  const [domain, setDomain] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  useResetOnOpen(open, () => {
    setName("")
    setProvider("generic")
    setAdminEmail("")
    setDomain("")
    setBusy(false)
  })
  const google = provider === "google"
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        title="New directory"
        description="Keeps this workspace's members in step with your company's directory."
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <div className="space-y-4 py-4">
          <MorphSelect
            label="Directory"
            value={provider}
            onValueChange={setProvider}
            items={data.providers.map((p) => ({
              value: p,
              label: PROVIDER_LABEL[p] ?? p,
              disabled: p === "google" && !data.google.available,
            }))}
          />
          {google && !data.google.available && (
            <p className="text-sm text-muted-foreground">
              {data.google.unavailableReason}
            </p>
          )}
          <FloatingInput
            label="Name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          {google && (
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
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={
              !name.trim() || (google && (!adminEmail.trim() || !domain.trim()))
            }
            onClick={async () => {
              setBusy(true)
              try {
                const ok = await onMake({
                  name: name.trim(),
                  provider,
                  ...(google
                    ? { adminEmail: adminEmail.trim(), domain: domain.trim() }
                    : {}),
                })
                if (ok) onOpenChange(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            Make directory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Conflicts({
  directory,
  open,
  onOpenChange,
  call,
  reload,
}: {
  directory: SsoDirectory
  open: boolean
  onOpenChange: (open: boolean) => void
  call: ReturnType<typeof useSsoCall>
  reload: () => Promise<void>
}) {
  const [rows, setRows] = React.useState<DirectoryConflict[] | null>(null)
  useResetOnOpen(open, () => setRows(null))
  // An effect, not the reset: `useResetOnOpen` runs during render.
  React.useEffect(() => {
    if (!open) return
    let live = true
    void directoryConflicts(directory.id).then((r) => {
      if (live) setRows(r.ok ? r.data.data : [])
    })
    return () => {
      live = false
    }
  }, [open, directory.id])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Conflicts"
        description="People your directory sends that could not be fully applied, and why. Fix the cause, then retry."
        style={{ width: "min(calc(100vw - 2rem), 560px)" }}
      >
        <div className="max-h-96 overflow-auto py-4">
          {rows === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conflicts.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {row.displayName ?? row.userName}
                      {row.email ? ` (${row.email})` : ""}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.conflict ?? "Waiting to be applied"}
                      {row.deleted ? " - removed in the directory" : ""}
                    </span>
                  </span>
                  {!row.active && <Badge size="sm">Inactive</Badge>}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      const ok = await call(
                        () => retryDirectoryUser(directory.id, row.id),
                        {
                          stepUp: false,
                          title: "Could not retry",
                        },
                      )
                      if (ok) {
                        toastDone("Retrying")
                        await reload()
                      }
                    }}
                  >
                    Retry
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
