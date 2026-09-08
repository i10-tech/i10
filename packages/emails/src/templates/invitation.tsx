import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/** An invitation to i10 itself — the app invitation and the waitlist one. */
export function Invitation({
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
