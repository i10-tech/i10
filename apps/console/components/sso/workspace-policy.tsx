"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
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
import { Loading, ToggleRow, useRemote, useSsoCall } from "./shared"

/**
 * The workspace's session policy and second-factor rule (#345). Anyone with
 * `sso:manage` reads them; changing either is an owner's, with step-up.
 *
 * ⚠ THE SCREEN SHOWS HUMAN UNITS AND SENDS SECONDS. The bounds come from the
 * GET, never from this file, so the page and the API cannot disagree about
 * them; the API still refuses a value outside them.
 */

const OWNER_ONLY = "Only an owner can change this. Ask an owner."

export function SessionPolicyPanel({ abilities }: { abilities: SsoAbilities }) {
  const { data, setData, failed } = useRemote(sessionPolicy)
  if (!data) return <Loading failed={failed} />
  return (
    <SessionForm
      // Remount on a saved change so the fields start from what the API holds.
      key={`${data.maxSessionSeconds}:${data.idleTimeoutSeconds}`}
      policy={data}
      abilities={abilities}
      onSaved={(saved) => setData({ ...data, ...saved })}
    />
  )
}

function SessionForm({
  policy,
  abilities,
  onSaved,
}: {
  policy: SessionPolicy
  abilities: SsoAbilities
  onSaved: (saved: {
    maxSessionSeconds: number | null
    idleTimeoutSeconds: number | null
  }) => void
}) {
  const call = useSsoCall()
  const [longest, setLongest] = React.useState(() =>
    draftOf(policy.maxSessionSeconds, { value: 7, unit: "days" }),
  )
  const [idle, setIdle] = React.useState(() =>
    draftOf(policy.idleTimeoutSeconds, { value: 1, unit: "hours" }),
  )
  const [busy, setBusy] = React.useState(false)
  const maxResult = draftSeconds(longest, policy.bounds.maxSessionSeconds)
  const idleResult = draftSeconds(idle, policy.bounds.idleTimeoutSeconds)
  const changed =
    maxResult.ok &&
    idleResult.ok &&
    (maxResult.seconds !== policy.maxSessionSeconds ||
      idleResult.seconds !== policy.idleTimeoutSeconds)

  async function save() {
    if (!maxResult.ok || !idleResult.ok) return
    setBusy(true)
    try {
      const saved = await call(
        () =>
          saveSessionPolicy({
            maxSessionSeconds: maxResult.seconds,
            idleTimeoutSeconds: idleResult.seconds,
          }),
        { title: "Could not save the session policy" },
      )
      if (saved) {
        onSaved(saved)
        toastDone("Session policy saved")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <LimitField
        label="Longest session"
        description="Everyone is signed out this long after they signed in, however active they are."
        draft={longest}
        bounds={policy.bounds.maxSessionSeconds}
        problem={maxResult.ok ? null : maxResult.reason}
        disabled={!abilities.owner}
        onChange={setLongest}
      />
      <LimitField
        label="Sign out when idle"
        description="Everyone is signed out after this long without using the console."
        draft={idle}
        bounds={policy.bounds.idleTimeoutSeconds}
        problem={idleResult.ok ? null : idleResult.reason}
        disabled={!abilities.owner}
        onChange={setIdle}
      />
      <p className="max-w-prose text-sm text-muted-foreground">
        An SSO connection can set shorter limits of its own for the people who sign in
        through it. The shorter one applies.
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={!abilities.owner || !changed}
          onClick={() => void save()}
        >
          Save session policy
        </Button>
        {!abilities.owner && (
          <p className="text-xs text-muted-foreground">{OWNER_ONLY}</p>
        )}
      </div>
    </div>
  )
}

function LimitField({
  label,
  description,
  draft,
  bounds,
  problem,
  disabled,
  onChange,
}: {
  label: string
  description: string
  draft: LimitDraft
  bounds: Bounds
  problem: "empty" | "below" | "above" | null
  disabled: boolean
  onChange: (draft: LimitDraft) => void
}) {
  const id = React.useId()
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={id} className="min-w-0">
          <span className="block text-sm font-medium">{label}</span>
          <span className="block max-w-prose text-sm text-muted-foreground">
            {description}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden>{draft.on ? "Limited" : "No limit"}</span>
          <Switch
            id={id}
            checked={draft.on}
            disabled={disabled}
            onCheckedChange={(on) => onChange({ ...draft, on })}
          />
        </div>
      </div>
      {draft.on && (
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
      )}
    </div>
  )
}

// ── Second factor ───────────────────────────────────────────────────────────

export function SecondFactorPanel({ abilities }: { abilities: SsoAbilities }) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(secondFactorPolicy)
  if (!data) return <Loading failed={failed} />
  return (
    <div className="space-y-3">
      <ToggleRow
        label="Require a second factor"
        description="Members who sign in with a password or an email code must have a second step on their account, such as an authenticator app. Until they add one, the console asks them to."
        checked={data.required}
        disabled={!abilities.owner}
        onChange={async (required) => {
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
      <p className="max-w-prose text-sm text-muted-foreground">
        Members who sign in through SSO are exempt: their identity provider is the
        second step. Passkeys alone do not count, so a member who only has a passkey is
        still asked to add one.
      </p>
      {!abilities.owner && (
        <p className="text-xs text-muted-foreground">{OWNER_ONLY}</p>
      )}
    </div>
  )
}
