import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * Something about how an account or a key is being used does not add up
 * (#170): impossible travel, or an API key used from several countries.
 *
 * ⚠ IT TELLS THE PERSON WHAT WE DID, NOT ONLY WHAT WE SAW. For impossible
 * travel every session was signed out, and somebody who opens the email after
 * finding themselves logged out needs to read that it was us and why.
 *
 * ⚠ IT NEVER INCLUDES AN IP OR A LINK TO "SECURE YOUR ACCOUNT" ELSEWHERE.
 * Security emails are what phishing imitates; ours points only at our own
 * console, and asks nothing of the reader but to sign in and check.
 */
export type SecurityKind = "impossible_travel" | "key_spread"

export const securityAlertSubject = (kind: SecurityKind) =>
  kind === "impossible_travel"
    ? "We signed you out of i10 after an unusual sign-in"
    : "An i10 API key is being used from several countries"

export default function SecurityAlert({
  kind,
  from,
  to,
  url,
}: {
  kind: SecurityKind
  /** Country names or codes, for impossible travel. */
  from?: string | null
  to?: string | null
  url: string
}) {
  const title = securityAlertSubject(kind)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      {kind === "impossible_travel" ? (
        <>
          <Text style={styles.text}>
            Your account was used from {from ?? "one country"} and then from{" "}
            {to ?? "another"} sooner than anyone could travel between them. To be safe
            we signed you out everywhere. Sign in again to continue.
          </Text>
          <Text style={styles.text}>
            If one of those was not you, change your password after signing in and turn
            on two-step verification. If you use a VPN, this can be a false alarm, and
            nothing else about your account has changed.
          </Text>
        </>
      ) : (
        <Text style={styles.text}>
          One of your workspace&apos;s API keys was used from several countries in the
          last day. Keys are usually called from a few servers in one place, so this can
          mean a key has leaked. Check which keys are in use in the console, and rotate
          any key you do not recognise.
        </Text>
      )}
      <ActionButton href={url}>Open the console</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SecurityAlert.PreviewProps = {
  kind: "impossible_travel",
  from: "Germany",
  to: "Brazil",
  url: "https://console.i10.tech",
} satisfies React.ComponentProps<typeof SecurityAlert>
