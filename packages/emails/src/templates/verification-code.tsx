import { Text } from "@react-email/components"
import { Code, Layout, Provenance, styles } from "../layout.js"

/** Clerk's "Verification code" — sign-up, and any re-verification of an address. */
export function VerificationCode({
  code,
  requestedFrom,
  requestedAt,
}: {
  code: string
  requestedFrom?: string
  requestedAt?: string
}) {
  return (
    <Layout preview="Your i10 verification code">
      <Text style={styles.heading}>Verification code</Text>
      <Text style={styles.text}>Enter this code when prompted:</Text>
      <Code code={code} />
      <Text style={styles.text}>
        To protect your account, do not share this code with anyone.
      </Text>
      <Provenance from={requestedFrom} at={requestedAt} />
    </Layout>
  )
}
