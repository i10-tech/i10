import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { Badge, type BadgeTone } from "@repo/ui/components/badge/badge"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { healthLabel, type HealthState } from "@/lib/connection-health"
import { flowCovers } from "@/lib/sso-guides"
import type { SsoAbilities, SsoConnection, SsoConnections } from "@/lib/sso-types"
import { IdpMark } from "./idp-mark"

const MARKS = ["okta", "entra", "google"]

const HEALTH_TONE: Record<HealthState, BadgeTone> = {
  healthy: "success",
  degraded: "warning",
  failing: "danger",
}

/** One state, one chip, in the words a person would use. */
function stateOf(c: SsoConnection): { label: string; tone: BadgeTone; title?: string } {
  if (c.status === "disabled") return { label: "Off", tone: "warning" }
  if (c.status !== "active") return { label: "Setting up", tone: "neutral" }
  const health = healthLabel(c.health, c.status)
  if (health && health.state !== "healthy")
    return {
      label: health.label,
      tone: HEALTH_TONE[health.state],
      title: health.reason,
    }
  return {
    label: c.enforcement.startsWith("required") ? "Required" : "On",
    tone: "success",
  }
}

function Row({ connection }: { connection: SsoConnection }) {
  const state = stateOf(connection)
  const setup = connection.status === "draft" || connection.status === "testing"
  return (
    <li>
      <Link
        href={
          setup && flowCovers(connection.provider, connection.protocol)
            ? `/settings/sso/connect?connection=${connection.id}`
            : `/settings/sso/${connection.id}`
        }
        className="flex items-center gap-3 px-4 py-3 text-sm transition-colors duration-150 hover:bg-muted/50"
      >
        <IdpMark
          idp={
            connection.provider === "generic"
              ? connection.protocol
              : connection.provider
          }
          className="size-9"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{connection.name}</span>
          <span className="block truncate text-muted-foreground">
            {connection.domains.map((d) => d.name).join(", ") || "No domain yet"}
          </span>
        </span>
        <Badge tone={state.tone} size="sm" title={state.title}>
          {state.label}
        </Badge>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
}

export function SsoHome({
  catalog,
  abilities,
}: {
  catalog: SsoConnections
  abilities: SsoAbilities
}) {
  const connections = catalog.data
  if (connections.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-2xl border border-border p-5 sm:flex-row sm:items-center">
        <div className="flex -space-x-2">
          {MARKS.map((idp) => (
            <IdpMark key={idp} idp={idp} className="ring-2 ring-background" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Connect your identity provider</p>
          <p className="text-sm text-muted-foreground">
            Okta, Microsoft Entra, Google Workspace, or any SAML or OIDC provider.
          </p>
        </div>
        {abilities.manage && (
          <ButtonLink href="/settings/sso/connect" size="sm">
            Set up
          </ButtonLink>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
        {connections.map((c) => (
          <Row key={c.id} connection={c} />
        ))}
      </ul>
      {abilities.manage && (
        <ButtonLink href="/settings/sso/connect" variant="secondary" size="sm">
          Add another connection
        </ButtonLink>
      )}
    </div>
  )
}
