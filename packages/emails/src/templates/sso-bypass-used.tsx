import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * Somebody signed in to the workspace through the SSO bypass list (#345,
 * sso.md decision 7). To the workspace's OTHER owners and admins, once per
 * bypass session.
 *
 * ⚠ NAMES THE ADDRESS THE PERSON SIGNED IN WITH AND WHEN, NOTHING ELSE: no IP,
 * no device. The audit log has those, behind the console's own sign-in.
 */
export const ssoBypassUsedSubject = (workspace: string) =>
  `Someone skipped SSO to sign in to ${workspace}`

export default function SsoBypassUsed({
  workspace,
  person,
  when,
  url,
}: {
  workspace: string
  person: string
  when: string
  url: string
}) {
  const title = ssoBypassUsedSubject(workspace)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        {person} signed in to {workspace} on {when} using the bypass list, so they
        skipped your single sign-on requirement.
      </Text>
      <Text style={styles.text}>
        If you did not expect this, remove them from the bypass list and review the
        audit log.
      </Text>
      <ActionButton href={url}>Open the audit log</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SsoBypassUsed.PreviewProps = {
  workspace: "Acme",
  person: "ada@acme.com",
  when: "6 October 2026, 10:40 UTC",
  url: "https://console.i10.tech/settings/sso",
} satisfies React.ComponentProps<typeof SsoBypassUsed>
