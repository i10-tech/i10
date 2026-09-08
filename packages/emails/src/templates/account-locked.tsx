import { Section, Text } from "@react-email/components"
import { Detail, Layout, styles } from "../layout.js"

export function AccountLocked({
  lockedAt,
  failedAttempts,
  lockoutDuration,
}: {
  lockedAt?: string
  failedAttempts?: string
  lockoutDuration?: string
}) {
  return (
    <Layout preview="Your i10 account has been locked">
      <Text style={styles.heading}>Account locked</Text>
      <Text style={styles.text}>
        Your account has been locked. To protect it, access is temporarily restricted.
      </Text>
      <Section style={{ margin: "16px 0" }}>
        {lockedAt ? <Detail label="Locked on" value={lockedAt} /> : null}
        {failedAttempts ? (
          <Detail label="Failed attempts" value={failedAttempts} />
        ) : null}
      </Section>
      <Text style={styles.text}>
        {lockoutDuration
          ? `It unlocks automatically after ${lockoutDuration}.`
          : "It unlocks automatically after a short wait."}{" "}
        If you were not expecting this, someone may be trying to sign in as you — change
        your password once you can.
      </Text>
    </Layout>
  )
}
