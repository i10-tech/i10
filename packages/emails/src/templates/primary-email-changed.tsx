import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

export function PrimaryEmailChanged({ newEmailAddress }: { newEmailAddress?: string }) {
  return (
    <Layout preview="Your i10 primary email address was updated">
      <Text style={styles.heading}>Email address updated</Text>
      <Text style={styles.text}>
        The primary email address for your account is now{" "}
        <b>{newEmailAddress ?? "a new address"}</b>. It is where account and recovery
        mail will be sent from now on.
      </Text>
      <Text style={styles.text}>
        If this was not you, contact support straight away.
      </Text>
    </Layout>
  )
}
