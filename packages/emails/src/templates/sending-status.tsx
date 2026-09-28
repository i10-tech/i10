import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A workspace's sending was paused by our provider, or resumed (#157).
 *
 * ⚠ IT NAMES WHAT STOPPED AND WHAT DID NOT. A paused workspace's API sends are
 * refused, but its mailboxes, domains and account are untouched - and a
 * customer who reads "your sending was paused" as "your account was suspended"
 * opens a panicked ticket instead of looking at their bounce rate.
 *
 * ⚠ AND IT NEVER PROMISES A DATE. Reinstatement follows a review we do not
 * control the length of; a guessed timeline becomes the thing we are held to.
 */
export default function SendingStatus({
  paused,
  workspace,
  cause,
  url,
}: {
  paused: boolean
  workspace: string
  /** Our provider's own reason, when it gave one. */
  cause: string | null
  url: string
}) {
  const title = paused
    ? `Sending is paused for ${workspace}`
    : `Sending has resumed for ${workspace}`

  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      {paused ? (
        <>
          <Text style={styles.text}>
            Our email provider paused sending for the {workspace} workspace, usually
            because too many recent messages bounced or were marked as spam. While it is
            paused, the API refuses new emails with a <strong>sending_paused</strong>{" "}
            error. Your mailboxes, domains and account keep working.
          </Text>
          {cause ? <Text style={styles.text}>The reason given: {cause}</Text> : null}
          <Text style={styles.text}>
            Check the suppression list and your recent bounces and complaints, and stop
            sending to addresses that did not ask for your mail. Reply to this email and
            we will review the workspace with you.
          </Text>
        </>
      ) : (
        <Text style={styles.text}>
          Sending for the {workspace} workspace is working again, and the API accepts
          new emails. For a while, new bounces and complaints count against the
          workspace more heavily, so keep an eye on your suppression list.
        </Text>
      )}
      <ActionButton href={url}>Open the console</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SendingStatus.PreviewProps = {
  paused: true,
  workspace: "Acme",
  cause:
    "The bounce rate exceeded 15.0% based on a representative volume of 664 emails.",
  url: "https://console.i10.tech",
} satisfies React.ComponentProps<typeof SendingStatus>
