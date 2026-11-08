"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { Switch } from "@repo/ui/components/i10/switch"
import {
  DURATION_UNITS,
  draftOf,
  draftSeconds,
  formatBounds,
  type DurationUnit,
  type LimitDraft,
} from "@/lib/duration"
import {
  saveSecondFactorPolicy,
  saveSessionPolicy,
  secondFactorPolicy,
  sessionPolicy,
} from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type { Bounds, SessionPolicy, SsoAbilities } from "@/lib/sso-types"
import { InlineError } from "./setup/inline-error"
import { SettingsRow } from "./settings-card"
import { Loading, useRemote, useSsoCall } from "./shared"

const OWNER_ONLY = "Only an owner can change this. Ask an owner."

function formatDuration(
  seconds: number | null,
  fallback: { value: number; unit: DurationUnit },
): string {
  if (seconds === null) return "No limit"
  const draft = draftOf(seconds, fallback)
  const unit = Number(draft.value) === 1 ? draft.unit.replace(/s$/, "") : draft.unit
  return `${draft.value} ${unit}`
}

export function SessionPolicyPanel({
  abilities,
  initial,
}: {
  abilities: SsoAbilities
  initial?: SessionPolicy | null
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(sessionPolicy, initial)
  if (!data) return <Loading failed={failed} />

  const update = (patch: Partial<SessionPolicy>) => {
    setData({ ...data, ...patch })
    toastDone("Session policy saved")
  }

  return (
    <>
      <SessionLimitRow
        key={`max:${data.maxSessionSeconds}`}
        title="Longest session"
        description="Everyone is signed out this long after they signed in, however active they are."
        currentSeconds={data.maxSessionSeconds}
        bounds={data.bounds.maxSessionSeconds}
        fallback={{ value: 7, unit: "days" }}
        saveLabel="Save longest session"
        abilities={abilities}
        onSave={async (seconds) => {
          const saved = await call(
            () =>
              saveSessionPolicy({
                maxSessionSeconds: seconds,
                idleTimeoutSeconds: data.idleTimeoutSeconds,
              }),
            { title: "Could not save the session policy" },
          )
          if (saved) {
            update(saved)
            return true
          }
          return false
        }}
      />
      <SessionLimitRow
        key={`idle:${data.idleTimeoutSeconds}`}
        title="Sign out when idle"
        description="Everyone is signed out after this long without using the console."
        currentSeconds={data.idleTimeoutSeconds}
        bounds={data.bounds.idleTimeoutSeconds}
        fallback={{ value: 1, unit: "hours" }}
        note="An SSO connection can set shorter limits of its own for the people who sign in through it. The shorter one applies."
        saveLabel="Save idle timeout"
        abilities={abilities}
        onSave={async (seconds) => {
          const saved = await call(
            () =>
              saveSessionPolicy({
                maxSessionSeconds: data.maxSessionSeconds,
                idleTimeoutSeconds: seconds,
              }),
            { title: "Could not save the idle timeout" },
          )
          if (saved) {
            update(saved)
            return true
          }
          return false
        }}
      />
    </>
  )
}

function SessionLimitRow({
  title,
  description,
  currentSeconds,
  bounds,
  fallback,
  note,
  saveLabel,
  abilities,
  onSave,
}: {
  title: string
  description: string
  currentSeconds: number | null
  bounds: Bounds
  fallback: { value: number; unit: DurationUnit }
  note?: string
  saveLabel: string
  abilities: SsoAbilities
  onSave: (seconds: number | null) => Promise<boolean>
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(() => draftOf(currentSeconds, fallback))
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const result = draftSeconds(draft, bounds)
  const changed = result.ok && result.seconds !== currentSeconds
  const currentText = formatDuration(currentSeconds, fallback)

  async function handleSave() {
    if (!result.ok) return
    setBusy(true)
    setError(null)
    try {
      const ok = await onSave(result.seconds)
      if (ok) setEditing(false)
      else setError("Could not save.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsRow
      title={title}
      description={description}
      action={
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{currentText}</span>
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
        </div>
      }
    >
      <Reveal show={editing} spacing="pt-3">
        <div className="space-y-4">
          <DurationLimitEditor
            draft={draft}
            bounds={bounds}
            problem={result.ok ? null : result.reason}
            disabled={!abilities.owner}
            onChange={setDraft}
          />
          {note && <p className="max-w-prose text-sm text-muted-foreground">{note}</p>}
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={!abilities.owner || !changed || !result.ok}
              onClick={() => void handleSave()}
            >
              {saveLabel}
            </Button>
            {!abilities.owner && (
              <p className="text-xs text-muted-foreground">{OWNER_ONLY}</p>
            )}
          </div>
          <InlineError message={error} />
        </div>
      </Reveal>
    </SettingsRow>
  )
}

function DurationLimitEditor({
  draft,
  bounds,
  problem,
  disabled,
  onChange,
}: {
  draft: LimitDraft
  bounds: Bounds
  problem: "empty" | "below" | "above" | null
  disabled: boolean
  onChange: (draft: LimitDraft) => void
}) {
  const id = React.useId()
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium">
          Limit duration
        </label>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden>{draft.on ? "Limited" : "No limit"}</span>
          <Switch
            id={id}
            checked={draft.on}
            disabled={disabled}
            onCheckedChange={(on) => onChange({ ...draft, on })}
          />
        </div>
      </div>
      <Reveal show={draft.on} spacing="pt-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <FloatingInput
            label="Length"
            type="number"
            inputMode="decimal"
            min={0}
            value={draft.value}
            disabled={disabled}
            state={problem ? "invalid" : "idle"}
            hint={
              problem === "empty"
                ? "Enter a number above zero."
                : `Between ${formatBounds(bounds)}.`
            }
            onChange={(e) => onChange({ ...draft, value: e.target.value })}
          />
          <MorphSelect
            label="Unit"
            value={draft.unit}
            disabled={disabled}
            onValueChange={(unit) => onChange({ ...draft, unit: unit as DurationUnit })}
            items={DURATION_UNITS.map((u) => ({ value: u.unit, label: u.label }))}
          />
        </div>
      </Reveal>
    </div>
  )
}

export function SecondFactorPanel({
  abilities,
  initial,
}: {
  abilities: SsoAbilities
  initial?: { required: boolean } | null
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(secondFactorPolicy, initial)
  const id = React.useId()

  if (!data) return <Loading failed={failed} />

  return (
    <SettingsRow
      title="Second factor"
      description="Require a second step at sign-in from members who do not use SSO."
      action={
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {data.required ? "Required" : "Optional"}
          </span>
          <Switch
            id={id}
            checked={data.required}
            disabled={!abilities.owner}
            onCheckedChange={async (required) => {
              const saved = await call(() => saveSecondFactorPolicy(required), {
                title: "Could not save that",
              })
              if (saved) {
                setData(saved)
                toastDone(
                  saved.required ? "Second factor required" : "Second factor optional",
                )
              }
            }}
          />
        </div>
      }
    >
      <div className="space-y-1">
        <p className="max-w-prose text-sm text-muted-foreground">
          Members who sign in through SSO are exempt: their identity provider is the
          second step. Passkeys alone do not count, so a member who only has a passkey
          is still asked to add one.
        </p>
        {!abilities.owner && (
          <p className="text-xs text-muted-foreground">{OWNER_ONLY}</p>
        )}
      </div>
    </SettingsRow>
  )
}
