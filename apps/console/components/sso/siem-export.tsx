"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import {
  draftOfSiem,
  siemBody,
  siemChanged,
  siemMissing,
  type SiemDraft,
} from "@/lib/siem"
import { removeSiem, saveSiem, siemSettings, testSiem } from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type { SiemSettingsAnswer, SiemTestResult, SsoAbilities } from "@/lib/sso-types"
import { SettingsRow } from "./settings-card"
import { Loading, ToggleRow, useRemote, useSsoCall } from "./shared"

export function SiemExportPanel({
  abilities,
  initial,
}: {
  abilities: SsoAbilities
  initial?: SiemSettingsAnswer | null
}) {
  const { data, setData, failed } = useRemote(siemSettings, initial)
  if (!data) return <Loading failed={failed} />
  return (
    <Form
      key={JSON.stringify(data.settings)}
      answer={data}
      abilities={abilities}
      onChanged={setData}
    />
  )
}

function Form({
  answer,
  abilities,
  onChanged,
}: {
  answer: SiemSettingsAnswer
  abilities: SsoAbilities
  onChanged: (next: SiemSettingsAnswer) => void
}) {
  const call = useSsoCall()
  const view = answer.settings
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<SiemDraft>(() => draftOfSiem(view))
  const [busy, setBusy] = React.useState<"save" | "test" | null>(null)
  const [removing, setRemoving] = React.useState(false)
  const [result, setResult] = React.useState<SiemTestResult | null>(null)

  const set = <K extends keyof SiemDraft>(key: K, value: SiemDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const missing = siemMissing(draft, answer.configured)
  const changed = siemChanged(draft, view)
  const locked = !abilities.owner

  async function save() {
    setBusy("save")
    try {
      const saved = await call(() => saveSiem(siemBody(draft)), {
        title: "Could not save the SIEM export",
      })
      if (!saved) return
      toastDone("SIEM export saved")
      setResult(null)
      onChanged(saved)
      setOpen(false)
    } finally {
      setBusy(null)
    }
  }

  async function test() {
    setBusy("test")
    try {
      const outcome = await call(() => testSiem(), {
        title: "Could not run the test",
      })
      if (outcome) setResult(outcome)
    } finally {
      setBusy(null)
    }
  }

  async function remove(): Promise<boolean> {
    const done = await call(() => removeSiem(), {
      title: "Could not remove the SIEM export",
    })
    if (!done) return false
    toastDone("SIEM export removed")
    onChanged({ configured: false, settings: null })
    setOpen(false)
    return true
  }

  return (
    <SettingsRow
      title="SIEM export"
      description="Send the identity audit log to a bucket of your own so your security tools can read it."
      action={
        <div className="flex items-center gap-3">
          {answer.configured ? (
            <>
              <Badge tone={view?.enabled ? "success" : "neutral"} size="sm">
                {view?.enabled ? "On" : "Off"}
              </Badge>
              <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
                {open ? "Close" : "Edit"}
              </Button>
            </>
          ) : (
            <>
              <span className="text-sm text-muted-foreground">Off</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={locked}
                onClick={() => setOpen(!open)}
              >
                {open ? "Cancel" : "Set up"}
              </Button>
            </>
          )}
        </div>
      }
    >
      <Reveal show={open} spacing="pt-3">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FloatingInput
              label="Endpoint"
              value={draft.endpoint}
              disabled={locked}
              hint="An https address, for example https://s3.eu-west-1.amazonaws.com"
              onChange={(e) => set("endpoint", e.target.value)}
            />
            <FloatingInput
              label="Bucket"
              value={draft.bucket}
              disabled={locked}
              onChange={(e) => set("bucket", e.target.value)}
            />
            <FloatingInput
              label="Region"
              value={draft.region}
              disabled={locked}
              onChange={(e) => set("region", e.target.value)}
            />
            <FloatingInput
              label="Folder prefix (optional)"
              value={draft.prefix}
              disabled={locked}
              onChange={(e) => set("prefix", e.target.value)}
            />
            <FloatingInput
              label="Access key id"
              value={draft.accessKeyId}
              disabled={locked}
              autoComplete="off"
              onChange={(e) => set("accessKeyId", e.target.value)}
            />
            <FloatingInput
              label="Secret access key"
              type="password"
              value={draft.secretAccessKey}
              disabled={locked}
              autoComplete="off"
              hint={
                view
                  ? `Stored as ${view.secretAccessKey}. Leave empty to keep it.`
                  : "Shown nowhere after you save it."
              }
              onChange={(e) => set("secretAccessKey", e.target.value)}
            />
          </div>
          <ToggleRow
            label="Export on"
            description="Write new audit events to the bucket as they happen."
            checked={draft.enabled}
            disabled={locked}
            onChange={(next) => set("enabled", next)}
          />
          {view && (
            <p className="text-sm text-muted-foreground">
              {view.lastExportAt ? (
                <>
                  Last exported <Time iso={view.lastExportAt} />.
                </>
              ) : (
                "Nothing exported yet."
              )}
              {view.lastError && (
                <span className="block text-destructive">
                  Last error
                  {view.lastErrorAt && (
                    <>
                      {" "}
                      (<Time iso={view.lastErrorAt} />)
                    </>
                  )}
                  : {view.lastError}
                </span>
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "save"}
              disabled={locked || busy !== null || !changed || missing !== null}
              onClick={save}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === "test"}
              disabled={locked || busy !== null || !answer.configured || changed}
              onClick={test}
            >
              Send test
            </Button>
            {answer.configured && (
              <Button
                variant="ghost"
                size="sm"
                disabled={locked || busy !== null}
                onClick={() => setRemoving(true)}
              >
                Remove
              </Button>
            )}
            {locked ? (
              <p className="text-xs text-muted-foreground">
                Only an owner can change this. Ask an owner.
              </p>
            ) : (
              changed &&
              missing && <p className="text-xs text-muted-foreground">{missing}</p>
            )}
          </div>
          {answer.configured && !locked && changed && (
            <p className="text-xs text-muted-foreground">
              Save your changes to send a test.
            </p>
          )}
          {result && (
            <p
              role="status"
              className={
                result.ok ? "text-sm text-success" : "text-sm text-destructive"
              }
            >
              {result.ok
                ? `The test file was written to the bucket as ${result.key}.`
                : `The test failed: ${result.error}`}
            </p>
          )}
          <ConfirmDialog
            open={removing}
            onOpenChange={setRemoving}
            title="Remove the SIEM export?"
            description="Exporting stops and the stored key is forgotten. Files already in your bucket stay there."
            confirmLabel="Remove"
            doneLabel="Removed"
            onConfirm={remove}
          />
        </div>
      </Reveal>
    </SettingsRow>
  )
}
