import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * Our review of a template a workspace submitted for repeated sending (#222):
 * approved, rejected, or an approval taken away.
 *
 * ⚠ IT SAYS WHAT AN APPROVAL DOES AND DOES NOT DO. Approval stops the
 * template's repetition from counting against the workspace; it never excuses
 * bounces or complaints. Saying so up front is what makes a later revocation
 * read as the rule it always was, not a surprise.
 *
 * ⚠ A REVOCATION NAMES A CATEGORY, NEVER A THRESHOLD, like the hold email:
 * "too many messages bounced" says what to fix; a percentage says where to
 * stop just short of it.
 */
export type TemplateDecision = "approved" | "rejected" | "revoked"

export const templateReviewSubject = (decision: TemplateDecision, template: string) =>
  decision === "approved"
    ? `Your template "${template}" was approved`
    : decision === "rejected"
      ? `Your template "${template}" was not approved`
      : `The approval of your template "${template}" was withdrawn`

export default function TemplateReview({
  decision,
  workspace,
  template,
  reason,
  url,
}: {
  decision: TemplateDecision
  workspace: string
  template: string
  /** Staff's note, or the category of a revocation. Optional. */
  reason: string | null
  url: string
}) {
  const title = templateReviewSubject(decision, template)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      {decision === "approved" ? (
        <>
          <Text style={styles.text}>
            We reviewed the template &quot;{template}&quot; that the {workspace}{" "}
            workspace submitted, and approved it. Messages that match it exactly, with
            only the placeholders filled in, no longer count as repeated content when we
            look at how the workspace sends.
          </Text>
          <Text style={styles.text}>
            The approval covers repetition only. Bounces and spam complaints count
            exactly as before, and if mail sent with this template bounces or is marked
            as spam too often, the approval is withdrawn automatically.
          </Text>
        </>
      ) : decision === "rejected" ? (
        <Text style={styles.text}>
          We reviewed the template &quot;{template}&quot; that the {workspace} workspace
          submitted, and did not approve it. Nothing about your sending changes: mail
          sent with it is treated like any other mail. You can submit a revised version
          from the console.
        </Text>
      ) : (
        <Text style={styles.text}>
          The approval of the template &quot;{template}&quot; in the {workspace}{" "}
          workspace was withdrawn. Mail sent with it is now treated like any other mail.
          Sending itself is not affected by this change.
        </Text>
      )}
      {reason ? <Text style={styles.text}>Our note: {reason}</Text> : null}
      <Text style={styles.text}>
        Questions? Reply to this email - it reaches the people who reviewed it.
      </Text>
      <ActionButton href={url}>Open the console</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

TemplateReview.PreviewProps = {
  decision: "approved",
  workspace: "Acme",
  template: "Password reset",
  reason: null,
  url: "https://console.i10.tech/templates",
} satisfies React.ComponentProps<typeof TemplateReview>
