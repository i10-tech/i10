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
 * the literal `"production"` at build time by Next — in server code as well as
 * client — so in a production build the first half of the condition below is
 * `"production" !== "production"` and the whole expression folds to `false`.
 * Every `if (PREVIEW)` block is then a branch on a constant, and the bundler
 * deletes it: the compiled `api()` in the production output goes straight from
 * its path guard to `fetch`, with no reference to anything in this file. There
 * is no environment variable anybody can set in a pod to turn it back on.
 *
 * ⚠ WHAT IS REMOVED IS THE READ, NOT NECESSARILY THE DATA. Turbopack folds the
 * branch but still emits these fixture constants into the server chunk, where
 * they sit unreferenced — verified by building and grepping the output. That is
 * a few kilobytes of dead weight, and it is worth knowing precisely, because
 * the claim that matters is the checkable one: nothing in a production build
 * READS a fixture. "The module is gone" is a claim this build does not support,
 * and a security property stated more strongly than it is true is a security
 * property nobody re-checks.
 *
 * ⚠ AND IT IS OFF BY DEFAULT IN DEVELOPMENT TOO. `bun run dev` talks to a real
 * API on localhost; `bun run dev:preview` sets the variable. A developer
 * debugging a live query must never silently be looking at fixtures — that is
 * the failure mode that makes this kind of mode dangerous, and the only
 * protection is that turning it on is deliberate.
 */

export const PREVIEW =
  process.env.NODE_ENV !== "production" && process.env.CONSOLE_PREVIEW === "1"

/**
 * ⚠ THE FIXTURES ARE DELIBERATELY NOT ALL HEALTHY. A preview where every domain
 * is verified, nothing has bounced and every meter is at 12% shows none of the
 * states the interface actually has to handle — and those are exactly the ones
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
 * file and no deletion consequence — so every line of copy that had to be got
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
  },
  {
    object: "domain" as const,
    id: "1f7a1c00-0000-4000-8000-000000000002",
    name: "mail.acme.dev",
    status: "pending",
    created_at: ago(2),
    region: "us-east-1",
    delegated: false,
  },
  {
    object: "domain" as const,
    id: "1f7a1c00-0000-4000-8000-000000000003",
    name: "old.acme.net",
    status: "failed",
    created_at: ago(96),
    region: "us-east-1",
    delegated: false,
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
      ttl: "Auto",
      status: domain.status,
      value: "ns1.i10.tech",
    }))
  }

  return [
    {
      record: "DKIM",
      name: `i10._domainkey.${domain.name}`,
      type: "TXT" as const,
      ttl: "Auto",
      status: domain.status === "failed" ? "failed" : domain.status,
      value: DKIM_KEY,
    },
    {
      record: "SPF",
      name: `send.${domain.name}`,
      type: "TXT" as const,
      ttl: "Auto",
      status: domain.status === "failed" ? "failed" : "verified",
      value: "v=spf1 include:amazonses.com ~all",
    },
    {
      record: "SPF",
      name: `send.${domain.name}`,
      type: "MX" as const,
      ttl: "Auto",
      status: domain.status === "failed" ? "failed" : "verified",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    },
    {
      record: "DMARC",
      name: `_dmarc.${domain.name}`,
      type: "TXT" as const,
      ttl: "Auto",
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
    route: i % 4 === 0 ? "direct" : "ses",
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
  // A weekday shape, with a quiet weekend — a flat line looks synthetic.
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
 * ⚠ THE ROUTE TABLE IS MATCHED IN ORDER AND LONGEST-FIRST, so `/console/emails/x`
 * cannot be swallowed by `/console/emails`. It mirrors the API's own paths
 * exactly — if a path here drifts from the real one, preview mode would keep
 * working while the real console broke, which is the one thing a fixture layer
 * must never do.
 */
type Query = Record<string, string | number | undefined | null> | undefined

/**
 * "This id does not exist here" — the one answer a fixture layer has to be able
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
 * SOMETHING ELSE HERE — "no fixture is defined for this path at all", which
 * `api()` reports as a 501 telling whoever is building the screen to add one.
 * Confusing a missing ROW with a missing FIXTURE would turn a reviewable 404
 * into a "go and edit preview.ts" message.
 */
export const PREVIEW_NOT_FOUND = Symbol("preview:not-found")

/**
 * "This needs a real payment provider, which preview mode does not have."
 *
 * ⚠ SEPARATE FROM `PREVIEW_NOT_FOUND` BECAUSE IT IS A 503, NOT A 404. Nothing is
 * missing — the operation genuinely cannot be performed here, and the message
 * has to say so rather than implying the plan or the customer does not exist.
 */
export const PREVIEW_UNAVAILABLE = Symbol("preview:unavailable")

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
   * explicitly, with a message that says why, is the honest option — and it
   * exercises the button's real error path, which is worth being able to see.
   */
  [/^\/console\/billing\/checkout$/, () => PREVIEW_UNAVAILABLE],
  [/^\/console\/billing\/payment-method-session$/, () => PREVIEW_UNAVAILABLE],
  [
    /^\/console\/me$/,
    () => ({
      user: { id: "user_preview" },
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
      // ⚠ NOT A FALLBACK TO THE FIRST ROW — see `PREVIEW_NOT_FOUND`.
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

  [/^\/console\/emails$/, () => ({ data: EMAILS, nextCursor: null })],

  [
    /^\/console\/domains\/([^/]+)$/,
    (m) => {
      const domain = DOMAINS.find((d) => d.id === m[1])
      // ⚠ NOT A FALLBACK TO THE FIRST ROW — see `PREVIEW_NOT_FOUND`.
      if (!domain) return PREVIEW_NOT_FOUND
      /*
       * ⚠ THE BADGE STAYS `pending` HERE EVEN AFTER THE WATCH BELOW REPORTS
       * VERIFIED, AND THAT IS A LIMIT OF THE MODE RATHER THAN A BUG IN IT. A
       * server action and a server render are separate module instances under
       * `next dev`, so the counter the refresh route keeps is not the one this
       * render would read — sharing it would need a store, which is the thing
       * preview mode exists to avoid. In production the refresh writes the row
       * and the re-render reads it back, so the badge does turn over.
       */
      return { ...domain, records: recordsFor(domain) }
    },
  ],

  /*
   * ⚠ VERIFY AND REFRESH HAD NO FIXTURE AT ALL, AND AN ABSENT FIXTURE IS NOT
   * AN INERT ONE. `previewFor` returns `undefined` for a path it does not
   * know, `api()` hands that back as the payload, and the caller reads
   * `.status` off it — so pressing Verify in preview threw
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
   * spinner and never the thing worth looking at — the moment the page
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
   * A mutation in preview is still a no-op that reports success — nothing
   * persists — but "success" for a POST here is a DOMAIN, and returning the
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
   * the five states this screen has — and the interesting ones are the provider
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
   * prompt is Clerk's own dialog and preview mode has no session at all — so
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
          domain: null,
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
          domain: "mail.acme.dev",
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
          domain: null,
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
    () => ({
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
      })),
      nextCursor: null,
    }),
  ],

  [
    /^\/console\/suppressions$/,
    () => ({
      data: Array.from({ length: 12 }, (_, i) => ({
        address: `bounced+${i}@example.com`,
        reason: ["hard_bounce", "hard_bounce", "complaint", "manual"][i % 4]!,
        message_id: i % 3 === 0 ? EMAILS[0]!.id : null,
        created_at: ago(i * 4),
      })),
      nextCursor: null,
    }),
  ],

  [
    /^\/console\/requests$/,
    () => ({
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
      })),
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
        // throws today — see metering/levels.ts — and the usage page has a branch
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
      // ⚠ NOT A FALLBACK TO THE FIRST ROW — see `PREVIEW_NOT_FOUND`.
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

  [/^\/console\/contacts$/, () => ({ data: CONTACTS, nextCursor: null })],
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
      // ⚠ THE ID IS CHECKED RATHER THAN IGNORED — see `PREVIEW_NOT_FOUND`.
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

  [
    /^\/console\/templates\/([^/]+)$/,
    (m) => {
      // ⚠ THE ID IS CHECKED RATHER THAN IGNORED — see `PREVIEW_NOT_FOUND`.
      if (m[1] !== "bf7a1c00-0000-4000-8000-000000000001") return PREVIEW_NOT_FOUND
      return {
        id: "bf7a1c00-0000-4000-8000-000000000001",
        name: "password-reset",
        folder: "transactional/auth",
        subject: "Reset your password",
        html: '<p>Hello {{first_name}},</p>\n<p><a href="{{reset_url}}">Reset your password</a></p>',
        text: "Hello {{first_name}},\n\nReset your password: {{reset_url}}",
        published_at: ago(30),
        version: 4,
        created_at: ago(170),
        updated_at: ago(3),
      }
    },
  ],

  [
    /^\/console\/templates$/,
    () => ({
      data: [
        {
          id: "bf7a1c00-0000-4000-8000-000000000001",
          name: "password-reset",
          folder: "transactional/auth",
          subject: "Reset your password",
          html: null,
          text: null,
          published_at: ago(30),
          version: 4,
          created_at: ago(170),
          updated_at: ago(3),
        },
        {
          id: "bf7a1c00-0000-4000-8000-000000000002",
          name: "welcome",
          folder: "transactional/auth",
          subject: "Welcome to Acme",
          html: null,
          text: null,
          published_at: ago(80),
          version: 2,
          created_at: ago(160),
          updated_at: ago(80),
        },
        {
          id: "bf7a1c00-0000-4000-8000-000000000003",
          name: "receipt",
          folder: null,
          subject: "Your receipt",
          html: null,
          text: null,
          published_at: null,
          version: 0,
          created_at: ago(5),
          updated_at: ago(5),
        },
      ],
    }),
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
 * Preview mode does no DNS at all — the point is to reach each branch of the
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
 * checkout, and its five outcomes — granted, paid, closed, declined, expired —
 * are five pieces of copy that somebody has to be able to look at. They were
 * previously unreachable in preview, which is how "the redirect shows nothing"
 * survived as long as it did.
 *
 * ⚠ THE OUTCOME IS CHOSEN BY THE ID'S FIRST BLOCK SO ALL OF THEM ARE REACHABLE.
 * Append `?checkout_id=<uuid>` to the billing page or to `/onboarding`, using
 * one of the prefixes below with any well-formed remainder — for example
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
