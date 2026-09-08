import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/** An invitation to i10 itself — the app invitation and the waitlist one. */
export default function Invitation({
  url,
  expiresInDays,
  fromWaitlist,
}: {
  url: string
  expiresInDays?: string
  fromWaitlist?: boolean
}) {
  return (
    <Layout preview="Your invitation to i10">
      <Text style={styles.heading}>Your invitation</Text>
      <Text style={styles.text}>You have been invited to join i10.</Text>
      {expiresInDays ? (
        <Text style={styles.text}>
          This invitation expires in {expiresInDays} days.
        </Text>
      ) : null}
      <ActionButton href={url}>Accept invitation</ActionButton>
      <FallbackLink href={url} />
      {fromWaitlist ? (
        <Text style={{ ...styles.text, color: "#8a8a8a" }}>
          You are receiving this because you joined the waitlist.
        </Text>
      ) : null}
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
Invitation.PreviewProps = {
  url: "https://auth.i10.tech/accept?ticket=sample",
  expiresInDays: "7",
} satisfies React.ComponentProps<typeof Invitation>
