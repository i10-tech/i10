import type { HeroTone } from "@/components/detail-hero"
import type {
  WebhookEndpoint,
  WebhookEndpointKind,
  WebhookErrorKind,
} from "@/lib/types"

/**
 * The words and numbers every webhook screen shares (#286).
 *
 * ⚠ ONE PLACE DECIDES WHAT AN ENDPOINT'S STATE IS CALLED, because three
 * different things switch an endpoint off and they need three different
 * answers: i10 disabling it (fix the receiver, then turn it back on), the
 * customer pausing it (turn it back on), and it failing while still on
 * (nothing to press, the retries are running).
 */

export const KIND_LABEL: Record<WebhookEndpointKind, string> = {
  http: "HTTP",
  polling: "Polling",
  sqs: "Amazon SQS",
}

/** What an endpoint is called where its URL would be. */
export function endpointName(endpoint: Pick<WebhookEndpoint, "kind" | "url">): string {
  if (endpoint.url) return endpoint.url
  return endpoint.kind === "polling" ? "Polling endpoint" : "Endpoint"
}

/** The URL without its scheme, for a select or a crowded cell. */
export function shortName(endpoint: Pick<WebhookEndpoint, "kind" | "url">): string {
  return endpointName(endpoint).replace(/^https?:\/\//, "")
}

export type EndpointState = "healthy" | "failing" | "disabled" | "paused"

/**
 * ⚠ PAUSED IS THE CUSTOMER'S OWN ACT AND IS NOT A HEALTH. The API leaves
 * `health` alone on a pause, so an endpoint can be `healthy` and off at once;
 * it is `paused` here so the screen never says "healthy" about something that
 * is not being called.
 */
export function endpointState(
  endpoint: Pick<WebhookEndpoint, "enabled" | "health">,
): EndpointState {
  if (endpoint.health === "disabled") return "disabled"
  if (!endpoint.enabled) return "paused"
  return endpoint.health
}

export const STATE_LABEL: Record<EndpointState, string> = {
  healthy: "Healthy",
  failing: "Failing",
  disabled: "Disabled by i10",
  paused: "Paused",
}

export const STATE_TONE: Record<EndpointState, HeroTone> = {
  healthy: "success",
  failing: "warning",
  disabled: "danger",
  paused: "neutral",
}

/**
 * Failed attempts over attempts: retries count, because a receiver that only
 * succeeds on the third try is a receiver with a problem.
 */
export function errorRate(attempts: number, failed: number): number | null {
  return attempts === 0 ? null : failed / attempts
}

export function formatErrorRate(rate: number | null): string {
  if (rate === null) return "-"
  const pct = rate * 100
  if (pct === 0) return "0%"
  return pct < 1 ? `${pct.toFixed(2)}%` : `${pct.toFixed(1)}%`
}

/** Red past 5%, amber past none: any failure is worth a look. */
export function rateTone(rate: number | null): "danger" | "warning" | undefined {
  if (rate === null || rate === 0) return undefined
  return rate >= 0.05 ? "danger" : "warning"
}

export const ERROR_KIND_LABEL: Record<WebhookErrorKind, string> = {
  status: "Error response",
  timeout: "Timed out",
  connect: "Could not connect",
  tls: "TLS failed",
  blocked: "Blocked address",
  unresolved: "Did not resolve",
  transform: "Transformation failed",
}

export const TRIGGER_LABEL = {
  scheduled: "Scheduled",
  manual: "Resent",
  recover: "Recovery",
  replay: "Replay",
  test: "Test",
} as const

/** The stats windows the endpoint page offers, as `?window=`. */
export const WINDOWS = [
  { value: "24h", label: "24 hours", hours: 24, bucket: "hour" },
  { value: "7d", label: "7 days", hours: 24 * 7, bucket: "hour" },
  { value: "30d", label: "30 days", hours: 24 * 30, bucket: "day" },
] as const

export type WindowValue = (typeof WINDOWS)[number]["value"]

export function windowFor(value: string | undefined) {
  return WINDOWS.find((w) => w.value === value) ?? WINDOWS[0]
}

/** The `since` of a window, as the stats routes take it. */
export function windowQuery(value: string | undefined, now = Date.now()) {
  const w = windowFor(value)
  return {
    since: new Date(now - w.hours * 3_600_000).toISOString(),
    bucket: w.bucket,
  }
}

/** Pretty JSON for a `<pre>`; never `innerHTML`, it is the customer's data. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** A body the endpoint answered with: pretty when it is JSON, as-is when not. */
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

/**
 * Starting points for a transformation.
 *
 * ⚠ SLACK AND DISCORD ARE STARTERS, NOT A "FORMAT" SETTING. Polar ships them as
 * a per-endpoint payload format; here a transformation already reshapes the
 * body, so a chat message is one starter away and stays editable, rather than
 * a fixed layout we would have to maintain per event.
 */
export const TRANSFORMATION_STARTERS = {
  reshape: {
    label: "Reshape the payload",
    code: `export default function handler(webhook) {
  // webhook is { payload, method, url, headers }.
  // Change what you need and return it; it is signed after this runs.
  webhook.payload = {
    type: webhook.payload.type,
    data: webhook.payload.data,
  }
  return webhook
}
`,
  },
  slack: {
    label: "Slack message",
    code: `// For a Slack incoming webhook (https://hooks.slack.com/services/...).
export default function handler(webhook) {
  const { type, data } = webhook.payload
  const to = (data.to ?? []).join(", ")
  webhook.payload = {
    text: \`\${type}\${data.subject ? \`: \${data.subject}\` : ""}\${to ? \` to \${to}\` : ""}\`,
  }
  return webhook
}
`,
  },
  discord: {
    label: "Discord message",
    code: `// For a Discord webhook (https://discord.com/api/webhooks/...).
export default function handler(webhook) {
  const { type, data } = webhook.payload
  webhook.payload = {
    content: \`**\${type}**\${data.subject ? \` - \${data.subject}\` : ""}\`,
  }
  return webhook
}
`,
  },
} as const

export type StarterName = keyof typeof TRANSFORMATION_STARTERS

/** Which starter fits a URL: chat services are recognised by their hosts. */
export function starterFor(url: string | null): StarterName {
  if (url?.startsWith("https://hooks.slack.com/")) return "slack"
  if (url?.startsWith("https://discord.com/api/webhooks/")) return "discord"
  return "reshape"
}
