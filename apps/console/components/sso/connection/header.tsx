"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { type BadgeTone } from "@repo/ui/components/badge/badge"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { healthLabel, type HealthState } from "@/lib/connection-health"
import { useMounted } from "@/lib/react"
import { changeSsoConnection } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { IdpMark } from "../idp-mark"
import { StatusLine } from "../settings-card"
import { useSsoCall } from "../shared"
import { HeaderMenu, type Move } from "./header-menu"

const HEALTH_TONE: Record<HealthState, BadgeTone> = {
  healthy: "success",
  degraded: "warning",
  failing: "danger",
}

function providerDisplay(provider: string): string {
  switch (provider) {
    case "okta":
      return "Okta"
    case "entra":
      return "Microsoft Entra"
    case "google":
      return "Google Workspace"
    default:
      return "your provider"
  }
}

export function Header({
  connection,
  abilities,
  authOrigin,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  authOrigin: string | null
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const mounted = useMounted()
  const [editingName, setEditingName] = React.useState(false)
  const [nameDraft, setNameDraft] = React.useState(connection.name)
  const [savingName, setSavingName] = React.useState(false)
  const [nextActionMove, setNextActionMove] = React.useState<Move | null>(null)
  const [busy, setBusy] = React.useState(false)

  const providerName = providerDisplay(connection.provider)
  const domains = connection.domains.map((d) => d.name).join(", ") || "your domains"

  const testHref =
    mounted && authOrigin
      ? `${authOrigin}/sso/test-run?${new URLSearchParams({
          connection: connection.id,
          redirect_url: `${window.location.origin}${window.location.pathname}?tab=test`,
        })}`
      : null

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    if (!nameDraft.trim() || nameDraft.trim() === connection.name) {
      setEditingName(false)
      return
    }
    setSavingName(true)
    try {
      const after = await call(
        () => changeSsoConnection(connection.id, { name: nameDraft.trim() }),
        { title: "Could not rename connection" },
      )
      if (after) {
        onChange({ ...connection, ...after, domains: connection.domains })
        toastDone("Connection renamed")
        setEditingName(false)
      }
    } finally {
      setSavingName(false)
    }
  }

  async function executeNextAction(m: Move): Promise<boolean> {
    setBusy(true)
    try {
      const after = await call(
        () => changeSsoConnection(connection.id, { status: m.to }),
        { title: `Could not move to ${m.label.toLowerCase()}` },
      )
      if (!after) return false
      onChange({ ...connection, ...after, domains: connection.domains })
      toastDone(`Connection ${m.done.toLowerCase()}`)
      return true
    } finally {
      setBusy(false)
    }
  }

  let chipLabel = "On"
  let chipTone: BadgeTone = "success"
  let sentence: React.ReactNode = `People at ${domains} can choose ${providerName} at sign-in.`
  let nextAction: React.ReactNode = testHref ? (
    <ButtonLink href={testHref} size="sm" native>
      Test sign-in
    </ButtonLink>
  ) : null

  if (connection.status === "disabled") {
    chipLabel = "Off"
    chipTone = "warning"
    sentence = "Nobody can sign in through this connection until you turn it back on."
    nextAction = (
      <Button
        size="sm"
        onClick={() =>
          setNextActionMove({
            to: "active",
            label: "Turn on",
            title: "Turn on connection?",
            description: `People at ${domains} can sign in through this connection.`,
            confirmLabel: "Turn on",
            done: "Active",
          })
        }
      >
        Turn on
      </Button>
    )
  } else if (connection.status === "testing") {
    chipLabel = "Testing"
    chipTone = "neutral"
    sentence =
      "Nobody signs in through this connection yet. You can run test sign-ins and edit settings."
    nextAction = (
      <Button
        size="sm"
        onClick={() =>
          setNextActionMove({
            to: "active",
            label: "Turn on",
            title: "Turn on connection?",
            description: `People at ${domains} can sign in through this connection.`,
            confirmLabel: "Turn on",
            done: "Active",
          })
        }
      >
        Turn on
      </Button>
    )
  } else if (connection.status === "draft") {
    chipLabel = "Draft"
    chipTone = "neutral"
    sentence = "This connection is in setup."
    nextAction = (
      <Button
        size="sm"
        onClick={() =>
          setNextActionMove({
            to: "testing",
            label: "Move to testing",
            title: "Move to testing?",
            description:
              "You can run test sign-ins and edit settings before turning it on.",
            confirmLabel: "Move to testing",
            done: "Testing",
          })
        }
      >
        Move to testing
      </Button>
    )
  } else {
    const health = healthLabel(connection.health, connection.status)
    if (health && health.state !== "healthy") {
      chipLabel = health.label
      chipTone = HEALTH_TONE[health.state]
      sentence = health.reason ?? "Sign-ins are experiencing failures."
    } else if (connection.enforcement === "off") {
      chipLabel = "On"
      chipTone = "neutral"
      sentence = "This connection is live, but not yet offered to anyone at sign-in."
    } else if (
      connection.enforcement === "required_domain" ||
      connection.enforcement === "required_all"
    ) {
      chipLabel = "Required"
      chipTone = "success"
      sentence = `Everyone at ${domains} must sign in through ${providerName}.`
    }
  }

  return (
    <div className="space-y-4">
      <Link
        href="/settings/sso"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Single sign-on
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <IdpMark
            idp={
              connection.provider === "generic"
                ? connection.protocol
                : connection.provider
            }
            className="size-9"
          />
          {editingName ? (
            <form onSubmit={saveName} className="flex items-center gap-2">
              <FloatingInput
                label="Connection name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                maxLength={100}
                autoFocus
              />
              <Button size="sm" type="submit" loading={savingName}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setEditingName(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-medium">{connection.name}</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setNameDraft(connection.name)
                  setEditingName(true)
                }}
              >
                Rename
              </Button>
            </div>
          )}
        </div>

        <HeaderMenu connection={connection} domains={domains} onChange={onChange} />
      </div>

      <StatusLine
        label={chipLabel}
        tone={chipTone}
        sentence={sentence}
        action={nextAction}
      />

      {connection.status !== "draft" && authOrigin && (
        <div className="pt-1">
          <CopyField
            label="Team sign-in link"
            value={`${authOrigin}/sso/${connection.id}`}
          />
        </div>
      )}

      {connection.status === "active" && !abilities.owner && (
        <p className="text-xs text-muted-foreground">
          This connection is live. Changes to who it trusts are an owner&apos;s; you can
          still disable it.
        </p>
      )}

      <ConfirmDialog
        open={nextActionMove !== null}
        onOpenChange={(open) => !busy && !open && setNextActionMove(null)}
        title={nextActionMove?.title ?? ""}
        description={nextActionMove?.description ?? ""}
        confirmLabel={nextActionMove?.confirmLabel ?? "Confirm"}
        doneLabel={nextActionMove?.done ?? "Done"}
        ready={!busy}
        destructive={nextActionMove?.destructive ?? false}
        onConfirm={async () => {
          if (!nextActionMove) return false
          return await executeNextAction(nextActionMove)
        }}
      />
    </div>
  )
}
