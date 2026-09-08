import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

/**
 * ⚠ A NOTIFICATION, AND IT MUST NEVER CARRY A LINK TO ACT ON. "Your password
 * changed — click here if it wasn't you" is the exact shape of a phishing mail,
 * and teaching customers to click it is teaching them to fall for the forgery.
 * It says where to go; it does not take them there.
 */
export function PasswordChanged({
  greetingName,
  emailAddress,
}: {
  greetingName?: string
  emailAddress?: string
}) {
  return (
    <Layout preview="Your i10 password was changed">
      <Text style={styles.heading}>Password changed</Text>
      {greetingName ? <Text style={styles.text}>Hi {greetingName},</Text> : null}
      <Text style={styles.text}>
        The password for {emailAddress ?? "your i10 account"} has just been changed.
      </Text>
      <Text style={styles.text}>
        If this was not you, sign in at auth.i10.tech and reset your password straight
        away.
      </Text>
    </Layout>
  )
}
