import { Text } from "@react-email/components"
import { Layout, Provenance, styles } from "../layout.js"

/**
 * Two-factor authentication was turned on.
 *
 * ⚠ THIS IS THE ONE SECURITY NOTICE THAT IS USUALLY GOOD NEWS, and the copy
 * says so rather than leading with alarm. Every other message in this group
 * reports something being removed or changed; leading this one the same way
 * trains people to skim past the ones that matter.
 */
export function MfaEnabled({
  greetingName,
  emailAddress,
  requestedFrom,
  requestedAt,
}: {
  greetingName?: string
  emailAddress?: string
  requestedFrom?: string
  requestedAt?: string
}) {
  return (
    <Layout preview="Two-step verification is on for your i10 account">
      <Text style={styles.heading}>Two-step verification enabled</Text>
      {greetingName ? <Text style={styles.text}>Hi {greetingName},</Text> : null}
      <Text style={styles.text}>
        Two-step verification is now switched on for{" "}
        {emailAddress ?? "your i10 account"}. You will be asked for a second factor when
        you sign in.
      </Text>
      <Provenance from={requestedFrom} at={requestedAt} />
    </Layout>
  )
}
