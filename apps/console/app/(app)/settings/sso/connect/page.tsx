import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PanelError } from "@/components/panel-error"
import { SetupFlow } from "@/components/sso/setup/setup-flow"
import type { AccessDomain } from "@/lib/actions"
import { tryApi } from "@/lib/api"
import { PREVIEW } from "@/lib/preview"
import { authOrigin, ssoAbilities } from "@/lib/sso-server"
import { flowCovers } from "@/lib/sso-guides"
import type { OidcSetup, SamlSetup, SsoConnections, TestRun } from "@/lib/sso-types"
import type { Me } from "@/lib/types"

export const metadata: Metadata = { title: "Connect your identity provider" }

/**
 * ⚠ ONE ROUTE FOR THE WHOLE SETUP, WITH THE CONNECTION IN THE QUERY: the shell
 * remounts a page when its pathname changes, which would drop the flow's state
 * and the fold of the first step at the moment the connection is created.
 */
export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ connection?: string }>
}) {
  const { connection: id } = await searchParams
  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />
  if (!who.abilities.manage) notFound()

  const [catalog, me, accessDomains] = await Promise.all([
    tryApi<SsoConnections>("/console/identity/connections"),
    tryApi<Me>("/console/me"),
    tryApi<{ data: AccessDomain[]; verified: string[]; suggested: string[] }>(
      "/console/team/access-domains",
    ),
  ])
  if (!catalog.ok)
    return (
      <PanelError title="Could not load providers" message={catalog.error.message} />
    )

  const shared = {
    catalog: catalog.data,
    initialAccessDomains: accessDomains.ok ? accessDomains.data : undefined,
    email: me.ok ? me.data.user.email : null,
    authOrigin: authOrigin(),
    previewTest: PREVIEW,
  }
  if (!id) return <SetupFlow initial={null} {...shared} />

  const connection = catalog.data.data.find((c) => c.id === id)
  if (!connection) notFound()
  const inSetup = connection.status === "draft" || connection.status === "testing"
  if (!inSetup || !flowCovers(connection.provider, connection.protocol))
    redirect(`/settings/sso/${id}`)

  const path = `/console/identity/connections/${encodeURIComponent(id)}`
  const [setup, runs] = await Promise.all([
    connection.protocol === "saml"
      ? tryApi<SamlSetup>(`${path}/saml`)
      : tryApi<OidcSetup>(`${path}/oidc`),
    tryApi<{ data: TestRun[] }>(`${path}/test-runs`),
  ])
  if (!setup.ok)
    return (
      <PanelError title="Could not load the connection" message={setup.error.message} />
    )
  return (
    <SetupFlow
      initial={{ connection, setup: setup.data, runs: runs.ok ? runs.data.data : [] }}
      {...shared}
    />
  )
}
