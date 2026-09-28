import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A workspace's sending was paused by our provider, or resumed (#157) - or is
 * at risk of being paused, on a HIGH reputation finding (#158).
 *
 * ⚠ IT NAMES WHAT STOPPED AND WHAT DID NOT. A paused workspace's API sends are
 * refused, but its mailboxes, domains and account are untouched - and a
 * customer who reads "your sending was paused" as "your account was suspended"
 * opens a panicked ticket instead of looking at their bounce rate.
 *
 * ⚠ AND IT NEVER PROMISES A DATE. Reinstatement follows a review we do not
 * control the length of; a guessed timeline becomes the thing we are held to.
 *
 * ⚠ `at_risk` SAYS NOTHING HAS STOPPED YET. It is the warning before the pause,
 * and reading like the pause itself would make the real one land as a repeat.
 */
export type SendingState = "paused" | "resumed" | "at_risk"

export const sendingStatusSubject = (state: SendingState, workspace: string) =>
  state === "paused"
    ? `Sending is paused for ${workspace}`
    : state === "resumed"
      ? `Sending has resumed for ${workspace}`
      : `Sending for ${workspace} is at risk of being paused`

export default function SendingStatus({
  state,
  workspace,
  cause,
  url,
}: {
  state: SendingState
  workspace: string
  /** Our provider's own reason, when it gave one. */
  cause: string | null
  url: string
}) {
  const title = sendingStatusSubject(state, workspace)

  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      {state === "at_risk" ? (
        <>
          <Text style={styles.text}>
            Our email provider raised a serious warning about recent mail from the{" "}
            {workspace} workspace, usually because too many messages bounced or were
            marked as spam. Nothing has stopped yet: the API still accepts and sends
            your emails. If it continues, sending will be paused automatically.
          </Text>
          {cause ? <Text style={styles.text}>What it found: {cause}</Text> : null}
          <Text style={styles.text}>
            Check your recent bounces and complaints, remove addresses that did not ask
            for your mail, and slow down sends to older lists until the rate recovers.
            The console shows the finding until it clears.
          </Text>
        </>
      ) : state === "paused" ? (
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
  state: "at_risk",
  workspace: "Acme",
  cause:
    "The bounce rate exceeded 15.0% based on a representative volume of 664 emails.",
  url: "https://console.i10.tech",
} satisfies React.ComponentProps<typeof SendingStatus>
