import { Text } from "@react-email/components"
import { Code, Layout, styles } from "../layout.js"

/**
 * Signing in from a browser Clerk does not recognise.
 *
 * ⚠ THIS IS DEVICE TRUST, NOT TWO-FACTOR AUTHENTICATION, and the copy says so
 * on purpose. Somebody who has never turned on 2FA and is asked for a code will
 * otherwise assume their account was changed without them — the wording has to
 * explain why they are seeing it.
 */
export function SignInCode({ code }: { code: string }) {
  return (
    <Layout preview="Your i10 sign-in code">
      <Text style={styles.heading}>Confirm it’s you</Text>
      <Text style={styles.text}>
        You’re signing in from a device we haven’t seen before. Enter this code to
        continue.
      </Text>
      <Code code={code} />
      <Text style={styles.text}>
        If this wasn’t you, someone may know your password. Change it as soon as you
        can.
      </Text>
    </Layout>
  )
}
