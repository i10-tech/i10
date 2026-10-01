/*
 * ⚠ PLACEHOLDER PRICING. Every plan, price and limit below is Resend's, copied
 * from resend.com/pricing on 2026-09-30 at the product owner's request, so the
 * page can be built and judged before i10's own numbers are chosen. Replace
 * the numbers here and nowhere else; the page reads only this file.
 *
 * Two deliberate departures from Resend, both marked where they appear:
 *  - Retention uses i10's REAL values (Free 3 days, paid 30 days), already
 *    enforced by the content sweeps; showing Resend's 30 days would be a claim
 *    the product does not honour.
 *  - Mailboxes are i10-only, so their add-on price is INVENTED. Resend has no
 *    equivalent to copy. Decide it before publishing.
 *
 * Metering and the free sending tiers (docs/decisions/metering.md) are not
 * reflected yet either.
 */

export type Product = "transactional" | "marketing"

export interface Stop {
  label: string
  value: number
}

export const STOPS: Record<Product, Stop[]> = {
  transactional: [
    { label: "3,000", value: 3_000 },
    { label: "50,000", value: 50_000 },
    { label: "100,000", value: 100_000 },
    { label: "200,000", value: 200_000 },
    { label: "500,000", value: 500_000 },
    { label: "1,000,000", value: 1_000_000 },
    { label: "1,500,000", value: 1_500_000 },
    { label: "2,500,000", value: 2_500_000 },
    { label: "3,000,000+", value: 3_000_000 },
  ],
  marketing: [
    { label: "1,000", value: 1_000 },
    { label: "5,000", value: 5_000 },
    { label: "10,000", value: 10_000 },
    { label: "25,000", value: 25_000 },
    { label: "50,000", value: 50_000 },
    { label: "100,000", value: 100_000 },
    { label: "150,000", value: 150_000 },
    { label: "200,000+", value: 200_000 },
  ],
}

export interface PlanView {
  id: string
  name: string
  price: number | null // null = custom
  unit: string
  allowance: string
  overage?: string
  features: { text: string; included: boolean }[]
  cta: string
  href: string
}

const SIGN_UP = "https://auth.i10.tech/sign-up"
const CONTACT = "/contact"

// Scale's price and allowance per transactional stop (index into STOPS).
const SCALE: Record<number, { price: number; volume: string; over: string }> = {
  0: { price: 90, volume: "100,000", over: "$0.90" },
  1: { price: 90, volume: "100,000", over: "$0.90" },
  2: { price: 90, volume: "100,000", over: "$0.90" },
  3: { price: 160, volume: "200,000", over: "$0.80" },
  4: { price: 350, volume: "500,000", over: "$0.70" },
  5: { price: 650, volume: "1,000,000", over: "$0.65" },
  6: { price: 825, volume: "1,500,000", over: "$0.52" },
  7: { price: 1150, volume: "2,500,000", over: "$0.46" },
  8: { price: 1150, volume: "2,500,000", over: "$0.46" },
}

const PRO_MARKETING: Record<number, { price: number; contacts: string }> = {
  0: { price: 40, contacts: "5,000" },
  1: { price: 40, contacts: "5,000" },
  2: { price: 80, contacts: "10,000" },
  3: { price: 180, contacts: "25,000" },
  4: { price: 250, contacts: "50,000" },
  5: { price: 450, contacts: "100,000" },
  6: { price: 650, contacts: "150,000" },
  7: { price: 650, contacts: "150,000" },
}

export function plansFor(
  product: Product,
  stop: number,
): { plans: PlanView[]; recommended: string } {
  if (product === "transactional") {
    const scale = SCALE[stop] ?? SCALE[0]!
    const pro100 = stop >= 2
    const plans: PlanView[] = [
      {
        id: "free",
        name: "Free",
        price: 0,
        unit: "/ mo",
        allowance: "3,000 emails / mo",
        features: [
          { text: "100 emails a day", included: true },
          { text: "3 domains", included: true },
          { text: "1 webhook endpoint", included: true },
          { text: "Ticket support", included: true },
          { text: "3-day data retention", included: true },
          { text: "Mailboxes", included: false },
        ],
        cta: "Start free",
        href: SIGN_UP,
      },
      {
        id: "pro",
        name: "Pro",
        price: pro100 ? 35 : 20,
        unit: "/ mo",
        allowance: `${pro100 ? "100,000" : "50,000"} emails / mo`,
        overage: "Extra emails $0.90 / 1,000",
        features: [
          { text: "Everything in Free", included: true },
          { text: "10 domains", included: true },
          { text: "No daily limit", included: true },
          { text: "5 webhook endpoints", included: true },
          { text: "30-day data retention", included: true },
          { text: "Mailboxes add-on", included: true },
        ],
        cta: "Start with Pro",
        href: SIGN_UP,
      },
      {
        id: "scale",
        name: "Scale",
        price: scale.price,
        unit: "/ mo",
        allowance: `${scale.volume} emails / mo`,
        overage: `Extra emails ${scale.over} / 1,000`,
        features: [
          { text: "Everything in Pro", included: true },
          { text: "1,000 domains", included: true },
          { text: "10 webhook endpoints", included: true },
          { text: "Dedicated Slack channel", included: true },
          { text: "Dedicated IP add-on", included: true },
          { text: "SSO add-on", included: true },
        ],
        cta: "Start with Scale",
        href: SIGN_UP,
      },
      {
        id: "enterprise",
        name: "Enterprise",
        price: null,
        unit: "",
        allowance: "Performance at any scale",
        features: [
          { text: "Everything in Scale", included: true },
          { text: "99.99% uptime SLA", included: true },
          { text: "Guaranteed response times", included: true },
          { text: "Migration support", included: true },
          { text: "Single sign-on", included: true },
          { text: "Custom limits and terms", included: true },
        ],
        cta: "Talk to us",
        href: CONTACT,
      },
    ]
    const recommended =
      stop === 0 ? "free" : stop <= 2 ? "pro" : stop <= 7 ? "scale" : "enterprise"
    return { plans, recommended }
  }

  const pro = PRO_MARKETING[stop] ?? PRO_MARKETING[0]!
  const plans: PlanView[] = [
    {
      id: "free",
      name: "Free",
      price: 0,
      unit: "/ mo",
      allowance: "1,000 contacts",
      features: [
        { text: "Unlimited broadcast sends", included: true },
        { text: "3 segments", included: true },
        { text: "3 domains", included: true },
        { text: "Broadcast analytics", included: true },
        { text: "Ticket support", included: true },
      ],
      cta: "Start free",
      href: SIGN_UP,
    },
    {
      id: "pro",
      name: "Pro",
      price: pro.price,
      unit: "/ mo",
      allowance: `${pro.contacts} contacts`,
      features: [
        { text: "Everything in Free", included: true },
        { text: "Unlimited segments", included: true },
        { text: "Unlimited domains", included: true },
        { text: "Topics and preferences", included: true },
        { text: "Slack and ticket support", included: true },
      ],
      cta: "Start with Pro",
      href: SIGN_UP,
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: null,
      unit: "",
      allowance: "Performance at any scale",
      features: [
        { text: "Everything in Pro", included: true },
        { text: "Priority support", included: true },
        { text: "Flexible limits", included: true },
        { text: "Single sign-on", included: true },
        { text: "Custom terms", included: true },
      ],
      cta: "Talk to us",
      href: CONTACT,
    },
  ]
  const recommended = stop === 0 ? "free" : stop <= 6 ? "pro" : "enterprise"
  return { plans, recommended }
}

export const ADD_ONS = [
  {
    // ⚠ INVENTED PRICE - see the header of this file.
    name: "Mailboxes",
    price: "$4 / mailbox / mo",
    body: "Real inboxes on your sending domain with IMAP, JMAP, SMTP and webmail. Add or remove seats whenever you need to.",
    cta: "Add mailboxes",
  },
  {
    name: "Extra domains",
    price: "$20 / mo",
    body: "Sending from a separate domain for every customer or brand? This adds 100 more on top of your plan. Pro and Scale.",
    cta: "Add domains",
  },
  {
    name: "Dedicated IP",
    price: "$30 / mo",
    body: "For senders past 3,000 emails a day on Scale. We warm it, watch it and scale it so you only think about sending.",
    cta: "Request an IP",
  },
  {
    name: "Single sign-on",
    price: "$150 / mo",
    body: "Your team signs in to i10 with your identity provider. An add-on on Scale, included on Enterprise.",
    cta: "Talk to us",
  },
]

type Cell = boolean | string
export const COMPARE: {
  section: string
  rows: { label: string; values: [Cell, Cell, Cell, Cell] }[]
}[] = [
  {
    section: "Sending",
    rows: [
      { label: "Daily limit", values: ["100", "No limit", "No limit", "No limit"] },
      { label: "Resend-compatible REST API", values: [true, true, true, true] },
      { label: "Official SDKs", values: [true, true, true, true] },
      { label: "Batch sending", values: [true, true, true, true] },
      { label: "Idempotency keys", values: [true, true, true, true] },
      { label: "Attachments and inline images", values: [true, true, true, true] },
      { label: "React Email templates", values: [true, true, true, true] },
      { label: "Templates from GitHub", values: [false, true, true, true] },
    ],
  },
  {
    section: "Deliverability",
    rows: [
      { label: "Custom domains", values: ["3", "10", "1,000", "Flexible"] },
      { label: "SPF and DKIM alignment", values: [true, true, true, true] },
      { label: "Suppression lists", values: [true, true, true, true] },
      { label: "Dedicated IPs", values: [false, false, "Add-on", "Add-on"] },
      { label: "Data retention", values: ["3 days", "30 days", "30 days", "Flexible"] },
      { label: "Webhook endpoints", values: ["1", "5", "10", "Flexible"] },
    ],
  },
  {
    section: "Mailboxes",
    rows: [
      { label: "IMAP, JMAP and SMTP", values: [false, "Add-on", "Add-on", true] },
      { label: "Webmail", values: [false, "Add-on", "Add-on", true] },
      { label: "Aliases and groups", values: [false, "Add-on", "Add-on", true] },
    ],
  },
  {
    section: "Security",
    rows: [
      { label: "EU data region", values: [true, true, true, true] },
      { label: "Sealed message bodies", values: [true, true, true, true] },
      { label: "Signed webhooks", values: [true, true, true, true] },
      { label: "Multi-factor authentication", values: [true, true, true, true] },
      { label: "Single sign-on", values: [false, false, "Add-on", true] },
    ],
  },
  {
    section: "Support",
    rows: [
      { label: "Ticket support", values: [true, true, true, true] },
      { label: "Slack channel", values: [false, false, true, true] },
      { label: "Response-time SLA", values: [false, false, false, true] },
    ],
  },
]

export const FAQ = [
  {
    q: "Is there a free plan?",
    a: "Yes. 3,000 emails a month and 100 a day, three domains, no card. It is the same product as the paid plans, with smaller limits.",
  },
  {
    q: "What happens if I send more than my plan includes?",
    a: "On Pro and Scale, extra emails are billed per thousand at the rate shown on your plan. On Free, sends are refused with a monthly_quota_exceeded error until the month resets or you upgrade.",
  },
  {
    q: "Can I move from Resend without changing my code?",
    a: "Yes. Swap the package for @i10/node and the API key for an i10 key. Requests, responses and error names match on purpose.",
  },
  {
    q: "Are mailboxes included?",
    a: "Mailboxes are an add-on on Pro and Scale, priced per mailbox, and included on Enterprise. They live on the same domain you send from.",
  },
  {
    q: "Where is my data stored?",
    a: "In the EU. i10 sends through eu-central-1 in Frankfurt, and message bodies are sealed into per-workspace packs.",
  },
  {
    q: "Do you offer discounts for startups or non-profits?",
    a: "Talk to us. Early teams building on i10 are exactly who the product is for.",
  },
]
