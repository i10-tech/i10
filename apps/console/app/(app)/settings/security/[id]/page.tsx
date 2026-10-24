import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { PanelError } from "@/components/panel-error"
import { ConnectionPage } from "@/components/sso/connection-page"
import { tryApi } from "@/lib/api"
import { authOrigin, ssoAbilities } from "@/lib/sso-server"
import type { SsoConnections } from "@/lib/sso-types"

export const metadata: Metadata = { title: "SSO connection" }

/**
 * One connection. The list is read whole and filtered by id: the connection
 * routes have no read-one, and a workspace holds a handful.
 */
export default async function SsoConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams])
  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />
  if (!who.abilities.manage) notFound()

  const connections = await tryApi<SsoConnections>("/console/identity/connections")
  if (!connections.ok)
    return (
      <PanelError
        title="Could not load the connection"
        message={connections.error.message}
      />
    )
  const connection = connections.data.data.find((c) => c.id === id)
  if (!connection) notFound()

  return (
    <ConnectionPage
      initial={connection}
      abilities={who.abilities}
      authOrigin={authOrigin()}
      clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
      tab={tab}
    />
  )
}
