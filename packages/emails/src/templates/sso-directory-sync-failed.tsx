import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A directory sync pull failed (#343). To the workspace's owners and SSO admins,
 * deduplicated so a failing hourly pull does not mail hourly.
 */
export const ssoDirectorySyncFailedSubject = (directory: string) =>
  `Directory sync failed for ${directory}`

export default function SsoDirectorySyncFailed({
  workspace,
  directory,
  url,
}: {
  workspace: string
  directory: string
  error?: string
  url: string
}) {
  const title = ssoDirectorySyncFailedSubject(directory)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        Directory sync for {directory} in {workspace} could not complete.
      </Text>
      <Text style={styles.text}>
        Check your directory settings and permissions in the console to resolve the
        issue.
      </Text>
      <ActionButton href={url}>Open directory settings</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SsoDirectorySyncFailed.PreviewProps = {
  workspace: "Acme",
  directory: "Google Workspace",
  error: "unauthorized_client",
  url: "https://console.i10.tech/settings/sso",
} satisfies React.ComponentProps<typeof SsoDirectorySyncFailed>
