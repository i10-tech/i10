import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

export function OrganizationInvitation({
  url,
  organizationName,
  inviterName,
}: {
  url: string
  organizationName?: string
  inviterName?: string
}) {
  const org = organizationName ?? "an organization"

  return (
    <Layout preview={`Your invitation to join ${org} on i10`}>
      <Text style={styles.heading}>Your invitation</Text>
      <Text style={styles.text}>
        {inviterName
          ? `${inviterName} has invited you to join ${org} on i10.`
          : `You have been invited to join ${org} on i10.`}
      </Text>
      <ActionButton href={url}>Accept invitation</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}
