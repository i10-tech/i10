import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

export default function OrganizationMemberJoined({
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

/*
 * ⚠ `PreviewProps` IS WHAT LETS THE TEMPLATE AND ITS PREVIEW BE ONE FILE.
 * `email dev` renders a directory of DEFAULT exports and has no way to invent
 * props, so this used to need a second `emails/` tree holding sample values —
 * two files per template, and a preview that could silently drift from what is
 * actually sent. react-email reads this static instead, so the thing you look
 * at IS the thing that goes out.
 *
 * It costs a few sample strings in the built bundle. Nothing reads them at
 * runtime; the alternative was a whole parallel directory.
 */
OrganizationMemberJoined.PreviewProps = {
  url: "https://dash.i10.tech",
  organizationName: "Acme",
  emailAddress: "new@acme.com",
} satisfies React.ComponentProps<typeof OrganizationMemberJoined>
