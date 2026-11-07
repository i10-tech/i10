"use client"

import * as React from "react"
import Link from "next/link"
import { Button } from "@repo/ui/components/button/button"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { teamAccessDomains, type AccessDomain } from "@/lib/actions"
import { addSsoDomain, removeSsoDomain, ssoConnections } from "@/lib/sso-actions"
import { domainChoices } from "@/lib/sso-domain-choices"
import { toastDone, toastFailure } from "@/lib/toast"
import type { SsoAbilities, SsoConnection } from "@/lib/sso-types"
import { SettingsRow } from "../settings-card"
import { InlineError } from "../setup/inline-error"
import {
  connectionWriteNeedsStepUp,
  isLocked,
  OwnerNote,
  useSsoAttempt,
  useSsoCall,
} from "../shared"

export function DomainsRow({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const attempt = useSsoAttempt()
  const locked = isLocked(connection, abilities)
  const [open, setOpen] = React.useState(false)
  const [options, setOptions] = React.useState<AccessDomain[] | null>(null)
  const [connections, setConnections] = React.useState<SsoConnection[]>([])
  const [choice, setChoice] = React.useState<string | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)

  React.useEffect(() => {
    void Promise.all([teamAccessDomains(), ssoConnections()]).then(
      ([domainsResult, connectionsResult]) => {
        setOptions(
          domainsResult.ok
            ? domainsResult.data.data.filter((d) => d.status === "verified")
            : [],
        )
        setConnections(connectionsResult.ok ? connectionsResult.data.data : [])
      },
    )
  }, [])

  const choices = domainChoices(options ?? [], connections, connection)

  async function add() {
    if (!choice) return
    setRefusal(null)
    const domain = choices.find((d) => d.id === choice && !d.coveredBy)
    const result = await attempt(() => addSsoDomain(connection.id, choice), {
      stepUp: connectionWriteNeedsStepUp(connection),
    })
    if (result === null) return
    if (!result.ok) {
      toastFailure(result, { title: "Could not add the domain" })
      setRefusal(result.error)
      if (result.status === 409) {
        const latest = await ssoConnections()
        if (latest.ok) setConnections(latest.data.data)
        setChoice(null)
      }
      return
    }
    if (domain) {
      onChange({
        ...connection,
        domains: [
          ...connection.domains,
          { joinDomainId: domain.id, name: domain.name, live: true },
        ],
      })
      setChoice(null)
      toastDone(`${domain.name} added`)
    }
  }

  async function remove(joinDomainId: string, name: string) {
    const ok = await call(() => removeSsoDomain(connection.id, joinDomainId), {
      stepUp: connectionWriteNeedsStepUp(connection),
      title: "Could not remove the domain",
    })
    if (ok) {
      onChange({
        ...connection,
        domains: connection.domains.filter((d) => d.joinDomainId !== joinDomainId),
      })
      toastDone(`${name} removed`)
    }
  }

  const domainNames = connection.domains.map((d) => d.name).join(", ")

  return (
    <SettingsRow
      title="Domains"
      description="Only addresses on these verified domains can sign in through this connection."
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "Done" : "Manage"}
        </Button>
      }
    >
      <div className="text-sm font-medium text-foreground">
        {domainNames || "No domain yet"}
      </div>

      <Reveal show={open} spacing="pt-3" keepMounted>
        <div className="space-y-3">
          {connection.domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No domain yet. A connection cannot go live without one.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {connection.domains.map((d) => (
                <li
                  key={d.joinDomainId}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  {!d.live && (
                    <span className="text-xs text-muted-foreground">
                      Not verified right now
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={() => void remove(d.joinDomainId, d.name)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {choices.length > 0 && (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <MorphSelect
                  label="Add a verified domain"
                  value={choice}
                  disabled={locked}
                  onValueChange={(value) => {
                    setChoice(value)
                    setRefusal(null)
                  }}
                  items={choices.map((d) => ({
                    value: d.id,
                    label: d.coveredBy
                      ? `${d.name} (covered by ${d.coveredBy.name})`
                      : d.name,
                    disabled: d.coveredBy !== null,
                  }))}
                />
              </div>
              <Button variant="secondary" disabled={locked || !choice} onClick={add}>
                Add
              </Button>
            </div>
          )}

          {choices.some((d) => d.coveredBy) && (
            <p className="text-xs text-muted-foreground">
              A domain belongs to one connection. To move one here, remove it from the
              other connection first.
            </p>
          )}

          <InlineError message={refusal} />

          <p className="text-xs text-muted-foreground">
            Need another domain? Prove it on the{" "}
            <Link
              href="/settings/team"
              className="text-foreground underline underline-offset-4"
            >
              Team page
            </Link>
            , then add it here.
          </p>

          <OwnerNote abilities={abilities} />
        </div>
      </Reveal>
    </SettingsRow>
  )
}
