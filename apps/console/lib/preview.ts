/**
 * Preview mode: the whole console, rendered from fixtures, with no API, no
 * database and no Clerk.
 *
 * ⚠ IT EXISTS SO THE INTERFACE CAN BE REVIEWED BEFORE THE STACK BEHIND IT IS
 * RUNNING. Standing this console up for real needs Postgres, Redis, a Clerk
 * instance and SES credentials; somebody who wants to look at a table and say
 * "that column is wrong" should not have to provision four services first.
 *
 * ⚠ IT IS IMPOSSIBLE TO ENABLE IN PRODUCTION, AND THAT IS ENFORCED BY THE
 * COMPILER RATHER THAN BY DISCIPLINE. `process.env.NODE_ENV` is replaced with
 * the literal `"production"` at build time by Next - in server code as well as
 * client - so in a production build the first half of the condition below is
 * `"production" !== "production"` and the whole expression folds to `false`.
 * Every `if (PREVIEW)` block is then a branch on a constant, and the bundler
 * deletes it: the compiled `api()` in the production output goes straight from
 * its path guard to `fetch`, with no reference to anything in this file. There
 * is no environment variable anybody can set in a pod to turn it back on.
 *
 * ⚠ WHAT IS REMOVED IS THE READ, NOT NECESSARILY THE DATA. Turbopack folds the
 * branch but still emits these fixture constants into the server chunk, where
 * they sit unreferenced - verified by building and grepping the output. That is
 * a few kilobytes of dead weight, and it is worth knowing precisely, because
 * the claim that matters is the checkable one: nothing in a production build
 * READS a fixture. "The module is gone" is a claim this build does not support,
 * and a security property stated more strongly than it is true is a security
 * property nobody re-checks.
 *
 * ⚠ AND IT IS OFF BY DEFAULT IN DEVELOPMENT TOO. `bun run dev` talks to a real
 * API on localhost; `bun run dev:preview` sets the variable. A developer
 * debugging a live query must never silently be looking at fixtures - that is
 * the failure mode that makes this kind of mode dangerous, and the only
 * protection is that turning it on is deliberate.
 */

export const PREVIEW =
  process.env.NODE_ENV !== "production" && process.env.CONSOLE_PREVIEW === "1"

/**
 * ⚠ THE FIXTURES ARE DELIBERATELY NOT ALL HEALTHY. A preview where every domain
 * is verified, nothing has bounced and every meter is at 12% shows none of the
 * states the interface actually has to handle - and those are exactly the ones
 * worth reviewing. There is a failed domain, a bounce, a complaint, a delayed
 * message, a revoked key, an unsubscribed contact and a meter past its
 * allowance.
 */

const DAY = 86_400_000
const now = Date.now()
const ago = (days: number, hours = 0) =>
  new Date(now - days * DAY - hours * 3_600_000).toISOString()

/** `YYYY-MM-DD`, UTC, `days` before today. */
function dayKey(days: number): string {
  return new Date(now - days * DAY).toISOString().slice(0, 10)
}

const TENANT = {
  id: "0199c1a2-3b4c-7d5e-8f90-1a2b3c4d5e6f",
  slug: "acme",
  name: "Acme",
  status: "active",
  clerk_org_id: "org_preview",
  created_at: ago(214),
}

const PLANS = [
  {
    id: "free",
    name: "Free",
    rank: 0,
    source: "catalog",
    entitlements: [
      { featureId: "emails", kind: "consumable", allowance: 100, interval: "day" },
      { featureId: "domains.sending", kind: "continuous", allowance: 3 },
      { featureId: "domains.mailbox", kind: "continuous", allowance: 0 },
      { featureId: "mailboxes", kind: "continuous", allowance: 0 },
      { featureId: "storage.bytes", kind: "continuous", allowance: 0 },
    ],
  },
  {
    id: "starter",
    name: "Starter",
    rank: 5,
    source: "catalog",
    entitlements: [
      { featureId: "emails", kind: "consumable", allowance: 5000, interval: "month" },
      { featureId: "domains.sending", kind: "continuous", allowance: 5 },
      { featureId: "domains.mailbox", kind: "continuous", allowance: 0 },
      { featureId: "mailboxes", kind: "continuous", allowance: 0 },
      { featureId: "storage.bytes", kind: "continuous", allowance: 0 },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    rank: 10,
    source: "catalog",
    entitlements: [
      { featureId: "emails", kind: "consumable", allowance: 50000, interval: "month" },
      { featureId: "domains.sending", kind: "continuous", allowance: 10 },
      { featureId: "domains.mailbox", kind: "continuous", allowance: 1 },
      { featureId: "mailboxes", kind: "continuous", allowance: 1 },
      {
        featureId: "storage.bytes",
        kind: "continuous",
        allowance: 10_737_418_240,
      },
    ],
  },
]

/**
 * ⚠ A PAID SUBSCRIPTION WITH A DOWNGRADE ALREADY SCHEDULED, BECAUSE THAT IS THE
 * STATE WITH NOTHING ELSE TO SHOW IT. It used to be `subscription: null`, which
 * renders the one billing state that has no dates, no status pill, no card on
 * file and no deletion consequence - so every line of copy that had to be got
 * right was invisible in preview. The fixtures are deliberately not all healthy;
 * see the note above.
 *
 * `plan` stays Pro on purpose: a `next_period` change is not applied until the
 * boundary, so the plan in force is still the one being left. That is exactly
 * the pair the page has to render without reading as "nothing happened".
 */
const BILLING = {
  plan: PLANS[2],
  subscription: {
    status: "active",
    plan_id: "pro",
    cancel_at_period_end: false,
    current_period_end: new Date(now + 19 * DAY).toISOString(),
    // ⚠ A DOWNGRADE TO A CHEAPER PAID PLAN, NOT TO FREE. Moving to free is a
    // cancellation and shows up as `cancel_at_period_end`; a scheduled change
    // to another product is the state that had nothing at all to render it.
    scheduled_plan_id: "starter",
    scheduled_at: new Date(now + 19 * DAY).toISOString(),
    polar_customer_id: "cus_preview",
  },
  anchor: ago(214),
  overage_enabled: false,
  storage_bytes: null,
}

const DOMAINS = [
  {
    object: "domain" as const,
    id: "1f7a1c00-0000-4000-8000-000000000001",
    name: "acme.com",
    status: "verified",
    created_at: ago(180),
    region: "us-east-1",
    delegated: true,
    // The one healthy domain opted into opens, so the Tracking section shows
    // both states side by side.
    open_tracking: true,
    click_tracking: false,
  },
  {
    object: "domain" as const,
    id: "1f7a1c00-0000-4000-8000-000000000002",
    name: "mail.acme.dev",
    status: "pending",
    created_at: ago(2),
    region: "us-east-1",
    delegated: false,
    open_tracking: false,
    click_tracking: false,
  },
  {
    object: "domain" as const,
    id: "1f7a1c00-0000-4000-8000-000000000003",
    name: "old.acme.net",
    status: "failed",
    created_at: ago(96),
    region: "us-east-1",
    delegated: false,
    open_tracking: false,
    click_tracking: false,
  },
]

const DKIM_KEY =
  "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv7hK2qQ8nJ3mF1xZ" +
  "rT8bN4wPcVdL0aYgHsEuKoM9WjXpB6tR2cFnQzA1yHvI5eSdUklOpQrN8mTgBxCwY7fVaJ3ZLdE4hK" +
  "2nMpQsXvBtRyU6oGcAeIfJ9DlWnHxZmKqTbPoNuVcSgEyRaLdMwFtXi1QIDAQAB"

function recordsFor(domain: (typeof DOMAINS)[number]) {
  if (domain.delegated) {
    return ["send", "_domainkey", "_dmarc"].map((label) => ({
      record: "NS",
      name: `${label}.${domain.name}`,
      type: "NS" as const,
      ttl: "60",
      status: domain.status,
      value: "ns1.i10.tech",
    }))
  }

  return [
    {
      record: "DKIM",
      name: `i10._domainkey.${domain.name}`,
      type: "TXT" as const,
      ttl: "60",
      status: domain.status === "failed" ? "failed" : domain.status,
      value: DKIM_KEY,
    },
    {
      record: "SPF",
      name: `send.${domain.name}`,
      type: "TXT" as const,
      ttl: "60",
      status: domain.status === "failed" ? "failed" : "verified",
      value: "v=spf1 include:amazonses.com ~all",
    },
    {
      record: "SPF",
      name: `send.${domain.name}`,
      type: "MX" as const,
      ttl: "60",
      status: domain.status === "failed" ? "failed" : "verified",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    },
    {
      record: "DMARC",
      name: `_dmarc.${domain.name}`,
      type: "TXT" as const,
      ttl: "60",
      status: domain.status === "failed" ? "pending" : "verified",
      value: "v=DMARC1; p=none; rua=mailto:dmarc@i10.tech",
    },
  ]
}

const SUBJECTS = [
  "Reset your password",
  "Your receipt from Acme",
  "Welcome to Acme",
  "Your invoice is ready",
  "Someone signed in from a new device",
  "Your export has finished",
  "Weekly summary",
  "Confirm your email address",
  "Your subscription renews in 3 days",
  "Action required: card expiring",
]

const RECIPIENTS = [
  "bob@example.com",
  "jane.smith@contoso.com",
  "dev+staging@northwind.io",
  "hello@globex.co.uk",
  "accounts@initech.com",
  "m.rivera@umbrella.dev",
  "no-such-person@example.com",
  "team@hooli.com",
]

const EVENTS = [
  "delivered",
  "delivered",
  "delivered",
  "delivered",
  "delivered",
  "sent",
  "bounced",
  "delivery_delayed",
  "complained",
  "failed",
  "queued",
  "scheduled",
]

const EMAILS = Array.from({ length: 50 }, (_, i) => {
  const lastEvent = EVENTS[i % EVENTS.length]!
  return {
    id: `0199c${(i + 16).toString(16).padStart(3, "0")}-0000-7000-8000-00000000${(i + 16).toString(16).padStart(4, "0")}`,
    created_at: ago(Math.floor(i / 6), (i % 6) * 3),
    from: i % 3 === 0 ? "Acme <hello@acme.com>" : "noreply@acme.com",
    to: [RECIPIENTS[i % RECIPIENTS.length]!],
    subject: SUBJECTS[i % SUBJECTS.length]!,
    status: lastEvent === "queued" || lastEvent === "scheduled" ? "queued" : "sent",
    last_event: lastEvent,
    scheduled_at: lastEvent === "scheduled" ? ago(-1) : null,
    sent_at: lastEvent === "queued" || lastEvent === "scheduled" ? null : ago(0, i),
    last_error:
      lastEvent === "bounced"
        ? "550 5.1.1 The email account that you tried to reach does not exist."
        : lastEvent === "failed"
          ? "421 4.7.0 Try again later, closing connection."
          : null,
  }
})

const SERIES = Array.from({ length: 30 }, (_, i) => {
  const days = 29 - i
  // A weekday shape, with a quiet weekend - a flat line looks synthetic.
  const weekday = new Date(now - days * DAY).getUTCDay()
  const base = weekday === 0 || weekday === 6 ? 140 : 620
  const wobble = ((i * 37) % 23) * 11
  const sent = base + wobble
  const bounced = (i * 13) % 9
  const complained = i % 11 === 0 ? 1 : 0
  const delayed = (i * 7) % 5
  const failed = i % 9 === 0 ? 2 : 0
  return {
    date: dayKey(days),
    sent,
    delivered: sent - bounced - failed,
    bounced,
    complained,
    delayed,
    failed,
  }
})

const TOTALS = SERIES.reduce(
  (acc, d) => ({
    sent: acc.sent + d.sent,
    delivered: acc.delivered + d.delivered,
    bounced: acc.bounced + d.bounced,
    complained: acc.complained + d.complained,
    delayed: acc.delayed + d.delayed,
    failed: acc.failed + d.failed,
  }),
  { sent: 0, delivered: 0, bounced: 0, complained: 0, delayed: 0, failed: 0 },
)

const SEGMENTS = [
  {
    id: "2f7a1c00-0000-4000-8000-000000000001",
    name: "Paying customers",
    description: "Anyone on a paid plan.",
    contact_count: 1284,
    created_at: ago(120),
  },
  {
    id: "2f7a1c00-0000-4000-8000-000000000002",
    name: "Beta testers",
    description: null,
    contact_count: 63,
    created_at: ago(40),
  },
  {
    id: "2f7a1c00-0000-4000-8000-000000000003",
    name: "Churned",
    description: "Cancelled in the last 90 days.",
    contact_count: 0,
    created_at: ago(9),
  },
]

const CONTACTS = Array.from({ length: 24 }, (_, i) => ({
  id: `3f7a1c00-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
  email: RECIPIENTS[i % RECIPIENTS.length]!.replace("@", `+${i}@`),
  first_name: ["Bob", "Jane", "Alex", "Sam", "Mo", "Priya"][i % 6]!,
  last_name: ["Smith", "Chen", "Okafor", "Rivera", "Patel", null][i % 6] ?? null,
  unsubscribed: i % 7 === 0,
  properties: i % 3 === 0 ? { plan: "pro", seats: "4" } : null,
  created_at: ago(i * 3),
}))

/**
 * The list filters the API applies, applied to the fixtures, so every toolbar
 * can be tried in preview. Kept as loose as the API: a substring for `search`,
 * equality for the rest, `from` as a lower bound on the row's time.
 */
function q(query: Query, name: string): string | undefined {
  const v = query?.[name]
  return v === undefined || v === null || v === "" ? undefined : String(v)
}
const has = (needle: string | undefined, ...values: (string | null | undefined)[]) =>
  !needle || values.some((v) => v?.toLowerCase().includes(needle.toLowerCase()))
const since = (from: string | undefined, at: string) => !from || at >= from

/**
 * ⚠ THE ROUTE TABLE IS MATCHED IN ORDER AND LONGEST-FIRST, so `/console/emails/x`
 * cannot be swallowed by `/console/emails`. It mirrors the API's own paths
 * exactly - if a path here drifts from the real one, preview mode would keep
 * working while the real console broke, which is the one thing a fixture layer
 * must never do.
 */
type Query = Record<string, string | number | undefined | null> | undefined

/**
 * "This id does not exist here" - the one answer a fixture layer has to be able
 * to give.
 *
 * ⚠ WITHOUT IT, EVERY DETAIL ROUTE INVENTED A ROW FOR AN ID IT HAD NEVER SEEN.
 * `/emails/not-a-uuid` fell back to the first message and rendered a perfectly
 * convincing page, which is the exact failure this file's route table is
 * supposed to prevent: preview mode working while the real console does
 * something else. It also made `not-found.tsx` unreachable, so the 404 nobody
 * looks at until it matters could never be reviewed.
 *
 * ⚠ A SYMBOL RATHER THAN `undefined`, BECAUSE `undefined` ALREADY MEANS
 * SOMETHING ELSE HERE - "no fixture is defined for this path at all", which
 * `api()` reports as a 501 telling whoever is building the screen to add one.
 * Confusing a missing ROW with a missing FIXTURE would turn a reviewable 404
 * into a "go and edit preview.ts" message.
 */
export const PREVIEW_NOT_FOUND = Symbol("preview:not-found")

/**
 * "This needs a real payment provider, which preview mode does not have."
 *
 * ⚠ SEPARATE FROM `PREVIEW_NOT_FOUND` BECAUSE IT IS A 503, NOT A 404. Nothing is
 * missing - the operation genuinely cannot be performed here, and the message
 * has to say so rather than implying the plan or the customer does not exist.
 */
export const PREVIEW_UNAVAILABLE = Symbol("preview:unavailable")

// ── Templates (#236) ────────────────────────────────────────────────────────

/*
 * ⚠ ONE OF EACH SOURCE, AND NOT ALL OF THEM TIDY. An editor template with a
 * newer version than live (somebody rolled back), an upload made of several
 * files with a subject from its file, a GitHub template versioned by commits,
 * and an editor template that has never been published.
 */
type FixtureVersion = {
  number: number
  subject: string
  html: string | null
  text: string | null
  variables: { path: string; preview: string }[]
  path?: string
  commit_sha?: string
  source?: string
  files?: Record<string, string>
  days: number
}

const LAYOUT_TSX = `import { Body, Container, Html, Text } from "react-email"
import type { ReactNode } from "react"

export function Layout({ children }: { children: ReactNode }) {
  return (
    <Html>
      <Body style={{ fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Container>
          {children}
          <Text style={{ color: "#888", fontSize: 12 }}>Acme Inc.</Text>
        </Container>
      </Body>
    </Html>
  )
}
`

const welcomeTsx = (
  heading: string,
) => `import { Button, Heading, Text } from "react-email"
import { Layout } from "../components/layout"

export const subject = "Welcome to Acme, {{ name }}"

export default function Welcome({ name, url }: { name: string; url: string }) {
  return (
    <Layout>
      <Heading>${heading}</Heading>
      <Text>Hi {name}, your workspace is ready.</Text>
      <Button href={url}>Open Acme</Button>
    </Layout>
  )
}

Welcome.PreviewProps = { name: "Ada", url: "https://acme.test/start" }
`

const page = (inner: string) =>
  `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;background:#f6f6f6;padding:24px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">${inner}<p style="color:#888;font-size:12px">Acme Inc.</p></div></body></html>`

const ONBOARDING_DESIGN = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Welcome to Acme, {{ name }}" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Your workspace is ready. Here is what to do first: " },
        {
          type: "text",
          marks: [{ type: "link", attrs: { href: "{{ url }}" } }],
          text: "open your dashboard",
        },
        { type: "text", text: "." },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Reply to this email if anything is unclear." }],
    },
  ],
}

const TEMPLATES: {
  id: string
  name: string
  folder: string | null
  kind: "html" | "tsx" | "visual"
  design?: Record<string, unknown>
  github?: { repository: string; directory: string; path: string; removed: boolean }
  source: "managed" | "upload" | "github"
  subject: string | null
  html: string | null
  text: string | null
  live: number
  created_days: number
  updated_days: number
  versions: FixtureVersion[]
}[] = [
  {
    id: "bf7a1c00-0000-4000-8000-000000000001",
    name: "password-reset",
    folder: "transactional/auth",
    kind: "html",
    source: "managed",
    subject: "Reset your password",
    html: '<p>Hello {{first_name}},</p>\n<p><a href="{{reset_url}}">Reset your password</a></p>\n<p>This link expires in an hour.</p>',
    text: "Hello {{first_name}},\n\nReset your password: {{reset_url}}\n\nThis link expires in an hour.",
    live: 3,
    created_days: 170,
    updated_days: 3,
    versions: [1, 2, 3, 4].map((n) => ({
      number: n,
      subject: n < 3 ? "Password reset" : "Reset your password",
      html: page(
        `<p>Hello {{ first_name }},</p><p><a href="{{ reset_url }}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Reset your password</a></p>${n >= 2 ? "<p>This link expires in an hour.</p>" : ""}${n === 4 ? '<img src="https://acme.test/pixel.png" width="1" height="1">' : ""}`,
      ),
      text: `Hello {{ first_name }},\n\nReset your password: {{ reset_url }}${n >= 2 ? "\n\nThis link expires in an hour." : ""}`,
      variables: [
        { path: "first_name", preview: "" },
        { path: "reset_url", preview: "" },
      ],
      days: 170 - n * 40,
    })),
  },
  {
    id: "bf7a1c00-0000-4000-8000-000000000002",
    name: "welcome",
    folder: "auth",
    kind: "tsx",
    source: "upload",
    subject: "Welcome to Acme, {{ name }}",
    html: null,
    text: null,
    live: 3,
    created_days: 60,
    updated_days: 2,
    versions: [1, 2, 3].map((n) => ({
      number: n,
      subject: "Welcome to Acme, {{ name }}",
      html: page(
        `<h1>${n === 1 ? "Welcome" : "Welcome aboard"}</h1><p>Hi {{ name }}, your workspace is ready.</p><p><a href="{{ url }}" style="background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open Acme</a></p>`,
      ),
      text: `${n === 1 ? "WELCOME" : "WELCOME ABOARD"}\n\nHi {{ name }}, your workspace is ready.\n\nOpen Acme [{{ url }}]`,
      variables: [
        { path: "name", preview: "Ada" },
        { path: "url", preview: "https://acme.test/start" },
      ],
      path: "auth/welcome.tsx",
      source: welcomeTsx(n === 1 ? "Welcome" : "Welcome aboard"),
      files: {
        "components/layout.tsx":
          n < 3
            ? LAYOUT_TSX
            : LAYOUT_TSX.replace("Acme Inc.", "Acme Inc. · Unsubscribe any time"),
      },
      days: 60 - n * 20,
    })),
  },
  {
    id: "bf7a1c00-0000-4000-8000-000000000003",
    name: "receipt",
    folder: "billing",
    kind: "tsx",
    source: "github",
    github: {
      repository: "acme/emails",
      directory: "emails",
      path: "billing/receipt.tsx",
      removed: false,
    },
    subject: "Your receipt from Acme",
    html: null,
    text: null,
    live: 2,
    created_days: 40,
    updated_days: 1,
    versions: [1, 2].map((n) => ({
      number: n,
      subject: "Your receipt from Acme",
      html: page(
        `<h2>Thanks for your order</h2><p>Order {{ order.id }}: {{ order.total }}</p>${n === 2 ? "<p>Questions? Reply to this email.</p>" : ""}`,
      ),
      text: `Thanks for your order\n\nOrder {{ order.id }}: {{ order.total }}${n === 2 ? "\n\nQuestions? Reply to this email." : ""}`,
      variables: [
        { path: "order.id", preview: "A-1042" },
        { path: "order.total", preview: "$42.00" },
      ],
      path: "billing/receipt.tsx",
      commit_sha:
        n === 1
          ? "4f1c2a9e0b7d3c55a6e1f00d9b2c8e7a61d3b4c2"
          : "a91e03b7c4d2f68e15a0b9c3d7e2f41806c5b9d1",
      source: `import { Heading, Text } from "react-email"

export default function Receipt({ order }: { order: { id: string; total: string } }) {
  return (
    <>
      <Heading as="h2">Thanks for your order</Heading>
      <Text>Order {order.id}: {order.total}</Text>${n === 2 ? "\n      <Text>Questions? Reply to this email.</Text>" : ""}
    </>
  )
}

Receipt.PreviewProps = { order: { id: "A-1042", total: "$42.00" } }
`,
      days: 40 - n * 15,
    })),
  },
  {
    id: "bf7a1c00-0000-4000-8000-000000000005",
    name: "onboarding",
    folder: "lifecycle",
    kind: "visual",
    source: "managed",
    design: ONBOARDING_DESIGN,
    subject: "Welcome to Acme, {{ name }}",
    html: null,
    text: null,
    live: 2,
    created_days: 20,
    updated_days: 1,
    versions: [1, 2].map((n) => ({
      number: n,
      subject: "Welcome to Acme, {{ name }}",
      html: page(
        `<h1>Welcome to Acme, {{ name }}</h1><p>Your workspace is ready. Here is what to do first: <a href="{{ url }}">open your dashboard</a>.</p>${n === 2 ? "<p>Reply to this email if anything is unclear.</p>" : ""}`,
      ),
      text: `Welcome to Acme, {{ name }}\n\nYour workspace is ready. Here is what to do first: open your dashboard ({{ url }}).${n === 2 ? "\n\nReply to this email if anything is unclear." : ""}`,
      variables: [
        { path: "name", preview: "" },
        { path: "url", preview: "" },
      ],
      days: 20 - n * 9,
    })),
  },
  {
    id: "bf7a1c00-0000-4000-8000-000000000004",
    name: "weekly-digest",
    folder: null,
    kind: "html",
    source: "managed",
    subject: "Your week at Acme",
    html: "<p>Draft</p>",
    text: null,
    live: 0,
    created_days: 5,
    updated_days: 5,
    versions: [],
  },
  {
    // What New -> Template opens on in preview mode: nothing written yet.
    id: "bf7a1c00-0000-4000-8000-00000000000a",
    name: "untitled-template",
    folder: "drafts",
    kind: "visual",
    source: "managed",
    subject: null,
    html: null,
    text: null,
    live: 0,
    created_days: 0,
    updated_days: 0,
    versions: [],
  },
]

/** The fixture folders: one per distinct folder label above, plus an empty one. */
const TEMPLATE_FOLDERS = [
  ...new Set(TEMPLATES.map((t) => t.folder).filter((f): f is string => f !== null)),
  "drafts",
].map((name, i) => ({
  id: `f01de700-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  name,
  templates: TEMPLATES.filter((t) => t.folder === name).length,
  created_at: ago(30 - i),
  updated_at: ago(30 - i),
}))

const folderIdOf = (name: string | null) =>
  TEMPLATE_FOLDERS.find((f) => f.name === name)?.id ?? null

function summary(full: (typeof TEMPLATES)[number]) {
  const live = full.versions.find((v) => v.number === full.live)
  return {
    id: full.id,
    name: full.name,
    title: full.name
      .split("-")
      .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(" "),
    folder_id: folderIdOf(full.folder),
    from: full.source === "managed" ? "Acme <hello@acme.com>" : null,
    reply_to: null,
    preview_text: null,
    variables: [],
    kind: full.kind,
    source: full.source,
    subject: full.subject,
    html: null,
    text: null,
    published_at: live ? ago(live.days) : null,
    version: full.live,
    versions: full.versions.length,
    github: full.github ?? null,
    created_at: ago(full.created_days),
    updated_at: ago(full.updated_days),
  }
}

function versionSummary(t: (typeof TEMPLATES)[number], v: FixtureVersion) {
  return {
    id: `${t.id.slice(0, -2)}${String(v.number).padStart(2, "0")}`,
    number: v.number,
    kind: t.kind,
    subject: v.subject,
    variables: v.variables,
    runtime:
      t.kind === "tsx" ? "react@19.2.8+react-dom@19.2.8+react-email@6.9.3" : null,
    path: v.path ?? null,
    commit_sha: v.commit_sha ?? null,
    from: null,
    reply_to: null,
    preview_text: null,
    live: v.number === t.live,
    created_at: ago(v.days),
  }
}

function templateDetailFixture(id: string) {
  const t = TEMPLATES.find((x) => x.id === id)
  if (!t) return null
  return {
    ...summary(t),
    html: t.html,
    text: t.text,
    design: t.design ?? null,
    history: [...t.versions].reverse().map((v) => versionSummary(t, v)),
  }
}

/** A version's detail - or, for the preview route, the same filled. */
function templateVersionFixture(id: string, number: number) {
  const t = TEMPLATES.find((x) => x.id === id)
  const v = t?.versions.find((x) => x.number === number)
  if (!t || !v) return null
  return {
    ...versionSummary(t, v),
    source: v.source ?? null,
    files: v.files ?? null,
    design: t.kind === "visual" ? (t.design ?? null) : null,
    display: { html: v.html, text: v.text },
    // Filled with samples (or the name itself), for the preview route.
    html: fillFixture(v.html, v.variables),
    text: fillFixture(v.text, v.variables),
  }
}

function fillFixture(
  text: string | null,
  variables: { path: string; preview: string }[],
): string | null {
  if (text === null) return null
  return text.replace(
    /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g,
    (_, a?: string, b?: string) => {
      const path = (a ?? b)!
      const v = variables.find((x) => x.path === path)
      return (v?.preview || path).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    },
  )
}

const GITHUB_STATE = {
  configured: true,
  app_slug: "i10",
  installations: [
    {
      installation_id: 50123,
      account_login: "acme",
      account_type: "Organization",
      suspended: false,
      created_at: ago(40),
    },
  ],
  repositories: [
    {
      id: "c0a1c000-0000-4000-8000-000000000001",
      installation_id: 50123,
      repo_id: 1,
      full_name: "acme/emails",
      target_branch: "main",
      directory: "emails",
      last_commit_sha: "a91e03b7c4d2f68e15a0b9c3d7e2f41806c5b9d1",
      last_synced_at: ago(0, 3),
      removed: false,
      templates: 1,
      last_sync: {
        id: "c0a1c000-0000-4000-8000-0000000000a1",
        commit_sha: "a91e03b7c4d2f68e15a0b9c3d7e2f41806c5b9d1",
        status: "done",
        outcomes: [
          {
            path: "billing/receipt.tsx",
            name: "receipt",
            folder: "billing",
            template_id: "bf7a1c00-0000-4000-8000-000000000003",
            outcome: "versioned",
            version: 2,
          },
        ],
        problems: [],
        created_at: ago(0, 3),
        finished_at: ago(0, 3),
      },
      created_at: ago(40),
    },
    {
      id: "c0a1c000-0000-4000-8000-000000000002",
      installation_id: 50123,
      repo_id: 3,
      full_name: "acme/transactional",
      target_branch: "trunk",
      directory: "src/emails",
      last_commit_sha: "77c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192",
      last_synced_at: ago(1),
      removed: false,
      templates: 0,
      last_sync: {
        id: "c0a1c000-0000-4000-8000-0000000000a2",
        commit_sha: "77c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192",
        status: "done",
        outcomes: [
          {
            path: "promo.tsx",
            name: "promo",
            folder: null,
            template_id: null,
            outcome: "refused",
            problems: [
              "A variable is used as a condition or measured. A template is rendered once, so every variable must always be inserted the same way.",
            ],
          },
        ],
        problems: [],
        created_at: ago(1),
        finished_at: ago(1),
      },
      created_at: ago(2),
    },
  ],
}

const TEMPLATE_UPLOAD = [
  {
    path: "auth/welcome.tsx",
    name: "welcome",
    folder: "auth",
    template_id: "bf7a1c00-0000-4000-8000-000000000002",
    outcome: "versioned",
    version: 4,
  },
  {
    path: "auth/magic-link.tsx",
    name: "magic-link",
    folder: "auth",
    template_id: "bf7a1c00-0000-4000-8000-000000000009",
    outcome: "created",
    version: 1,
  },
  {
    path: "billing/invoice.tsx",
    name: "invoice",
    folder: "billing",
    template_id: "bf7a1c00-0000-4000-8000-000000000008",
    outcome: "unchanged",
    version: 2,
  },
  {
    path: "marketing/promo.tsx",
    name: "promo",
    folder: "marketing",
    template_id: null,
    outcome: "refused",
    problems: [
      'A variable is used as a condition or measured - `{name && …}`, `{name || "there"}`, `.length` or similar. A template is rendered once, so every variable must always be inserted the same way. Near: `<p>Hi there, here is`',
    ],
  },
]

const ROUTES: [
  RegExp,
  (match: RegExpMatchArray, query: Query, method: string) => unknown,
][] = [
  /*
   * ⚠ BILLING IS THE ONE PLACE A PREVIEW MUST NOT PRETEND TO SUCCEED. Every
   * other mutation here is a no-op that reports success, because the point of
   * the mode is reviewing the interface and a dialog that refused to close
   * would make half the screens unreviewable. Taking money is different: a
   * fixture that answered with a plausible-looking checkout url would send
   * whoever is reviewing to a real Polar page or to a 404, and a fixture that
   * answered nothing at all is what crashed the upgrade button. Refusing
   * explicitly, with a message that says why, is the honest option - and it
   * exercises the button's real error path, which is worth being able to see.
   */
  [/^\/console\/billing\/checkout$/, () => PREVIEW_UNAVAILABLE],
  [/^\/console\/billing\/payment-method-session$/, () => PREVIEW_UNAVAILABLE],
  [
    /^\/console\/me$/,
    () => ({
      user: {
        id: "user_preview",
        email: "you@acme.dev",
        verified_emails: ["you@acme.dev"],
      },
      tenant: TENANT,
      billing: BILLING,
      onboarding: {
        step: "plan",
        completed_at: ago(180),
        last_onboarded_plan: "free",
        use_case: "Transactional email",
        should_onboard: false,
        facts: { has_domain: true, has_verified_domain: true, has_api_key: true },
      },
    }),
  ],

  [
    /^\/console\/overview$/,
    () => ({
      series: SERIES,
      totals: TOTALS,
      counts: {
        domains: DOMAINS.length,
        verifiedDomains: 1,
        apiKeys: 2,
        webhookEndpoints: 1,
        suppressions: 37,
      },
    }),
  ],

  [
    /^\/console\/emails\/([^/]+)$/,
    (m) => {
      const email = EMAILS.find((e) => e.id === m[1])
      // ⚠ NOT A FALLBACK TO THE FIRST ROW - see `PREVIEW_NOT_FOUND`.
      if (!email) return PREVIEW_NOT_FOUND
      return {
        ...email,
        cc: [],
        bcc: [],
        reply_to: ["support@acme.com"],
        html: `<!doctype html><html><body style="font-family:system-ui;padding:24px;color:#111">
  <h1 style="font-size:18px;margin:0 0 12px">${email.subject}</h1>
  <p style="margin:0 0 12px">Hello,</p>
  <p style="margin:0 0 12px">This is a preview of a real message body. Rendered in a
  sandboxed iframe with no scripts, no network and an opaque origin.</p>
  <p style="margin:0"><a href="https://example.com" style="color:#111">Open Acme</a></p>
</body></html>`,
        text: `${email.subject}\n\nHello,\n\nThis is a preview of a real message body.`,
        headers: {
          "X-Entity-Ref-ID": "preview",
          "List-Unsubscribe": "<https://acme.com/u>",
        },
        attachments:
          email.subject.includes("receipt") || email.subject.includes("invoice")
            ? [
                {
                  filename: "invoice.pdf",
                  content_type: "application/pdf",
                  size: 48_210,
                },
              ]
            : null,
        tags: { environment: "production", template: "transactional" },
        events: [
          { type: "sent", occurred_at: email.created_at, payload: null },
          ...(email.last_event === "delivered"
            ? [
                {
                  type: "delivered",
                  occurred_at: ago(0, 1),
                  payload: {
                    smtpResponse: "250 2.0.0 OK",
                    reportingMTA: "a8-32.smtp-out.amazonses.com",
                  },
                },
              ]
            : []),
          ...(email.last_event === "bounced"
            ? [
                {
                  type: "bounced",
                  occurred_at: ago(0, 1),
                  payload: {
                    bounceType: "Permanent",
                    bounceSubType: "NoEmail",
                    diagnosticCode: "smtp; 550 5.1.1 user unknown",
                  },
                },
              ]
            : []),
          ...(email.last_event === "complained"
            ? [
                {
                  type: "complained",
                  occurred_at: ago(0, 2),
                  payload: { complaintFeedbackType: "abuse" },
                },
              ]
            : []),
        ],
        domain_id: DOMAINS[0]!.id,
        api_key_id: "4f7a1c00-0000-4000-8000-000000000001",
        broadcast_id: null,
        provider_message_id: "0100018f-preview-0000-0000-000000000000",
        attempts: email.last_event === "failed" ? 3 : 1,
      }
    },
  ],

  [
    /^\/console\/emails$/,
    (_m, query) => {
      const statuses = q(query, "status")?.split(",")
      return {
        data: EMAILS.filter(
          (e) =>
            has(q(query, "search"), e.subject, e.from, ...e.to) &&
            (!statuses || statuses.includes(e.last_event)) &&
            since(q(query, "from"), e.created_at) &&
            // Every fixture email went out with the first key.
            (!q(query, "api_key_id") ||
              q(query, "api_key_id") === "4f7a1c00-0000-4000-8000-000000000001"),
        ),
        nextCursor: null,
      }
    },
  ],

  /*
   * ⚠ ABOVE `/domains/:id`, THE SAME ORDER THE API USES, or `check` is read as
   * an id. `i10.tech` is ours and every fixture domain is already added, which
   * reaches both inline refusals the add forms can show.
   */
  [
    /^\/console\/domains\/check$/,
    (_m, query) => {
      const name = String(query?.name ?? "")
        .trim()
        .toLowerCase()
      const held = DOMAINS.find((d) => d.name === name)
      const refusal =
        name === "i10.tech" || name.endsWith(".i10.tech")
          ? `${name} is ours - we are flattered, genuinely, but we are already using it. Add the domain your own mail comes from.`
          : held
            ? `You have already added ${name}, and it ${held.status === "verified" ? "is verified" : held.status === "failed" ? "failed verification - open it to fix the records" : "is waiting for verification"}.`
            : null
      return { name, refusal }
    },
  ],

  [
    /^\/console\/domains\/([^/]+)$/,
    (m, _q, method) => {
      const domain = DOMAINS.find((d) => d.id === m[1])
      // ⚠ NOT A FALLBACK TO THE FIRST ROW - see `PREVIEW_NOT_FOUND`.
      if (!domain) return PREVIEW_NOT_FOUND
      // A tracking PATCH answers with the domain as it was: the switch keeps its
      // own optimistic state, and preview has no store to write to.
      if (method === "PATCH") return { ...domain, records: recordsFor(domain) }
      /*
       * ⚠ THE BADGE STAYS `pending` HERE EVEN AFTER THE WATCH BELOW REPORTS
       * VERIFIED, AND THAT IS A LIMIT OF THE MODE RATHER THAN A BUG IN IT. A
       * server action and a server render are separate module instances under
       * `next dev`, so the counter the refresh route keeps is not the one this
       * render would read - sharing it would need a store, which is the thing
       * preview mode exists to avoid. In production the refresh writes the row
       * and the re-render reads it back, so the badge does turn over.
       */
      return {
        ...domain,
        records: recordsFor(domain),
        // The events strip's times: verified a few minutes after it was added.
        verified_at:
          domain.status === "verified"
            ? new Date(new Date(domain.created_at).getTime() + 7 * 60_000).toISOString()
            : null,
        dns_checked_at: ago(0, 0.05),
      }
    },
  ],

  /*
   * ⚠ VERIFY AND REFRESH HAD NO FIXTURE AT ALL, AND AN ABSENT FIXTURE IS NOT
   * AN INERT ONE. `previewFor` returns `undefined` for a path it does not
   * know, `api()` hands that back as the payload, and the caller reads
   * `.status` off it - so pressing Verify in preview threw
   * "Cannot read properties of undefined" into the console rather than doing
   * nothing. It went unnoticed while Verify was a button somebody had to press
   * on purpose; the moment the page started checking by itself it threw seven
   * times a minute on a screen nobody had touched.
   */
  [
    /^\/console\/domains\/([^/]+)\/verify$/,
    (m) => {
      const domain = DOMAINS.find((d) => d.id === m[1])
      if (!domain) return PREVIEW_NOT_FOUND
      return {
        ...domain,
        records: recordsFor(domain),
        // Preview does no DNS, and the proof is the half this mode can state
        // honestly: the records exist in the fixture, so they were found.
        ownership: { proven: true },
      }
    },
  ],

  /*
   * ⚠ IT VERIFIES ON THE THIRD ASK, WHICH IS THE ONLY WAY THE WATCH IS
   * REVIEWABLE AT ALL. A fixture that answers `pending` for ever shows the
   * spinner and never the thing worth looking at - the moment the page
   * notices, stops watching and re-renders itself green. A counter in a
   * dev-only module is the cheapest honest way to have a second state.
   */
  [
    /^\/console\/domains\/([^/]+)\/refresh$/,
    (m) => {
      const domain = DOMAINS.find((d) => d.id === m[1])
      if (!domain) return PREVIEW_NOT_FOUND
      if (domain.status === "verified" || domain.status === "failed") {
        return { ...domain, records: recordsFor(domain) }
      }

      const seen = (refreshes.get(domain.id) ?? 0) + 1
      refreshes.set(domain.id, seen)
      return {
        ...domain,
        status: seen >= 3 ? "verified" : domain.status,
        records: recordsFor(domain),
      }
    },
  ],

  /*
   * ⚠ ONE PATH, TWO ANSWERS, WHICH IS WHY THE METHOD REACHES THIS FILE AT ALL.
   * A mutation in preview is still a no-op that reports success - nothing
   * persists - but "success" for a POST here is a DOMAIN, and returning the
   * LIST envelope made the caller read `records` off an object that has none.
   * The onboarding flow crashed at the step after the one being reviewed, which
   * is the failure this mode exists to prevent rather than cause.
   */
  [
    /^\/console\/domains$/,
    (_m, _q, method) =>
      method === "POST"
        ? {
            ...DOMAINS[0]!,
            id: "prv_new",
            name: "acme.com",
            status: "pending",
            records: recordsFor(DOMAINS[0]!),
          }
        : { data: DOMAINS },
  ],

  /*
   * ⚠ THE LOOKUP FIXTURE VARIES BY DOMAIN, WHICH IS THE ONLY WAY THE FEATURE IS
   * REVIEWABLE. A fixture that always answered "Cloudflare" would show one of
   * the five states this screen has - and the interesting ones are the provider
   * we can connect, the provider we cannot, the one whose editor has no NS row,
   * the split nameserver set, and the domain nobody recognises. Typing any of
   * the names below in preview mode reaches each of them.
   */
  [
    /^\/console\/dns\/lookup/,
    (_m, query) => {
      const domain = String(query?.domain ?? "acme.com")
      const answer = dnsFixtureFor(domain)
      return { domain, ...answer, records: { txt: [], mx: [], dmarc: [] } }
    },
  ],

  /*
   * ⚠ ALWAYS FRESH IN PREVIEW, BECAUSE THERE IS NO CLERK TO ASK. The step-up
   * prompt is Clerk's own dialog and preview mode has no session at all - so
   * the honest fixture is "already proved", which lets the delete dialogs it
   * guards stay reviewable. The refusal it exists for is enforced on the API
   * and cannot be reviewed here either way.
   */
  [/^\/console\/step-up$/, () => null],

  [
    /^\/console\/api-keys$/,
    () => ({
      data: [
        {
          id: "4f7a1c00-0000-4000-8000-000000000001",
          name: "production-api",
          prefix: "i10_live_8fK2",
          mode: "live",
          scopes: [],
          // ⚠ ONE UNRESTRICTED AND ONE SCOPED, so the "Sends from" column has
          // both of its answers on screen and the domain-delete dialog has
          // something to offer. A fixture where every row is the same is a
          // fixture that cannot show a difference.
          domains: [],
          created_at: ago(150),
          last_used_at: ago(0, 1),
          expires_at: null,
          revoked_at: null,
        },
        {
          id: "4f7a1c00-0000-4000-8000-000000000002",
          name: "staging",
          prefix: "i10_test_Qm9x",
          mode: "test",
          scopes: ["domain:mail.acme.dev"],
          domains: ["mail.acme.dev"],
          created_at: ago(88),
          last_used_at: ago(46),
          expires_at: null,
          revoked_at: null,
        },
        {
          id: "4f7a1c00-0000-4000-8000-000000000003",
          name: "old-laptop",
          prefix: "i10_live_Zz1p",
          mode: "live",
          scopes: [],
          domains: [],
          created_at: ago(300),
          last_used_at: ago(250),
          expires_at: null,
          revoked_at: ago(120),
        },
      ],
    }),
  ],

  [
    /^\/console\/webhook-endpoints$/,
    () => ({
      data: [
        {
          object: "webhook_endpoint" as const,
          id: "5f7a1c00-0000-4000-8000-000000000001",
          url: "https://api.acme.com/webhooks/i10",
          events: ["email.delivered", "email.bounced", "email.complained"],
          description: "Production handler",
          enabled: true,
          created_at: ago(140),
        },
      ],
    }),
  ],

  [
    /^\/console\/webhook-deliveries$/,
    (_m, query) => ({
      data: Array.from({ length: 16 }, (_, i) => ({
        id: `6f7a1c00-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
        endpoint_id: "5f7a1c00-0000-4000-8000-000000000001",
        endpoint_url: "https://api.acme.com/webhooks/i10",
        event_type: ["email.delivered", "email.bounced", "email.complained"][i % 3]!,
        status: i % 6 === 0 ? "failed" : "delivered",
        attempts: i % 6 === 0 ? 8 : 1,
        response_status: i % 6 === 0 ? 500 : 200,
        last_error: i % 6 === 0 ? "500 Internal Server Error" : null,
        occurred_at: ago(0, i),
        delivered_at: i % 6 === 0 ? null : ago(0, i),
        created_at: ago(0, i),
      })).filter(
        (d) =>
          (!q(query, "status") || d.status === q(query, "status")) &&
          (!q(query, "event_type") || d.event_type === q(query, "event_type")) &&
          (!q(query, "endpoint_id") || d.endpoint_id === q(query, "endpoint_id")),
      ),
      nextCursor: null,
    }),
  ],

  [
    // ⚠ AT RISK IN PREVIEW, so the amber banner, the rail pill and the
    // overview's findings can be reviewed; production reads SES.
    /^\/console\/sending-status$/,
    () => previewSendingStatus(),
  ],

  [
    // One domain pending and an offer waiting, so the rail's mark shows.
    /^\/console\/attention$/,
    () => ({
      domains: {
        total: 3,
        unverified: 1,
        proof_missing: 0,
        transfers: 1,
        reputation: previewSendingStatus().health,
      },
    }),
  ],

  [
    /^\/console\/sending-health$/,
    () => ({
      ...previewSendingStatus(),
      window_days: 7,
      sends: 4120,
      hard_bounces: 181,
      soft_bounces: 64,
      complaints: 2,
      bounce_rate: 181 / 4120,
      soft_bounce_rate: 64 / 4120,
      complaint_rate: 2 / 4120,
    }),
  ],

  [
    /^\/console\/suppressions$/,
    (_m, query) => ({
      data: Array.from({ length: 12 }, (_, i) => ({
        address: `bounced+${i}@example.com`,
        reason: ["hard_bounce", "hard_bounce", "complaint", "manual"][i % 4]!,
        message_id: i % 3 === 0 ? EMAILS[0]!.id : null,
        created_at: ago(i * 4),
      })).filter(
        (r) =>
          has(q(query, "search"), r.address) &&
          (!q(query, "reason") || r.reason === q(query, "reason")),
      ),
      nextCursor: null,
    }),
  ],

  [
    /^\/console\/requests$/,
    (_m, query) => ({
      data: Array.from({ length: 30 }, (_, i) => ({
        id: `7f7a1c00-0000-4000-8000-${(i + 1).toString().padStart(12, "0")}`,
        method: ["POST", "GET", "POST", "DELETE"][i % 4]!,
        path: ["/emails", "/emails/{id}", "/emails/batch", "/domains/{id}"][i % 4]!,
        status: i % 11 === 0 ? 422 : i % 17 === 0 ? 500 : 200,
        duration_ms: 40 + ((i * 29) % 380),
        error_name: i % 11 === 0 ? "validation_error" : null,
        user_agent: i % 2 === 0 ? "i10-node/1.4.0" : "curl/8.4.0",
        api_key_id: "4f7a1c00-0000-4000-8000-000000000001",
        occurred_at: ago(0, i),
      })).filter(
        (r) =>
          has(q(query, "search"), r.path) &&
          (!q(query, "method") || r.method === q(query, "method")) &&
          (!q(query, "status") ||
            (q(query, "status") === "error") === r.status >= 400) &&
          (!q(query, "api_key_id") || r.api_key_id === q(query, "api_key_id")) &&
          since(q(query, "from"), r.occurred_at),
      ),
      nextCursor: null,
    }),
  ],

  [
    /^\/console\/usage$/,
    () => ({
      usage: [
        {
          feature_id: "emails",
          label: "Emails",
          unit: "",
          used: 118,
          allowance: 100,
          remaining: 0,
          resets_at: ago(-1),
          overage: false,
          status: "ok" as const,
        },
        {
          feature_id: "domains.sending",
          label: "Sending domains",
          unit: "",
          used: 3,
          allowance: 3,
          remaining: 0,
          resets_at: null,
          overage: false,
          status: "ok" as const,
        },
        {
          feature_id: "domains.mailbox",
          label: "Mailbox domains",
          unit: "",
          used: 0,
          allowance: 0,
          remaining: 0,
          resets_at: null,
          overage: false,
          status: "ok" as const,
        },
        {
          feature_id: "mailboxes",
          label: "Mailboxes",
          unit: "",
          used: 0,
          allowance: 0,
          remaining: 0,
          resets_at: null,
          overage: false,
          status: "ok" as const,
        },
        // ⚠ ONE FEATURE IS DELIBERATELY UNREADABLE. `storage.bytes` genuinely
        // throws today - see metering/levels.ts - and the usage page has a branch
        // for it that would otherwise never be exercised in review.
        {
          feature_id: "storage.bytes",
          label: "Mailbox storage",
          unit: "bytes",
          used: 0,
          allowance: null,
          remaining: null,
          resets_at: null,
          overage: false,
          status: "unreadable" as const,
        },
      ],
      // A free workspace: the plan's 100 a day, and its tier's month (#165).
      limits: [
        {
          window: "day" as const,
          count: 1,
          source: "plan" as const,
          used: 62,
          allowance: 100,
          remaining: 38,
          resets_at: new Date(Date.now() + 5 * 3_600_000 + 12 * 60_000).toISOString(),
          overage: false,
          starts_on_send: false,
          status: "ok" as const,
        },
        {
          window: "month" as const,
          count: 1,
          source: "tier" as const,
          tier: "normal",
          used: 1840,
          allowance: 3000,
          remaining: 1160,
          resets_at: ago(-12),
          overage: false,
          starts_on_send: false,
          status: "ok" as const,
        },
      ],
      billing: BILLING,
    }),
  ],

  [/^\/console\/plans$/, () => ({ data: PLANS })],

  [
    /^\/console\/onboarding$/,
    () => ({
      step: "domain",
      completed_at: null,
      last_onboarded_plan: null,
      use_case: null,
      should_onboard: true,
      facts: { has_domain: true, has_verified_domain: true, has_api_key: true },
    }),
  ],

  [
    /^\/console\/contacts\/([^/]+)$/,
    (m) => {
      const contact = CONTACTS.find((c) => c.id === m[1])
      // ⚠ NOT A FALLBACK TO THE FIRST ROW - see `PREVIEW_NOT_FOUND`.
      if (!contact) return PREVIEW_NOT_FOUND
      return {
        ...contact,
        segments: [{ id: SEGMENTS[0]!.id, name: SEGMENTS[0]!.name }],
        topics: [
          {
            id: "8f7a1c00-0000-4000-8000-000000000001",
            name: "Product updates",
            subscribed: true,
          },
          {
            id: "8f7a1c00-0000-4000-8000-000000000002",
            name: "Monthly newsletter",
            subscribed: false,
          },
        ],
      }
    },
  ],

  [
    /^\/console\/contacts$/,
    (_m, query) => ({
      data: CONTACTS.filter(
        (c) =>
          has(q(query, "search"), c.email, c.first_name, c.last_name) &&
          (!q(query, "status") ||
            (q(query, "status") === "unsubscribed") === c.unsubscribed) &&
          // The first segment holds every other contact.
          (!q(query, "segment_id") ||
            (q(query, "segment_id") === SEGMENTS[0]!.id &&
              CONTACTS.indexOf(c) % 2 === 0)),
      ),
      nextCursor: null,
    }),
  ],
  [/^\/console\/segments$/, () => ({ data: SEGMENTS })],

  [
    /^\/console\/topics$/,
    () => ({
      data: [
        {
          id: "8f7a1c00-0000-4000-8000-000000000001",
          name: "Product updates",
          description: "What we ship, roughly once a month.",
          default_subscription: "opt_in",
          visibility: "public",
          subscriber_count: 1197,
          created_at: ago(110),
        },
        {
          id: "8f7a1c00-0000-4000-8000-000000000002",
          name: "Monthly newsletter",
          description: null,
          default_subscription: "opt_out",
          visibility: "public",
          subscriber_count: 412,
          created_at: ago(60),
        },
      ],
    }),
  ],

  [
    /^\/console\/contact-properties$/,
    () => ({
      data: [
        {
          id: "9f7a1c00-0000-4000-8000-000000000001",
          key: "plan",
          type: "string",
          fallback_value: "free",
          created_at: ago(90),
        },
        {
          id: "9f7a1c00-0000-4000-8000-000000000002",
          key: "seats",
          type: "number",
          fallback_value: "1",
          created_at: ago(90),
        },
      ],
    }),
  ],

  [
    /^\/console\/broadcasts\/([^/]+)$/,
    (m) => {
      // ⚠ THE ID IS CHECKED RATHER THAN IGNORED - see `PREVIEW_NOT_FOUND`.
      if (m[1] !== "af7a1c00-0000-4000-8000-000000000001") return PREVIEW_NOT_FOUND
      return {
        id: "af7a1c00-0000-4000-8000-000000000001",
        segment_id: SEGMENTS[0]!.id,
        segment_name: SEGMENTS[0]!.name,
        topic_id: "8f7a1c00-0000-4000-8000-000000000001",
        name: "March product update",
        from: "hello@acme.com",
        reply_to: [],
        subject: "What we shipped in March",
        preview_text: "Delegated domains, a faster log, and a new dashboard.",
        html: "<h1>What we shipped</h1><p>Hello {{first_name}},</p>",
        text: null,
        status: "sent",
        scheduled_at: null,
        sent_at: ago(12),
        recipient_count: 1284,
        created_at: ago(14),
        stats: { total: 1284, delivered: 1251, bounced: 21, complained: 2, failed: 10 },
      }
    },
  ],

  [
    /^\/console\/broadcasts$/,
    () => ({
      data: [
        {
          id: "af7a1c00-0000-4000-8000-000000000001",
          segment_id: SEGMENTS[0]!.id,
          segment_name: SEGMENTS[0]!.name,
          topic_id: null,
          name: "March product update",
          from: "hello@acme.com",
          reply_to: [],
          subject: "What we shipped in March",
          preview_text: null,
          html: null,
          text: null,
          status: "sent",
          scheduled_at: null,
          sent_at: ago(12),
          recipient_count: 1284,
          created_at: ago(14),
        },
        {
          id: "af7a1c00-0000-4000-8000-000000000002",
          segment_id: null,
          segment_name: null,
          topic_id: null,
          name: "April update (draft)",
          from: "",
          reply_to: [],
          subject: "",
          preview_text: null,
          html: null,
          text: null,
          status: "draft",
          scheduled_at: null,
          sent_at: null,
          recipient_count: null,
          created_at: ago(1),
        },
      ],
    }),
  ],

  [/^\/console\/github$/, () => GITHUB_STATE],
  [
    /^\/console\/github\/install$/,
    () => ({ url: "https://github.com/apps/i10/installations/new?state=preview" }),
  ],
  [
    /^\/console\/github\/installations\/(\d+)\/repositories$/,
    () => ({
      data: [
        { id: 1, full_name: "acme/emails", default_branch: "main", private: true },
        {
          id: 2,
          full_name: "acme/marketing-site",
          default_branch: "main",
          private: false,
        },
        {
          id: 3,
          full_name: "acme/transactional",
          default_branch: "trunk",
          private: true,
        },
      ],
    }),
  ],
  [/^\/console\/templates\/upload$/, () => ({ data: TEMPLATE_UPLOAD, problems: [] })],
  [/^\/console\/templates\/move$/, () => ({ moved: 1 })],
  [/^\/console\/templates\/delete$/, () => ({ deleted: [] })],
  [/^\/console\/template-folders$/, () => TEMPLATE_FOLDERS[0]],
  [
    /^\/console\/template-folders\/([^/]+)$/,
    (m) => TEMPLATE_FOLDERS.find((f) => f.id === m[1]) ?? PREVIEW_NOT_FOUND,
  ],
  [
    /^\/console\/templates\/([^/]+)\/duplicate$/,
    (m) => templateDetailFixture(m[1]!) ?? PREVIEW_NOT_FOUND,
  ],
  [/^\/console\/templates\/([^/]+)\/test$/, () => ({ id: "preview" })],
  [
    /^\/console\/templates\/([^/]+)\/draft-preview$/,
    (m) => {
      const t = TEMPLATES.find((x) => x.id === m[1])
      if (!t) return PREVIEW_NOT_FOUND
      const live = t.versions.find((v) => v.number === t.live)
      return {
        subject: t.subject,
        html: live ? fillFixture(live.html, live.variables) : t.html,
        text: null,
      }
    },
  ],

  [
    /^\/console\/templates\/([^/]+)\/versions\/(\d+)\/preview$/,
    (m) => {
      const version = templateVersionFixture(m[1]!, Number(m[2]))
      if (!version) return PREVIEW_NOT_FOUND
      return {
        subject: fillFixture(version.subject, version.variables),
        html: version.html,
        text: version.text,
      }
    },
  ],

  [
    /^\/console\/templates\/([^/]+)\/versions\/(\d+)\/promote$/,
    (m) => templateDetailFixture(m[1]!) ?? PREVIEW_NOT_FOUND,
  ],

  [
    /^\/console\/templates\/([^/]+)\/versions\/(\d+)$/,
    (m) => templateVersionFixture(m[1]!, Number(m[2])) ?? PREVIEW_NOT_FOUND,
  ],

  [
    /^\/console\/templates\/([^/]+)\/versions$/,
    (m) => {
      const detail = templateDetailFixture(m[1]!)
      if (!detail) return PREVIEW_NOT_FOUND
      return { ...templateVersionFixture(m[1]!, detail.version)!, unchanged: false }
    },
  ],

  [
    /^\/console\/templates\/([^/]+)$/,
    // ⚠ THE ID IS CHECKED RATHER THAN IGNORED - see `PREVIEW_NOT_FOUND`.
    (m) => templateDetailFixture(m[1]!) ?? PREVIEW_NOT_FOUND,
  ],

  [
    /^\/console\/templates$/,
    (_m, _q, method) =>
      method === "POST"
        ? templateDetailFixture("bf7a1c00-0000-4000-8000-00000000000a")
        : { data: TEMPLATES.map((t) => summary(t)), folders: TEMPLATE_FOLDERS },
  ],
]

/**
 * The fixture for one API path, or `undefined` when there is none.
 *
 * ⚠ A MISSING FIXTURE RETURNS `undefined` AND THE CALLER THROWS, rather than
 * returning an empty object. A page that silently renders with `undefined`
 * everywhere looks like a styling bug; a thrown error names the path that needs
 * a fixture, which is the actual problem.
 */
/**
 * How many times each domain has been asked about, so the watch has somewhere
 * to arrive. Dev-only, per server process, and reset by a restart.
 */
const refreshes = new Map<string, number>()

export function previewFor(path: string, query?: Query, method = "GET"): unknown {
  for (const [pattern, build] of ROUTES) {
    const match = path.match(pattern)
    if (match) return build(match, query, method)
  }
  return undefined
}

/**
 * ⚠ THE PROVIDER IS CHOSEN BY A SUBSTRING OF THE NAME, NOT BY A REAL LOOKUP.
 * Preview mode does no DNS at all - the point is to reach each branch of the
 * screen from the keyboard. `acme.dev` is the provider we cannot connect,
 * `acme.shop` is the one with no NS row, `acme.net` is mid-migration, and
 * anything else unrecognised falls through to "we could not match your
 * nameservers".
 */
function dnsFixtureFor(domain: string) {
  if (domain.endsWith(".dev")) {
    return {
      nameservers: ["ns39.domaincontrol.com", "ns40.domaincontrol.com"],
      provider: {
        slug: "godaddy",
        name: "GoDaddy",
        kind: "registrar",
        nsDelegation: true,
        // GoDaddy gates its DNS API behind an account-size threshold, so the
        // console offers delegation instead of a button that would 403.
        canConnect: false,
        oauth: false,
        manualPath: "My Products → Domains → DNS → Add New Record",
      },
      confidence: "exact" as const,
    }
  }

  if (domain.endsWith(".shop")) {
    return {
      nameservers: ["ns1.wixdns.net", "ns2.wixdns.net"],
      provider: {
        slug: "wix",
        name: "Wix",
        kind: "registrar",
        // Their record editor has no NS row, so delegation is impossible and
        // the form disables it with the reason attached.
        nsDelegation: false,
        canConnect: false,
        oauth: false,
        manualPath: "Domains → your domain → Advanced → Edit DNS → Add record",
      },
      confidence: "exact" as const,
    }
  }

  if (domain.endsWith(".net")) {
    return {
      nameservers: [
        "gina.ns.cloudflare.com",
        "rick.ns.cloudflare.com",
        "ns-264.awsdns-33.com",
      ],
      provider: {
        slug: "cloudflare",
        name: "Cloudflare",
        kind: "authoritative",
        nsDelegation: true,
        canConnect: true,
        oauth: true,
        manualPath: "Cloudflare dashboard → your domain → DNS → Records → Add record",
      },
      confidence: "partial" as const,
    }
  }

  if (domain.endsWith(".org")) {
    return {
      nameservers: ["ns1.some-tiny-host.example", "ns2.some-tiny-host.example"],
      provider: null,
      confidence: "none" as const,
    }
  }

  return {
    nameservers: ["gina.ns.cloudflare.com", "rick.ns.cloudflare.com"],
    provider: {
      slug: "cloudflare",
      name: "Cloudflare",
      kind: "authoritative",
      nsDelegation: true,
      canConnect: true,
      oauth: true,
      manualPath: "Cloudflare dashboard → your domain → DNS → Records → Add record",
    },
    confidence: "exact" as const,
  }
}

/**
 * What `/api/checkout-status/{id}` answers in preview mode.
 *
 * ⚠ READING A CHECKOUT IS NOT TAKING MONEY, WHICH IS WHY THIS EXISTS WHERE
 * `POST /console/billing/checkout` DELIBERATELY REFUSES. That refusal is right:
 * a fixture answering with a plausible checkout url would send whoever is
 * reviewing to a real Polar page. This endpoint only reports what became of a
 * checkout, and its five outcomes - granted, paid, closed, declined, expired -
 * are five pieces of copy that somebody has to be able to look at. They were
 * previously unreachable in preview, which is how "the redirect shows nothing"
 * survived as long as it did.
 *
 * ⚠ THE OUTCOME IS CHOSEN BY THE ID'S FIRST BLOCK SO ALL OF THEM ARE REACHABLE.
 * Append `?checkout_id=<uuid>` to the billing page or to `/onboarding`, using
 * one of the prefixes below with any well-formed remainder - for example
 * `00000004-0000-4000-8000-000000000000` for a declined card. Any other id is
 * the ordinary success.
 */
export function previewCheckoutStatus(checkoutId: string): {
  status: string
  plan: string | null
  detail?: string
} {
  switch (checkoutId.slice(0, 8).toLowerCase()) {
    // The second or two between Polar taking the money and the entitlement
    // landing. The page keeps polling through this one.
    case "00000002":
      return { status: "paid", plan: null }
    // Closed without paying. Ordinary, and must not be dressed up as an error.
    case "00000003":
      return { status: "unpaid", plan: null, detail: "open" }
    // A declined card.
    case "00000004":
      return { status: "unpaid", plan: null, detail: "failed" }
    // A form left open too long.
    case "00000005":
      return { status: "unpaid", plan: null, detail: "expired" }
    // Paid, and attributable to nobody. The one genuine dead end.
    case "00000006":
      return { status: "paid", plan: null, detail: "unattributed" }
    default:
      return { status: "granted", plan: "Pro" }
  }
}

function previewSendingStatus() {
  return {
    status: "enabled",
    cause: null,
    changed_at: null,
    health: "at_risk",
    findings: [
      {
        type: "bounce",
        impact: "high",
        description:
          "The bounce rate exceeded 15.0% based on a representative volume of 664 emails.",
        opened_at: ago(0, 3),
      },
    ],
  }
}
