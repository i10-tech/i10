import { Text } from "@react-email/components"
import { Code, Layout, styles } from "../layout.js"

/** Sign-up: proving the address belongs to the person creating the account. */
export function VerificationCode({ code }: { code: string }) {
  return (
    <Layout preview="Your i10 verification code">
      <Text style={styles.heading}>Verify your email</Text>
      <Text style={styles.text}>
        Enter this code to finish creating your i10 account.
      </Text>
      <Code code={code} />
      <Text style={styles.text}>
        The code expires shortly. If you did not try to create an account, you can
        ignore this message.
      </Text>
    </Layout>
  )
}
