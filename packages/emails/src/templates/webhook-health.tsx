import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * One or more of a workspace's webhook endpoints started failing, was switched
 * off, or recovered (#284). One email covers every endpoint that changed since
 * the last one.
 *
 * ⚠ FAILING SAYS NOTHING IS LOST YET. Retries continue on the plan's schedule,
 * and an owner who reads "failing" as "your events are gone" replays
 * everything in a panic and gets every event twice.
 *
 * ⚠ DISABLED SAYS WHAT TO DO. Events stopped going to it; the fix is theirs,
 * then switching it back on, then a replay of what it missed - all three in
 * the console.
 */
export type WebhookHealthState = "failing" | "disabled" | "recovered"

export interface WebhookHealthLine {
  url: string
  state: WebhookHealthState
  /** The last error, or why it was switched off. */
  reason: string | null
  /** Already formatted: when it started failing, or when it recovered. */
  since: string
}

export const webhookHealthSubject = (
  worst: WebhookHealthState,
  count: number,
  workspace: string,
) => {
  if (count > 1) {
    return worst === "recovered"
      ? `${count} webhook endpoints for ${workspace} have recovered`
      : `${count} webhook endpoints for ${workspace} need attention`
  }
  return worst === "disabled"
    ? `A webhook endpoint for ${workspace} was switched off`
    : worst === "failing"
      ? `A webhook endpoint for ${workspace} is failing`
      : `A webhook endpoint for ${workspace} has recovered`
}

const lineText = (line: WebhookHealthLine) =>
  line.state === "failing"
    ? `has not accepted a webhook since ${line.since}. We keep retrying on your plan's schedule, so nothing is lost yet.`
    : line.state === "disabled"
      ? `was switched off, so events are no longer sent to it.`
      : `is accepting webhooks again, as of ${line.since}.`

export default function WebhookHealth({
  workspace,
  worst,
  lines,
  url,
}: {
  workspace: string
  worst: WebhookHealthState
  lines: WebhookHealthLine[]
  url: string
}) {
  const title = webhookHealthSubject(worst, lines.length, workspace)

  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      {lines.map((line) => (
        <Text key={line.url + line.state} style={styles.text}>
          <strong>{line.url}</strong> {lineText(line)}
          {line.reason ? (
            <>
              <br />
              {line.state === "disabled" ? "Why: " : "Last error: "}
              {line.reason}
            </>
          ) : null}
        </Text>
      ))}
      {worst === "disabled" ? (
        <Text style={styles.text}>
          Fix the receiver, then switch the endpoint back on in the console. Anything it
          missed while it was off can be replayed from the same page.
        </Text>
      ) : worst === "failing" ? (
        <Text style={styles.text}>
          The console shows every attempt and what your server answered. If it stays
          down long enough, the endpoint is switched off and you will hear from us
          again.
        </Text>
      ) : null}
      <ActionButton href={url}>Open webhooks</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

WebhookHealth.PreviewProps = {
  workspace: "Acme",
  worst: "disabled",
  lines: [
    {
      url: "https://api.acme.com/webhooks/i10",
      state: "disabled",
      reason: "No successful delivery for 5 days.",
      since: "3 October 2026, 09:12 UTC",
    },
    {
      url: "https://hooks.acme.com/ops",
      state: "failing",
      reason: "HTTP 503",
      since: "6 October 2026, 10:40 UTC",
    },
  ],
  url: "https://console.i10.tech/webhooks",
} satisfies React.ComponentProps<typeof WebhookHealth>
