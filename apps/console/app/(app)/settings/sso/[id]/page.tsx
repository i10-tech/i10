import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { PanelError } from "@/components/panel-error"
import { ConnectionView } from "@/components/sso/connection/connection-view"
import type { MailSignInInitial } from "@/components/sso/connection/mail-sign-in"
import { tryApi } from "@/lib/api"
import { flowCovers } from "@/lib/sso-guides"
import { authOrigin, ssoAbilities } from "@/lib/sso-server"
import type {
  LdapSetup,
  OidcMailSetup,
  OktaHookSetup,
  SsoConnections,
} from "@/lib/sso-types"

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

  // The mail sign-in section's three reads, side by side. A read that fails is
  // left out, and the section asks again from the browser, where a refusal
  // (a plan, a role) is said in its own words instead of failing the page.
  const route = `/console/identity/connections/${encodeURIComponent(connection.id)}`
  const [oidc, ldap, hook] = await Promise.all([
    tryApi<OidcMailSetup>(`${route}/oidc-mail`),
    tryApi<LdapSetup>(`${route}/ldap`),
    connection.provider === "okta"
      ? tryApi<OktaHookSetup>(`${route}/okta-event-hook`)
      : null,
  ])
  const mail: MailSignInInitial = {
    ...(oidc.ok ? { oidc: oidc.data } : {}),
    ...(ldap.ok ? { ldap: ldap.data } : {}),
    ...(hook?.ok ? { hook: hook.data } : {}),
  }

  return (
    <ConnectionView
      initial={connection}
      mail={mail}
      abilities={who.abilities}
      authOrigin={authOrigin()}
      clerkEnabled={Boolean(process.env.CLERK_PUBLISHABLE_KEY)}
    />
  )
}
