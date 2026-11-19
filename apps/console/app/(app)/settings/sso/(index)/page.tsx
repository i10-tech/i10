import type { Metadata } from "next"
import { SsoHomeView } from "@/components/sso-home-view"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { ssoShape, type SsoData } from "@/lib/shapes/sso"
import { ssoAbilities } from "@/lib/sso-server"
import type { SsoConnections, SsoDirectories } from "@/lib/sso-types"

export const metadata: Metadata = { title: "Single sign-on" }

const EMPTY_CONNECTIONS: SsoConnections = {
  data: [],
  protocols: [],
  presets: { oidc: [], saml: [] },
}

export default async function SingleSignOnPage() {
  const who = await ssoAbilities()
  if (!who.ok)
    return <PanelError title="Could not load your workspace" message={who.message} />

  if (!who.abilities.manage) {
    const unauthorizedData: SsoData = {
      canManage: false,
      available: true,
      catalog: EMPTY_CONNECTIONS,
      abilities: who.abilities,
    }
    return <SsoHomeView shape={ssoShape.of(unauthorizedData)} data={unauthorizedData} />
  }

  const [catalog, directories] = await Promise.all([
    tryApi<SsoConnections>("/console/identity/connections"),
    tryApi<SsoDirectories>("/console/identity/directories"),
  ])

  if (!catalog.ok && catalog.error.statusCode === 501) {
    const unavailableData: SsoData = {
      canManage: true,
      available: false,
      catalog: EMPTY_CONNECTIONS,
      abilities: who.abilities,
    }
    return <SsoHomeView shape={ssoShape.of(unavailableData)} data={unavailableData} />
  }

  const data: SsoData = {
    canManage: true,
    available: true,
    catalog: catalog.ok ? catalog.data : EMPTY_CONNECTIONS,
    directories: directories.ok ? directories.data : undefined,
    abilities: who.abilities,
    ...(catalog.ok ? {} : { error: catalog.error.message }),
  }

  return <SsoHomeView shape={ssoShape.of(data)} data={data} />
}
