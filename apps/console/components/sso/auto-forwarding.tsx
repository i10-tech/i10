"use client"

import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { autoForwarding, saveAutoForwarding } from "@/lib/sso-policy-actions"
import { toastDone } from "@/lib/toast"
import type { AutoForwardingMode, AutoForwardingSettings } from "@/lib/sso-types"
import { SettingsRow } from "./settings-card"
import { Loading, RowBone, useRemote, useSsoCall } from "./shared"

/**
 * Per-workspace automatic forwarding policy (#526). Enforced server-side in
 * Stalwart for every Sieve-generated forward (Outlook rules, JMAP mail rules,
 * hand-written Sieve redirect and notify). Owners and admins can view and
 * change it, behind step-up; switching to `anywhere` requires confirming the
 * risk first.
 */

export const AUTO_FORWARDING_OPTIONS: readonly {
  value: AutoForwardingMode
  label: string
  description: string
}[] = [
  {
    value: "workspace",
    label: "Workspace domains only",
    description: "Forward only to addresses on domains this workspace hosts and owns.",
  },
  {
    value: "workspace_and_members",
    label: "Workspace domains and members",
    description:
      "Also allow forwarding to current workspace members' sign-in addresses.",
  },
  {
    value: "anywhere",
    label: "Anywhere",
    description: "Allow automatic forwarding to any external email address.",
  },
  {
    value: "off",
    label: "Off",
    description: "Block all automatic forwarding rules and Sieve redirects.",
  },
]

const SELECT_ITEMS = AUTO_FORWARDING_OPTIONS.map(({ value, label }) => ({
  value,
  label,
}))

function isMode(value: string): value is AutoForwardingMode {
  return AUTO_FORWARDING_OPTIONS.some((option) => option.value === value)
}

export function AutoForwardingPanel({
  initial,
}: {
  initial?: AutoForwardingSettings | null
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(autoForwarding, initial)
  const [busy, setBusy] = React.useState(false)
  const [confirmAnywhere, setConfirmAnywhere] = React.useState(false)

  if (!data && (failed?.upgrade || failed?.message)) return <Loading failed={failed} />

  const loading = !data
  const mode: AutoForwardingMode = data?.mode ?? "workspace"

  async function apply(next: AutoForwardingMode, confirm?: boolean): Promise<boolean> {
    setBusy(true)
    try {
      const saved = await call(
        () =>
          saveAutoForwarding(
            confirm ? { mode: next, confirm_anywhere: true } : { mode: next },
          ),
        { title: "Could not save automatic forwarding" },
      )
      if (!saved) return false
      setData(saved)
      toastDone("Automatic forwarding updated")
      return true
    } finally {
      setBusy(false)
    }
  }

  function handleChange(next: string) {
    if (!isMode(next) || next === mode || busy) return
    if (next === "anywhere") {
      setConfirmAnywhere(true)
      return
    }
    void apply(next)
  }

  return (
    <>
      <SettingsRow
        title="Allowed destinations"
        description="Applies to Outlook rules, JMAP mail rules, and Sieve redirects on every mailbox."
        action={
          <RowBone id="auto-forwarding" loading={loading} width={250} height={36}>
            <MorphSelect
              label="Automatic forwarding"
              hideLabel
              align="end"
              triggerWidth="widest"
              panelWidth={280}
              disabled={loading || busy}
              value={mode}
              onValueChange={handleChange}
              items={SELECT_ITEMS}
            />
          </RowBone>
        }
      >
        <dl className="space-y-1.5 text-xs text-muted-foreground">
          {AUTO_FORWARDING_OPTIONS.map((option) => (
            <div key={option.value} className="flex flex-wrap gap-x-1.5">
              <dt className="font-medium text-foreground">{option.label}:</dt>
              <dd>{option.description}</dd>
            </div>
          ))}
        </dl>

        {/* ⚠ SKIPPED BY test/skeleton-parity: shown only when the saved mode is `anywhere`. */}
        <div className="contents" data-skeleton="skip">
          {!loading && mode === "anywhere" && (
            <div
              role="status"
              className="mt-3 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-foreground"
            >
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <p>
                Automatic forwarding to external addresses is allowed. If a mailbox
                password is compromised, an attacker can add a rule to copy incoming
                mail outside your workspace.
              </p>
            </div>
          )}
        </div>
      </SettingsRow>

      <ConfirmDialog
        open={confirmAnywhere}
        onOpenChange={setConfirmAnywhere}
        title="Allow automatic forwarding anywhere?"
        description="Mail rules and Sieve scripts will be able to forward incoming mail to any email address outside your workspace."
        confirmLabel="Allow anywhere"
        doneLabel="Allowed"
        destructive
        onConfirm={() => apply("anywhere", true)}
      >
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p>
            If a member&apos;s account is compromised, an attacker can create a rule to
            forward their incoming mail to an external inbox. Keep this restricted
            unless your team needs unrestricted external forwarding.
          </p>
        </div>
      </ConfirmDialog>
    </>
  )
}
