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
export type ExpiringCredentialKind = "certificate" | "client secret" | "SCIM token"

export const ssoCertificateExpiringSubject = (
  days: number,
  connection: string,
  credential: ExpiringCredentialKind = "certificate",
) => {
  const name =
    credential === "certificate"
      ? "The SSO certificate"
      : credential === "client secret"
        ? "The client secret"
        : "The SCIM token"
  return days <= 0
    ? `${name} for ${connection} has expired`
    : `${name} for ${connection} expires in ${days === 1 ? "1 day" : `${days} days`}`
}

export default function SsoCertificateExpiring({
  workspace,
  connection,
  days,
  expires,
  url,
  credential = "certificate",
}: {
  workspace: string
  connection: string
  days: number
  expires: string
  url: string
  credential?: ExpiringCredentialKind
}) {
  const title = ssoCertificateExpiringSubject(days, connection, credential)
  const noun =
    credential === "certificate"
      ? "signing certificate"
      : credential === "client secret"
        ? "client secret"
        : "SCIM token"
  const consequence =
    credential === "SCIM token"
      ? "user provisioning through it will fail"
      : "people cannot sign in through it"
  const pastConsequence =
    credential === "SCIM token"
      ? "User provisioning through it fails until a new one is configured."
      : "People cannot sign in through it until a new one is added."
  const nextStep =
    credential === "certificate"
      ? "Add the new certificate from your identity provider before then. If the connection uses a metadata URL, it picks the new one up on its own."
      : credential === "client secret"
        ? "Add the new client secret from your identity provider before then."
        : "Generate a new SCIM token in the console and update your identity provider before then."
  const buttonText =
    credential === "SCIM token" ? "Open directory settings" : "Open the connection"
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        {days <= 0
          ? `The ${noun} of ${connection} in ${workspace} expired on ${expires}. ${pastConsequence}`
          : `The ${noun} of ${connection} in ${workspace} expires on ${expires}. After that, ${consequence}.`}
      </Text>
      <Text style={styles.text}>{nextStep}</Text>
      <ActionButton href={url}>{buttonText}</ActionButton>
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
