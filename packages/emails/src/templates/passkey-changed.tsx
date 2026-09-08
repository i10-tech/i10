import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

/**
 * ⚠ ONE COMPONENT FOR ADDED AND REMOVED, because the two Clerk templates differ
 * by a single word and the security advice is identical. The registry maps both
 * slugs; splitting them later is a file move, not a rewrite.
 */
export function PasskeyChanged({
  action,
  greetingName,
  emailAddress,
  passkeyName,
}: {
  action: "added" | "removed"
  greetingName?: string
  emailAddress?: string
  passkeyName?: string
}) {
  return (
    <Layout preview={`A passkey was ${action} on your i10 account`}>
      <Text style={styles.heading}>Passkey {action}</Text>
      {greetingName ? <Text style={styles.text}>Hi {greetingName},</Text> : null}
      <Text style={styles.text}>
        A passkey{passkeyName ? ` (${passkeyName})` : ""} for{" "}
        {emailAddress ?? "your account"} was {action}.
      </Text>
      <Text style={styles.text}>
        If this was not you, contact support straight away.
      </Text>
    </Layout>
  )
}
