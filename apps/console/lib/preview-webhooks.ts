/**
 * Preview fixtures for the webhook screens (#286). See lib/preview.ts.
 *
 * ⚠ ONE ENDPOINT IN EACH STATE THE SCREENS HAVE TO HANDLE: healthy with a
 * grace period running, failing with a transformation, polling, SQS switched
 * off by i10, and paused by the customer. A preview where every endpoint is
 * healthy shows none of the banners, notices or empty states worth reviewing.
 *
 * ⚠ IT TAKES THE NOT-FOUND MARKER AS AN ARGUMENT rather than importing it, so
 * this module and preview.ts do not import each other.
 */

type Query = Record<string, string | number | undefined | null> | undefined
type Route = [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string, body?: unknown) => unknown,
]

const HOUR = 3_600_000
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const q = (query: Query, name: string) => {
  const v = query?.[name]
  return v === undefined || v === null || v === "" ? undefined : String(v)
}

const E = {
  api: "5f7a1c00-0000-4000-8000-000000000001",
  slack: "5f7a1c00-0000-4000-8000-000000000002",
  poll: "5f7a1c00-0000-4000-8000-000000000003",
  sqs: "5f7a1c00-0000-4000-8000-000000000004",
  paused: "5f7a1c00-0000-4000-8000-000000000005",
}

const MAIL_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.unsubscribed",
]

const SLACK_CODE = `// For a Slack incoming webhook (https://hooks.slack.com/services/...).
export default function handler(webhook) {
  const { type, data } = webhook.payload
  webhook.payload = { text: \`\${type}: \${data.subject ?? ""}\` }
  return webhook
}
`

function base() {
  return {
    object: "webhook_endpoint" as const,
    description: null as string | null,
    enabled: true,
    disabled_reason: null as string | null,
    health: "healthy" as "healthy" | "failing" | "disabled",
    health_changed_at: null as string | null,
    poll_cursor: null as string | null,
    last_polled_at: null as string | null,
    transformation: null as { code: string; enabled: boolean } | null,
    aws_access_key_id: null as string | null,
    signature_scheme: "hmac_sha256" as "hmac_sha256" | "ed25519",
    rate_limit: null as number | null,
    header_names: [] as string[],
    filter_domains: null as string[] | null,
    filter_tags: null as Record<string, string> | null,
    public_key: null as string | null,
    previous_secrets: [] as {
      signature_scheme: "hmac_sha256" | "ed25519"
      expires_at: string
    }[],
  }
}

function endpoints() {
  return [
    {
      ...base(),
      id: E.api,
      kind: "http" as const,
      url: "https://api.acme.com/webhooks/i10",
      events: ["email.delivered", "email.bounced", "email.complained", "email.failed"],
      description: "Production handler",
      created_at: at(140 * 24 * HOUR),
      header_names: ["x-gateway-token"],
      // A grace period in progress, so the warning line can be reviewed.
      previous_secrets: [
        {
          signature_scheme: "hmac_sha256" as const,
          expires_at: new Date(Date.now() + 5 * HOUR).toISOString(),
        },
      ],
    },
    {
      ...base(),
      id: E.slack,
      kind: "http" as const,
      url: "https://hooks.slack.com/services/T0001/B0001/preview",
      events: ["email.bounced", "email.complained"],
      description: "Ops channel",
      health: "failing" as const,
      health_changed_at: at(40 * 60_000),
      created_at: at(12 * 24 * HOUR),
      transformation: { code: SLACK_CODE, enabled: true },
    },
    {
      ...base(),
      id: E.poll,
      kind: "polling" as const,
      url: null,
      events: ["email.delivered", "email.bounced"],
      description: "Warehouse sync",
      created_at: at(30 * 24 * HOUR),
      poll_cursor: "1842",
      last_polled_at: at(3 * 60_000),
    },
    {
      ...base(),
      id: E.sqs,
      kind: "sqs" as const,
      url: "https://sqs.eu-west-1.amazonaws.com/123456789012/i10-events",
      events: MAIL_EVENTS,
      description: "Analytics queue",
      enabled: false,
      health: "disabled" as const,
      health_changed_at: at(26 * HOUR),
      disabled_reason: "No successful delivery for 5 days.",
      aws_access_key_id: "AKIAPREVIEW0000EXAMPLE",
      created_at: at(60 * 24 * HOUR),
    },
    {
      ...base(),
      id: E.paused,
      kind: "http" as const,
      url: "https://staging.acme.com/hooks/i10",
      events: ["email.delivered"],
      description: "Staging",
      enabled: false,
      disabled_reason: "Paused.",
      created_at: at(9 * 24 * HOUR),
      signature_scheme: "ed25519" as const,
      public_key: "whpk_3vYpPreviewPublicKeyOnlyNotARealKey0000000=",
      rate_limit: 50,
      filter_domains: ["acme.com"],
      filter_tags: { env: "staging" },
    },
  ]
}

/** A deterministic wobble, so a reload draws the same chart. */
function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function series(endpointIndex: number, since: Date, bucket: "hour" | "day") {
  const step = bucket === "hour" ? HOUR : 24 * HOUR
  const start = Math.floor(since.getTime() / step) * step
  const out = []
  for (let t = start; t <= Date.now(); t += step) {
    const n = noise(t / step + endpointIndex * 101)
    const scale = bucket === "day" ? 24 : 1
    // The paused and disabled ones go quiet; the failing one fails lately.
    const quiet = endpointIndex === 3 || endpointIndex === 4
    const recent = Date.now() - t < 2 * HOUR
    const volume = quiet ? 0 : Math.round((20 + n * 60) * scale)
    const failing = endpointIndex === 1 && recent
    const failed = failing
      ? volume
      : Math.round(volume * (n > 0.92 ? 0.08 : n > 0.75 ? 0.01 : 0))
    const pending = recent && !quiet ? Math.round(volume * 0.05) : 0
    const delivered = Math.max(0, volume - failed - pending)
    const attempts = volume + failed * 2
    out.push({
      start: new Date(t).toISOString(),
      delivered,
      failed,
      pending,
      attempts,
      failed_attempts: failed * 3,
      p50_ms: attempts ? 120 + n * 80 : null,
      p95_ms: attempts ? 480 + n * 900 : null,
    })
  }
  return out
}

function totals(rows: ReturnType<typeof series>) {
  const sum = (
    k: "delivered" | "failed" | "pending" | "attempts" | "failed_attempts",
  ) => rows.reduce((a, r) => a + r[k], 0)
  const delivered = sum("delivered")
  const failed = sum("failed")
  const attempts = sum("attempts")
  return {
    delivered,
    failed,
    pending: sum("pending"),
    attempts,
    failed_attempts: sum("failed_attempts"),
    success_rate: delivered + failed ? delivered / (delivered + failed) : null,
    p50_ms: attempts ? 164 : null,
    p95_ms: attempts ? 912 : null,
  }
}

function windowOf(query: Query) {
  const since = new Date(q(query, "since") ?? Date.now() - 24 * HOUR)
  const bucket = q(query, "bucket") === "day" ? ("day" as const) : ("hour" as const)
  return { since, bucket }
}

function byType(endpointIndex: number, t: ReturnType<typeof totals>) {
  const types = endpoints()[endpointIndex]!.events.slice(0, 4)
  return types.map((type, i) => ({
    event_type: type,
    delivered: Math.round(t.delivered / (i + 2)),
    failed: i === 1 ? t.failed : 0,
    pending: i === 0 ? t.pending : 0,
  }))
}

const CATALOG_DESCRIPTIONS: Record<string, string> = {
  "email.sent": "We accepted the message and handed it on for delivery.",
  "email.delivered": "The receiving server accepted it.",
  "email.delivery_delayed": "A temporary failure. Still trying.",
  "email.bounced": "Permanently rejected. The address is suppressed automatically.",
  "email.complained": "Delivered, then marked as spam.",
  "email.failed": "We could not send it at all.",
  "email.opened": "Opened, on a domain with open tracking on.",
  "email.clicked": "A link was clicked, on a domain with click tracking on.",
  "email.unsubscribed":
    "The recipient unsubscribed through the provider's list management.",
  "webhook_endpoint.failing":
    "One of your endpoints has had no success for 15 minutes.",
  "webhook_endpoint.disabled": "i10 switched one of your endpoints off.",
  "webhook_endpoint.recovered": "An endpoint that was failing or off delivered again.",
}

function example(type: string) {
  if (type.startsWith("webhook_endpoint.")) {
    return {
      endpoint_id: "00000000-0000-7000-8000-000000000001",
      url: "https://example.com/webhooks/i10",
      reason: type.endsWith("recovered") ? null : "500 Internal Server Error",
      failing_since: "2026-10-01T11:00:00.000Z",
      test: true,
    }
  }
  return {
    email_id: "00000000-0000-7000-8000-000000000000",
    from: "Acme <hello@example.com>",
    to: ["ada@example.com"],
    subject: "Your receipt from Acme",
    created_at: "2026-10-01T12:00:00.000Z",
    tags: { category: "receipt" },
    test: true,
    ...(type === "email.bounced"
      ? {
          bounce: {
            type: "permanent",
            subtype: "general",
            recipients: ["ada@example.com"],
            diagnostic: "smtp; 550 5.1.1 user unknown",
          },
        }
      : {}),
  }
}

function catalog() {
  return Object.entries(CATALOG_DESCRIPTIONS).map(([type, description]) => ({
    object: "webhook_event_type" as const,
    type,
    version: 1,
    description,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.keys(example(type)).map((k) => [
          k,
          { type: k === "to" ? "array" : "string" },
        ]),
      ),
      required: Object.keys(example(type)).slice(0, 3),
    },
    example: example(type),
  }))
}

type Status = "pending" | "delivered" | "failed"

/**
 * How long ago the i-th delivery was made: minutes apart at the top, days
 * apart at the bottom, so each date range in the filter keeps a different
 * number of rows.
 */
const deliveryAge = (i: number) => Math.round(i ** 2.2 * 6 * 60_000)

/**
 * The message a delivery is about, which the search matches by prefix. Rows do
 * not carry it, as the API's do not; eight messages share the forty rows.
 */
const messageOf = (deliveryId: string) =>
  `0e5a1c0${Number(deliveryId.slice(-2)) % 8}${deliveryId.slice(8)}`

/** Forty deliveries across the HTTP and SQS endpoints, newest first. */
function deliveries() {
  const eps = endpoints()
  const sendable = [eps[0]!, eps[1]!, eps[3]!, eps[2]!]
  return Array.from({ length: 40 }, (_, i) => {
    const ep = sendable[i % 4]!
    const failing = ep.id === E.slack || ep.id === E.sqs
    const status: Status =
      i < 2 ? "pending" : failing && i % 3 !== 0 ? "failed" : "delivered"
    const type = ep.events[Math.floor(i / 4) % ep.events.length]!
    return {
      id: `6f7a1c00-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
      endpoint_id: ep.id,
      endpoint_url: ep.url,
      event_type: type,
      status,
      attempts:
        status === "delivered" ? (i % 7 === 3 ? 2 : 1) : status === "failed" ? 8 : 2,
      // ⚠ A 403 BESIDE THE 503s, AND THE SLACK TRANSFORM THAT NEVER SENDS
      // ANYTHING, so every band of the response filter has rows to show.
      response_status:
        ep.kind === "polling"
          ? null
          : status === "delivered"
            ? 200
            : ep.id === E.slack
              ? null
              : status === "pending"
                ? 502
                : ep.id === E.sqs && i % 8 === 2
                  ? 403
                  : 503,
      last_error:
        status === "delivered"
          ? null
          : ep.id === E.slack
            ? "Transformation failed: TypeError: Cannot read properties of undefined (reading 'join')"
            : status === "pending"
              ? "502 Bad Gateway"
              : ep.id === E.sqs && i % 8 === 2
                ? "403 AccessDenied: the key cannot send to this queue"
                : "503 Service Unavailable",
      occurred_at: at(deliveryAge(i) + 5_000),
      delivered_at: status === "delivered" ? at(deliveryAge(i)) : null,
      created_at: at(deliveryAge(i)),
    }
  })
}

/** `http_class` as the API reads it: `none` is attempted, undelivered, unanswered. */
function inClass(
  d: { response_status: number | null; attempts: number; status: Status },
  band: string | undefined,
) {
  const status = d.response_status
  if (!band) return true
  if (band === "none")
    return status === null && d.attempts > 0 && d.status !== "delivered"
  return status !== null && Math.floor(status / 100) === Number(band[0])
}

/** The API's id search: a hex prefix, dashes ignored; anything else matches nothing. */
function matchesId(ids: string[], search: string | undefined) {
  if (!search) return true
  const hex = (v: string) => v.toLowerCase().replaceAll("-", "")
  const prefix = hex(search.trim())
  if (!/^[0-9a-f]{1,32}$/.test(prefix)) return false
  return ids.some((id) => hex(id).startsWith(prefix))
}

function attempt(
  n: number,
  url: string,
  msAgo: number,
  outcome:
    | { status: number; body: string }
    | { kind: "timeout" | "connect" | "transform"; error: string },
  trigger: "scheduled" | "manual" | "recover" | "replay" | "test" = "scheduled",
) {
  const ok = "status" in outcome && outcome.status < 300
  return {
    object: "webhook_attempt" as const,
    id: `7a7a1c00-0000-4000-8000-${String(n).padStart(4, "0")}${String(msAgo % 1e8).padStart(8, "0")}`,
    attempt: n,
    trigger,
    lane: n > 3 ? ("retry" as const) : ("ordered" as const),
    url,
    request_headers: {
      "content-type": "application/json",
      "user-agent": "i10-webhooks/1",
      "webhook-id": "msg_preview",
      "webhook-timestamp": String(Math.floor((Date.now() - msAgo) / 1000)),
      "x-gateway-token": "••••",
    },
    response_status: "status" in outcome ? outcome.status : null,
    response_headers:
      "status" in outcome
        ? {
            "content-type": ok ? "application/json" : "text/html",
            date: new Date(Date.now() - msAgo).toUTCString(),
            server: "nginx",
          }
        : null,
    response_body: "status" in outcome ? outcome.body : null,
    duration_ms:
      "status" in outcome
        ? ok
          ? 142
          : 2310
        : outcome.kind === "timeout"
          ? 10_000
          : 31,
    error_kind: "status" in outcome ? (ok ? null : ("status" as const)) : outcome.kind,
    error:
      "status" in outcome
        ? ok
          ? null
          : `${outcome.status} from the endpoint`
        : outcome.error,
    created_at: at(msAgo),
  }
}

function deliveryDetail(id: string) {
  const row = deliveries().find((d) => d.id === id)
  if (!row) return null
  const url = row.endpoint_url ?? "https://api.i10.tech/webhook-endpoints/poll"
  const payload = {
    id: row.id,
    type: row.event_type,
    created_at: row.occurred_at,
    sequence: 1800 + Number(row.id.slice(-2)),
    data: example(row.event_type),
  }
  const t0 = Date.now() - new Date(row.created_at).getTime()
  let log: ReturnType<typeof attempt>[] = []
  if (row.endpoint_id === E.slack) {
    log = Array.from({ length: row.status === "pending" ? 2 : 3 }, (_, i) =>
      attempt(i + 1, url, t0 - i * 5 * 60_000, {
        kind: "transform",
        error:
          "TypeError: Cannot read properties of undefined (reading 'join')\n    at handler (transformation.js:4:28)",
      }),
    )
  } else if (row.status === "failed") {
    log = [
      attempt(1, url, t0, {
        status: 500,
        body: "<html><body>Internal Server Error</body></html>",
      }),
      attempt(2, url, t0 - 5_000, {
        kind: "timeout",
        error: "No answer within 10 seconds.",
      }),
      attempt(
        3,
        url,
        t0 - 65_000,
        row.response_status === 403
          ? {
              status: 403,
              body: "<AccessDenied>Not authorized for sqs:SendMessage</AccessDenied>",
            }
          : { status: 503, body: '{"error":"maintenance"}' },
      ),
      attempt(4, url, t0 - 10 * 60_000, {
        kind: "connect",
        error: "connect ECONNREFUSED",
      }),
    ]
  } else if (row.status === "pending") {
    log = [
      attempt(1, url, t0, {
        kind: "connect",
        error: "connect ECONNREFUSED 203.0.113.7:443",
      }),
      attempt(2, url, t0 - 5_000, { status: 502, body: "Bad Gateway" }),
    ]
  } else if (row.endpoint_id !== E.poll) {
    log =
      row.attempts === 2
        ? [
            attempt(1, url, t0, {
              status: 500,
              body: '{"error":"database is locked"}',
            }),
            attempt(
              2,
              url,
              t0 - 5_000,
              { status: 200, body: '{"received":true}' },
              "manual",
            ),
          ]
        : [attempt(1, url, t0, { status: 200, body: '{"received":true}' })]
  }
  // The third delivery has been expunged, so that state can be reviewed.
  const expunged = id.endsWith("000000000003")
  return {
    object: "webhook_delivery" as const,
    ...row,
    sequence: payload.sequence,
    next_attempt_at:
      row.status === "pending"
        ? new Date(Date.now() + 25 * 60_000).toISOString()
        : null,
    payload: expunged ? {} : payload,
    payload_expunged_at: expunged ? at(HOUR) : null,
    transformed:
      row.endpoint_id === E.slack && !expunged && row.status === "delivered"
        ? {
            method: "POST" as const,
            url: "/services/T0001/B0001/preview",
            headers: {},
            body: JSON.stringify({ text: `${row.event_type}: Your receipt from Acme` }),
          }
        : null,
    attempt_log: log,
  }
}

/**
 * ⚠ A REPLAY STARTED IN PREVIEW MOVES. Its counts grow from the moment it was
 * started and it finishes after a few seconds, so the progress poll can be
 * watched doing its job. Per server process, reset by a restart.
 */
const started = new Map<
  string,
  { endpoint: string; replay: Record<string, unknown>; t: number }
>()

function progressed(entry: { replay: Record<string, unknown>; t: number }) {
  const total = 240
  const examined = Math.min(total, Math.round(((Date.now() - entry.t) / 1000) * 40))
  const done = examined >= total
  return {
    ...entry.replay,
    status: done ? "done" : examined === 0 ? "queued" : "running",
    examined,
    queued: Math.round(examined * 0.4),
    updated_at: new Date().toISOString(),
    finished_at: done ? new Date(entry.t + 6000).toISOString() : null,
  }
}

function replays(endpoint: string) {
  const mine = [...started.values()]
    .filter((s) => s.endpoint === endpoint)
    .sort((a, b) => b.t - a.t)
    .map(progressed)
  if (endpoint !== E.api && endpoint !== E.sqs) return mine
  return [
    ...mine,
    {
      object: "webhook_replay",
      id: "8b7a1c00-0000-4000-8000-000000000001",
      endpoint_id: endpoint,
      kind: "replay",
      status: "done",
      filter: {
        since: at(3 * 24 * HOUR),
        until: at(2 * 24 * HOUR),
        statuses: ["failed"],
      },
      queued: 37,
      examined: 412,
      error: null,
      created_at: at(2 * 24 * HOUR - 60_000),
      updated_at: at(2 * 24 * HOUR - 120_000),
      finished_at: at(2 * 24 * HOUR - 120_000),
    },
    {
      object: "webhook_replay",
      id: "8b7a1c00-0000-4000-8000-000000000002",
      endpoint_id: endpoint,
      kind: "replay_missing",
      status: "failed",
      filter: { since: at(9 * 24 * HOUR), until: at(8 * 24 * HOUR) },
      queued: 12,
      examined: 80,
      error: "The endpoint was switched off while this ran.",
      created_at: at(8 * 24 * HOUR),
      updated_at: at(8 * 24 * HOUR - 30_000),
      finished_at: at(8 * 24 * HOUR - 30_000),
    },
  ]
}

function healthEvents(endpoint: string | undefined) {
  const all = [
    {
      id: "9c7a1c00-0000-4000-8000-000000000001",
      endpoint_id: E.slack,
      kind: "failing" as const,
      url: "https://hooks.slack.com/services/T0001/B0001/preview",
      reason: "Transformation failed: TypeError: Cannot read properties of undefined",
      failing_since: at(55 * 60_000),
      created_at: at(40 * 60_000),
    },
    {
      id: "9c7a1c00-0000-4000-8000-000000000002",
      endpoint_id: E.sqs,
      kind: "disabled" as const,
      url: "https://sqs.eu-west-1.amazonaws.com/123456789012/i10-events",
      reason: "No successful delivery for 5 days.",
      failing_since: at(6 * 24 * HOUR),
      created_at: at(26 * HOUR),
    },
    {
      id: "9c7a1c00-0000-4000-8000-000000000003",
      endpoint_id: E.sqs,
      kind: "failing" as const,
      url: "https://sqs.eu-west-1.amazonaws.com/123456789012/i10-events",
      reason: "AccessDenied: not authorized to perform sqs:SendMessage",
      failing_since: at(6 * 24 * HOUR),
      created_at: at(6 * 24 * HOUR - 15 * 60_000),
    },
    {
      id: "9c7a1c00-0000-4000-8000-000000000004",
      endpoint_id: E.api,
      kind: "recovered" as const,
      url: "https://api.acme.com/webhooks/i10",
      reason: null,
      failing_since: null,
      created_at: at(3 * 24 * HOUR - 20 * 60_000),
    },
    {
      id: "9c7a1c00-0000-4000-8000-000000000005",
      endpoint_id: E.api,
      kind: "failing" as const,
      url: "https://api.acme.com/webhooks/i10",
      reason: "503 Service Unavailable",
      failing_since: at(3 * 24 * HOUR + 20 * 60_000),
      created_at: at(3 * 24 * HOUR),
    },
  ]
  return all
    .filter((e) => !endpoint || e.endpoint_id === endpoint)
    .map((e) => ({ object: "webhook_health_event" as const, ...e }))
}

export function webhookRoutes(notFound: symbol): Route[] {
  const find = (id: string) => endpoints().find((e) => e.id === id)
  const index = (id: string) => endpoints().findIndex((e) => e.id === id)

  return [
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/rotate-secret$/,
      (m, _q, _method, body) => {
        const e = find(m[1]!)
        if (!e) return notFound
        const b = (body ?? {}) as {
          previous_secret?: string
          expires_in?: number
          signature_scheme?: string
        }
        const ed = (b.signature_scheme ?? e.signature_scheme) === "ed25519"
        return {
          ...e,
          signature_scheme: ed ? ("ed25519" as const) : ("hmac_sha256" as const),
          public_key: ed ? "whpk_3vYpPreviewPublicKeyOnlyNotARealKey0000000=" : null,
          previous_secrets:
            b.previous_secret === "expire"
              ? [
                  {
                    signature_scheme: e.signature_scheme,
                    expires_at: new Date(
                      Date.now() + (b.expires_in ?? 3600) * 1000,
                    ).toISOString(),
                  },
                ]
              : [],
          secret: ed ? null : "whsec_cHJldmlldy1vbmx5LW5vdC1hLXJlYWwtc2VjcmV0",
        }
      },
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/revoke-previous-secrets$/,
      (m) => (find(m[1]!) ? { ...find(m[1]!), previous_secrets: [] } : notFound),
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/stats$/,
      (m, query) => {
        const i = index(m[1]!)
        if (i < 0) return notFound
        const { since, bucket } = windowOf(query)
        const rows = series(i, since, bucket)
        const t = totals(rows)
        return {
          object: "webhook_endpoint_stats",
          endpoint_id: m[1],
          since: since.toISOString(),
          until: new Date().toISOString(),
          bucket,
          ...t,
          last_success_at: i === 3 ? null : at(i === 1 ? 2 * HOUR : 90_000),
          failing_since: i === 1 ? at(55 * 60_000) : null,
          series: rows,
          by_event_type: byType(i, t),
        }
      },
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/test$/,
      () => ({ delivery_id: deliveries()[0]!.id }),
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/transformation\/test$/,
      (m, _q, _method, body) => {
        const e = find(m[1]!)
        if (!e) return notFound
        const b = (body ?? {}) as { code?: string; event_type?: string }
        if (b.code?.includes("throw")) {
          return {
            ok: false,
            error: "Error: thrown by the transformation\n    at handler (3:9)",
          }
        }
        const data = example(b.event_type ?? "email.delivered")
        const slack = b.code?.includes("text:")
        return {
          ok: true,
          request: {
            method: "POST",
            url: new URL(e.url ?? "https://example.com/").pathname,
            headers: {},
            body: JSON.stringify(
              slack
                ? { text: `${b.event_type}: ${"subject" in data ? data.subject : ""}` }
                : { type: b.event_type, data },
            ),
          },
        }
      },
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/replays\/([^/]+)$/,
      (m) => {
        const entry = started.get(m[2]!)
        if (entry) return progressed(entry)
        return (
          replays(m[1]!).find((r) => (r as { id?: unknown }).id === m[2]) ?? notFound
        )
      },
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/replays$/,
      (m) => ({ data: replays(m[1]!) }),
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)\/(replay|recover|replay-missing)$/,
      (m, _q, _method, body) => {
        const b = (body ?? {}) as {
          since: string
          until?: string
          statuses?: string[]
          event_type?: string
        }
        const id = `8b7a1c00-0000-4000-8000-${String(started.size + 10).padStart(12, "0")}`
        const replay = {
          object: "webhook_replay",
          id,
          endpoint_id: m[1],
          kind: m[2] === "replay-missing" ? "replay_missing" : "replay",
          status: "queued",
          filter: {
            since: b.since,
            until: b.until ?? new Date().toISOString(),
            ...(m[2] === "recover"
              ? { statuses: ["failed"] }
              : b.statuses
                ? { statuses: b.statuses }
                : {}),
            ...(b.event_type ? { event_type: b.event_type } : {}),
          },
          queued: 0,
          examined: 0,
          error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          finished_at: null,
        }
        started.set(id, { endpoint: m[1]!, replay, t: Date.now() })
        return replay
      },
    ],
    [
      /^\/console\/webhook-endpoints\/([^/]+)$/,
      (m, _q, method, body) => {
        const e = find(m[1]!)
        if (!e) return notFound
        if (method === "DELETE") return { id: e.id, deleted: true }
        if (method === "PATCH") {
          const patch = (body ?? {}) as Record<string, unknown>
          return {
            ...e,
            ...patch,
            ...(patch.enabled === true
              ? { health: "healthy", disabled_reason: null }
              : {}),
          }
        }
        return e
      },
    ],
    [
      /^\/console\/webhook-endpoints$/,
      (_m, _q, method, body) => {
        if (method === "POST") {
          const b = (body ?? {}) as Record<string, unknown>
          const kind = (b.kind as "http" | "polling" | "sqs") ?? "http"
          const ed = b.signature_scheme === "ed25519"
          return {
            ...base(),
            id: E.api,
            kind,
            url: kind === "polling" ? null : (b.url as string),
            events: b.events as string[],
            description: (b.description as string) ?? null,
            created_at: new Date().toISOString(),
            signature_scheme: ed ? "ed25519" : "hmac_sha256",
            public_key: ed ? "whpk_3vYpPreviewPublicKeyOnlyNotARealKey0000000=" : null,
            secret:
              kind === "polling" || ed
                ? null
                : "whsec_cHJldmlldy1vbmx5LW5vdC1hLXJlYWwtc2VjcmV0",
          }
        }
        return { data: endpoints() }
      },
    ],
    [
      /^\/console\/webhook-stats$/,
      (_m, query) => {
        const { since, bucket } = windowOf(query)
        const per = endpoints().map((e, i) => ({ e, rows: series(i, since, bucket) }))
        const all = totals(per.flatMap((p) => p.rows))
        return {
          object: "webhook_stats",
          since: since.toISOString(),
          until: new Date().toISOString(),
          bucket,
          ...all,
          series: per[0]!.rows,
          by_event_type: [],
          by_endpoint: per
            .filter((p, i) => i !== 4 && totals(p.rows).attempts > 0)
            .map((p) => {
              const t = totals(p.rows)
              return {
                endpoint_id: p.e.id,
                delivered: t.delivered,
                failed: t.failed,
                pending: t.pending,
                success_rate: t.success_rate,
                attempts: t.attempts,
                failed_attempts: t.failed_attempts,
                last_success_at: at(90_000),
              }
            }),
        }
      },
    ],
    [/^\/console\/webhook-event-types$/, () => ({ data: catalog() })],
    [
      /^\/console\/webhook-health-events$/,
      (_m, query) => ({
        data: healthEvents(q(query, "endpoint_id")),
        next_cursor: null,
      }),
    ],
    [
      /^\/console\/webhook-deliveries\/([^/]+)\/resend$/,
      (m) => (deliveryDetail(m[1]!) ? { delivery_id: m[1] } : notFound),
    ],
    [
      /^\/console\/webhook-deliveries\/([^/]+)\/payload$/,
      (m) => (deliveryDetail(m[1]!) ? { id: m[1], payload_expunged: true } : notFound),
    ],
    [
      /^\/console\/webhook-deliveries\/([^/]+)$/,
      (m) => deliveryDetail(m[1]!) ?? notFound,
    ],
    [
      /^\/console\/webhook-deliveries$/,
      (_m, query) => ({
        data: deliveries().filter(
          (d) =>
            (!q(query, "status") || d.status === q(query, "status")) &&
            (!q(query, "event_type") || d.event_type === q(query, "event_type")) &&
            (!q(query, "endpoint_id") || d.endpoint_id === q(query, "endpoint_id")) &&
            (!q(query, "since") || d.created_at >= q(query, "since")!) &&
            (!q(query, "until") || d.created_at < q(query, "until")!) &&
            inClass(d, q(query, "http_class")) &&
            matchesId([d.id, messageOf(d.id)], q(query, "q")),
        ),
        nextCursor: null,
      }),
    ],
  ]
}
