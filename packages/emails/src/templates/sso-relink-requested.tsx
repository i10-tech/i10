import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * Logins waiting for approval after an IdP subject change (#345).
 * Sent only to workspace owners, who are the only ones who can approve.
 */
export const ssoRelinkRequestedSubject = (count: number, connection: string) =>
  count === 1
    ? `A company login is waiting for approval in ${connection}`
    : `Company logins are waiting for approval in ${connection}`

export default function SsoRelinkRequested({
  workspace,
  connection,
  count,
  url,
}: {
  workspace: string
  connection: string
  count: number
  url: string
}) {
  const title = ssoRelinkRequestedSubject(count, connection)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        {count === 1
          ? `1 person has signed in with a changed identity provider login for ${connection} in ${workspace}. Only an owner can approve the new login before they can sign in.`
          : `${count} people have signed in with changed identity provider logins for ${connection} in ${workspace}. Only an owner can approve the new logins before they can sign in.`}
      </Text>
      <Text style={styles.text}>
        Review and approve waiting logins on the connection&apos;s Access tab.
      </Text>
      <ActionButton href={url}>Review waiting logins</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SsoRelinkRequested.PreviewProps = {
  workspace: "Acme",
  connection: "Acme Okta",
  count: 3,
  url: "https://console.i10.tech/settings/security/conn_123?tab=access",
} satisfies React.ComponentProps<typeof SsoRelinkRequested>
