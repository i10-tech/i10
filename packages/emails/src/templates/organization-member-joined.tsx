import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

export function OrganizationMemberJoined({
  url,
  organizationName,
  emailAddress,
}: {
  url: string
  organizationName?: string
  emailAddress?: string
}) {
  return (
    <Layout preview="A new member joined your organization on i10">
      <Text style={styles.heading}>A new member has joined</Text>
      <Text style={styles.text}>
        {emailAddress ?? "Someone"} has joined {organizationName ?? "your organization"}{" "}
        via an invitation.
      </Text>
      <ActionButton href={url}>Go to i10</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}
