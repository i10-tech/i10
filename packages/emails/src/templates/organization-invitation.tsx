import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

export default function OrganizationInvitation({
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
OrganizationInvitation.PreviewProps = {
  url: "https://auth.i10.tech/accept?ticket=sample",
  organizationName: "Acme",
  inviterName: "Mohamed",
} satisfies React.ComponentProps<typeof OrganizationInvitation>
