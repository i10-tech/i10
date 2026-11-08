"use client"

import * as React from "react"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { changeSsoConnection, ssoTestRuns } from "@/lib/sso-actions"
import { latestPass } from "@/lib/sso-runs"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection, SsoEnforcement } from "@/lib/sso-types"
import { SettingsRow } from "../settings-card"
import { InlineError } from "../setup/inline-error"
import {
  connectionWriteNeedsStepUp,
  ENFORCEMENT_HELP,
  ENFORCEMENT_LABEL,
  useSsoCall,
} from "../shared"

export function Enforcement({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const [pending, setPending] = React.useState<SsoEnforcement | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const [passedAt, setPassedAt] = React.useState<string | null | undefined>(undefined)
  const live = connection.status === "active" || connection.status === "disabled"
  // Setting a required mode, or loosening a live connection, is an owner's move.
  const ownerOnly = live && !abilities.owner
  const required =
    connection.enforcement === "required_domain" ||
    connection.enforcement === "required_all"

  async function apply(mode: SsoEnforcement): Promise<boolean> {
    setRefusal(null)
    const result = await call(
      () => changeSsoConnection(connection.id, { enforcement: mode }),
      {
        stepUp: connectionWriteNeedsStepUp(connection, { enforcement: mode }),
        title: "Could not change enforcement",
      },
    )
    if (result) {
      onChange({ ...connection, ...result, domains: connection.domains })
      toastDone(`Enforcement: ${ENFORCEMENT_LABEL[mode]}`)
      return true
    }
    return false
  }

  async function choose(mode: SsoEnforcement) {
    if (mode === connection.enforcement) return
    if (mode === "required_domain" || mode === "required_all") {
      setPassedAt(undefined)
      setRefusal(null)
      setPending(mode)
      const runs = await ssoTestRuns(connection.id)
      const pass = runs.ok ? latestPass(runs.data.data, Date.now()) : null
      setPassedAt(pass ? pass.createdAt : null)
      return
    }
    await apply(mode)
  }

  return (
    <>
      <SettingsRow
        title="How people sign in"
        description={
          <>
            {ENFORCEMENT_HELP[connection.enforcement]}
            <Reveal show={required} spacing="pt-2">
              <span className="block text-xs">
                Owners and admins SSO does not manage keep their passkey, so nobody gets
                locked out.
              </span>
            </Reveal>
            <Reveal show={ownerOnly} spacing="pt-2">
              <span className="block text-xs">
                Only an owner can make a live connection required, or loosen it.
              </span>
            </Reveal>
          </>
        }
        action={
          <MorphSelect
            label="How people sign in"
            value={connection.enforcement}
            disabled={ownerOnly && connection.enforcement !== "off"}
            onValueChange={(v) => void choose(v as SsoEnforcement)}
            items={(Object.keys(ENFORCEMENT_LABEL) as SsoEnforcement[]).map((m) => ({
              value: m,
              label: ENFORCEMENT_LABEL[m],
              disabled: ownerOnly && (m === "required_domain" || m === "required_all"),
            }))}
            panelWidth={320}
          />
        }
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending === "required_all"
            ? "Require SSO for everyone?"
            : "Require SSO for the domain?"
        }
        description="Requiring SSO locks every covered member out of every other way into this workspace. Make sure the test below passed first."
        confirmLabel="Require SSO"
        doneLabel="Required"
        destructive={false}
        ready={passedAt !== undefined}
        onConfirm={async () => {
          if (!pending) return false
          const result = await call(
            () => changeSsoConnection(connection.id, { enforcement: pending }),
            {
              stepUp: connectionWriteNeedsStepUp(connection, { enforcement: pending }),
              title: "Could not require SSO",
            },
          )
          if (!result) {
            setRefusal(
              passedAt === null
                ? "Run a test sign-in that passes first. Requiring SSO needs a passed test run in the last 24 hours."
                : "The change was refused. See the message that just appeared.",
            )
            return false
          }
          onChange({ ...connection, ...result, domains: connection.domains })
          return true
        }}
      >
        <div className="space-y-2 text-sm">
          <p className={passedAt ? "text-foreground" : "text-muted-foreground"}>
            {passedAt === undefined
              ? "Checking your test runs..."
              : passedAt
                ? "A test passed in the last 24 hours."
                : "No test has passed in the last 24 hours. The API will refuse until one does."}
          </p>
          <InlineError message={refusal} />
        </div>
      </ConfirmDialog>
    </>
  )
}
