import type { Metadata } from "next"
import { SecurityAuditView } from "@/components/security-audit-view"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { securityAuditShape, type SecurityAuditData } from "@/lib/shapes/security-audit"
import { ssoAbilities } from "@/lib/sso-server"
import type { IdentityEvent } from "@/lib/sso-types"

export const metadata: Metadata = { title: "Identity audit log" }

const STEPS = [50, 100, 200]

/**
 * Everything that changed about how people sign in and who they are: SSO and
 * directory settings, sessions, mailboxes, policies. An admin's page; the API
 * checks `sso:manage`.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; limit?: string }>
}) {
  const params = await searchParams
  const user = params.user?.trim() || undefined
  const requested = Number(params.limit)
  const limit = STEPS.includes(requested) ? requested : STEPS[0]!

  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />

  if (!who.abilities.manage) {
    const unauthorizedData: SecurityAuditData = {
      canManage: false,
      available: true,
      events: [],
      user: user ?? null,
      limit,
      nextLimit: null,
      clerkEnabled: Boolean(process.env.CLERK_PUBLISHABLE_KEY),
    }
    return (
      <SecurityAuditView
        shape={securityAuditShape.of(unauthorizedData)}
        data={unauthorizedData}
      />
    )
  }

  const events = await tryApi<{ data: IdentityEvent[] }>("/console/identity/events", {
    query: { limit, user },
  })

  if (!events.ok && events.error.statusCode === 501) {
    const unavailableData: SecurityAuditData = {
      canManage: true,
      available: false,
      events: [],
      user: user ?? null,
      limit,
      nextLimit: null,
      clerkEnabled: Boolean(process.env.CLERK_PUBLISHABLE_KEY),
    }
    return (
      <SecurityAuditView
        shape={securityAuditShape.of(unavailableData)}
        data={unavailableData}
      />
    )
  }

  const data: SecurityAuditData = {
    canManage: true,
    available: true,
    events: events.ok ? events.data.data : [],
    user: user ?? null,
    limit,
    nextLimit: STEPS[STEPS.indexOf(limit) + 1] ?? null,
    clerkEnabled: Boolean(process.env.CLERK_PUBLISHABLE_KEY),
    ...(events.ok ? {} : { error: events.error.message }),
  }

  return <SecurityAuditView shape={securityAuditShape.of(data)} data={data} />
}
