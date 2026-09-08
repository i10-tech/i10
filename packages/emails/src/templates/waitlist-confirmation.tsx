import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

export function WaitlistConfirmation() {
  return (
    <Layout preview="You're on the i10 waitlist">
      <Text style={styles.heading}>You&apos;re on the waitlist</Text>
      <Text style={styles.text}>
        You have joined the waitlist for i10. We will let you know as we open up access.
      </Text>
    </Layout>
  )
}
