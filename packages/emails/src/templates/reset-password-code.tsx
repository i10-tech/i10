import { Text } from "@react-email/components"
import { Code, Layout, styles } from "../layout.js"

export function ResetPasswordCode({ code }: { code: string }) {
  return (
    <Layout preview="Your i10 password reset code">
      <Text style={styles.heading}>Reset your password</Text>
      <Text style={styles.text}>Enter this code to choose a new password.</Text>
      <Code code={code} />
      <Text style={styles.text}>
        If you did not ask to reset your password, ignore this message — your current
        password still works and nothing has changed.
      </Text>
    </Layout>
  )
}
