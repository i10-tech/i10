import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

/**
 * ⚠ A NOTIFICATION, NOT A CODE, AND IT MUST NEVER CARRY A LINK TO ACT ON.
 * "Your password changed — click here if it wasn't you" is the exact shape of a
 * phishing mail, and teaching customers to click it is teaching them to fall
 * for the copy. It tells them where to go; it does not take them there.
 */
export function PasswordChanged() {
  return (
    <Layout preview="Your i10 password was changed">
      <Text style={styles.heading}>Your password was changed</Text>
      <Text style={styles.text}>
        The password on your i10 account has just been changed, and every other session
        was signed out.
      </Text>
      <Text style={styles.text}>
        If that was not you, sign in at auth.i10.tech and reset your password straight
        away.
      </Text>
    </Layout>
  )
}
