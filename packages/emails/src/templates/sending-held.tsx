import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A workspace's sending was held by our own review (#170), or released.
 *
 * ⚠ IT SAYS WHY IN A CATEGORY, NEVER A THRESHOLD. "Too many recent messages
 * bounced" tells somebody what to fix; "bounces above 8%" tells them to stay
 * at 7.9%.
 *
 * ⚠ IT SAYS A PERSON WILL LOOK, AND HOW TO REACH THEM. An automated hold is
 * reviewed by a human within a day (GDPR Article 22), and the customer's route
 * to that human is replying to this email - the only appeal path until the
 * admin app (#217) exists.
 *
 * ⚠ AND IT NAMES WHAT DID NOT STOP, like the SES pause email: mailboxes,
 * domains and the account keep working, so a hold does not read as a
 * suspension.
 */
export type HoldState = "held" | "released"

export const sendingHeldSubject = (state: HoldState, workspace: string) =>
  state === "held"
    ? `Sending is on hold for ${workspace} while we review it`
    : `Sending has resumed for ${workspace}`

export default function SendingHeld({
  state,
  workspace,
  why,
  canceled,
  url,
}: {
  state: HoldState
  workspace: string
  /** The category's sentence, e.g. "too many recent messages bounced". */
  why: string
  /** How many queued or scheduled emails the hold canceled. */
  canceled: number
  url: string
}) {
  const title = sendingHeldSubject(state, workspace)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      {state === "held" ? (
        <>
          <Text style={styles.text}>
            Our automated review put sending for the {workspace} workspace on hold
            because {why}. While it is held, the API refuses new emails with a{" "}
            <strong>sending_held</strong> error. Your mailboxes, domains and account
            keep working, and you can still sign in and see everything.
          </Text>
          {canceled > 0 ? (
            <Text style={styles.text}>
              {canceled === 1
                ? "One queued or scheduled email was canceled"
                : `${canceled} queued or scheduled emails were canceled`}{" "}
              so it would not go out during the review. You can send them again once
              sending resumes.
            </Text>
          ) : null}
          <Text style={styles.text}>
            A person on our team will review the workspace within a day. If you think
            this is a mistake, or want to tell us what you are sending and to whom,
            reply to this email - it reaches the people who can lift the hold.
          </Text>
        </>
      ) : (
        <Text style={styles.text}>
          We reviewed the {workspace} workspace and lifted the hold. The API accepts new
          emails again. Thank you for your patience.
        </Text>
      )}
      <ActionButton href={url}>Open the console</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

SendingHeld.PreviewProps = {
  state: "held",
  workspace: "Acme",
  why: "too many recent messages bounced",
  canceled: 12,
  url: "https://console.i10.tech",
} satisfies React.ComponentProps<typeof SendingHeld>
