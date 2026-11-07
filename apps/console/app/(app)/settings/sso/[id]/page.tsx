import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PanelError } from "@/components/panel-error"
import { ConnectionView } from "@/components/sso/connection/connection-view"
import { tryApi } from "@/lib/api"
import { flowCovers } from "@/lib/sso-guides"
import { authOrigin, ssoAbilities } from "@/lib/sso-server"
import type { SsoConnections } from "@/lib/sso-types"

export const metadata: Metadata = { title: "SSO connection" }

export default async function SsoConnectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const [{ id }] = await Promise.all([params, searchParams])
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

  if (
    (connection.status === "draft" || connection.status === "testing") &&
    flowCovers(connection.provider, connection.protocol)
  ) {
    redirect(`/settings/sso/connect?connection=${connection.id}`)
  }

  return (
    <ConnectionView
      initial={connection}
      abilities={who.abilities}
      authOrigin={authOrigin()}
      clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
    />
  )
}
