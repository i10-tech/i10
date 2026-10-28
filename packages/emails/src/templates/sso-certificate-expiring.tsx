import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A SAML identity provider certificate is about to expire, or has (#345). To
 * the workspace's owners and the admins who manage SSO, at 30, 7 and 1 days
 * and on the day.
 *
 * ⚠ SAYS WHAT HAPPENS AND WHAT TO DO. An expired certificate signs nobody in
 * through that connection, so the mail names the connection and the date and
 * points at the connection's page, where the new certificate is added.
 */
export const ssoCertificateExpiringSubject = (days: number, connection: string) =>
  days <= 0
    ? `The SSO certificate for ${connection} has expired`
    : `The SSO certificate for ${connection} expires in ${days === 1 ? "1 day" : `${days} days`}`

export default function SsoCertificateExpiring({
  workspace,
  connection,
  days,
  expires,
  url,
}: {
  workspace: string
  connection: string
  days: number
  expires: string
  url: string
}) {
  const title = ssoCertificateExpiringSubject(days, connection)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        {days <= 0
          ? `The signing certificate of ${connection} in ${workspace} expired on ${expires}. People cannot sign in through it until a new one is added.`
          : `The signing certificate of ${connection} in ${workspace} expires on ${expires}. After that, people cannot sign in through it.`}
      </Text>
      <Text style={styles.text}>
        Add the new certificate from your identity provider before then. If the
        connection uses a metadata URL, it picks the new one up on its own.
      </Text>
      <ActionButton href={url}>Open the connection</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SsoCertificateExpiring.PreviewProps = {
  workspace: "Acme",
  connection: "Acme Okta",
  days: 7,
  expires: "13 October 2026",
  url: "https://console.i10.tech/settings/sso",
} satisfies React.ComponentProps<typeof SsoCertificateExpiring>
