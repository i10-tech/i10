import type { GraphicVariant } from "@/components/fx/line-graphic"
import type { Hue, IconName } from "./site"

/*
 * Every secondary page the nav and footer link to, as data. The catch-all
 * route renders from this registry and 404s anything not in it, so a link and
 * its page are added in one place.
 *
 * ⚠ PLACEHOLDER CONTENT. Product pages describe what exists in the repository;
 * legal, company and comparison pages carry draft text marked as such on the
 * page. None of it has been through legal or marketing review.
 */

export interface ProductPage {
  kind: "product"
  title: string
  lede: string
  eyebrow: string
  hue: Hue
  icon: IconName
  graphic: GraphicVariant
  chapters: { label: string; title: string; muted: string; body: string }[]
  terms: { term: string; body: string }[]
  cards: { title: string; body: string }[]
}

export interface DocPage {
  kind: "legal"
  title: string
  lede: string
  updated: string
  sections: { title: string; paragraphs: string[] }[]
}

export interface ComparePage {
  kind: "compare"
  title: string
  them: string
  lede: string
  rows: { label: string; i10: string; them: string }[]
}

export interface SimplePage {
  kind: "simple"
  title: string
  eyebrow: string
  lede: string
  blocks: { title: string; body: string; meta?: string; href?: string }[]
  variant?: "list" | "grid"
}

export interface SpecialPage {
  kind: "changelog" | "status" | "brand" | "migrate"
  title: string
  eyebrow: string
  lede: string
}

export type SitePage = ProductPage | DocPage | ComparePage | SimplePage | SpecialPage

const legal = (title: string, lede: string, topics: string[]): DocPage => ({
  kind: "legal",
  title,
  lede,
  updated: "30 Sep 2026",
  sections: topics.map((t) => ({
    title: t,
    paragraphs: [
      `This section of the ${title.toLowerCase()} is a draft. It will describe ${t.toLowerCase()} in plain language before this page is published.`,
      "i10 is operated from the European Union and processes mail through Amazon SES in eu-central-1 (Frankfurt). Where this document refers to your data, it means the messages, metadata and account information your workspace sends to or stores with i10.",
    ],
  })),
})

export const PAGES: Record<string, SitePage> = {
  "product/email-api": {
    kind: "product",
    title: "Email API",
    eyebrow: "Sending",
    lede: "Transactional email over a Resend-compatible REST API. Swap the package, keep every call site.",
    hue: "send",
    icon: "send",
    graphic: "rings",
    chapters: [
      {
        label: "Compatibility",
        title: "The same API you already call.",
        muted: "On purpose.",
        body: "Authorization Bearer, the same request and response shapes, the same error names. The one difference is the key format: i10_live_ and i10_test_, so keys are recognisable in logs and greppable in a secret scan.",
      },
      {
        label: "Safety",
        title: "Retries that never send twice.",
        muted: "Idempotency built in.",
        body: "Anything a retry could duplicate carries an idempotency key. A replay with the same key returns the first result instead of sending again - the difference between a flaky network and four password-reset emails.",
      },
    ],
    terms: [
      {
        term: "Batch sends",
        body: "Up to a hundred messages in one request, each with its own result.",
      },
      {
        term: "Typed errors",
        body: "Every non-2xx throws an I10Error with the API's machine name and a computed retryable flag.",
      },
      {
        term: "Inline images",
        body: "Reference attachments by Content-ID or pass data URIs; the multipart tree is built for you.",
      },
      {
        term: "Quotas you can read",
        body: "rate_limit_exceeded is worth retrying. daily_quota_exceeded is a billing state, and never is.",
      },
    ],
    cards: [
      { title: "@i10/node", body: "The SDK, with zero runtime dependencies." },
      {
        title: "@i10/next",
        body: "A server client and a signed webhook route handler.",
      },
      { title: "REST", body: "Any language that can make an HTTP request." },
      {
        title: "Test keys",
        body: "i10_test_ keys accept sends and fire events without delivering.",
      },
    ],
  },
  "product/mailboxes": {
    kind: "product",
    title: "Mailboxes",
    eyebrow: "For your team",
    lede: "Real inboxes on the domain you already send from. One address, one password, every mail app.",
    hue: "mail",
    icon: "mailbox",
    graphic: "stack",
    chapters: [
      {
        label: "One identity",
        title: "One email, one password.",
        muted: "Everywhere.",
        body: "The same credentials sign in to webmail, IMAP, JMAP and SMTP. i10 delegates authentication to one place, so there is never a second password to reset.",
      },
      {
        label: "Same domain",
        title: "Where you send is where you receive.",
        muted: "No second provider.",
        body: "Mailboxes live on the domain your product mail comes from, so replies to a receipt land in a real inbox instead of a no-reply void.",
      },
    ],
    terms: [
      {
        term: "IMAP, JMAP, SMTP",
        body: "Apple Mail, Outlook, Thunderbird and every client that speaks the standards.",
      },
      {
        term: "Webmail",
        body: "A fast webmail for the people who never open a mail client.",
      },
      {
        term: "Aliases and groups",
        body: "support@, billing@ and team addresses that fan out to people.",
      },
      {
        term: "Managed from the console",
        body: "Create, suspend and remove mailboxes next to your sending domains.",
      },
    ],
    cards: [
      {
        title: "Stalwart inside",
        body: "A modern mail server, run and upgraded by i10.",
      },
      {
        title: "EU hosted",
        body: "Mailboxes stay in the EU with the rest of your mail.",
      },
      { title: "Per seat", body: "Pay per mailbox, add and remove whenever you like." },
      { title: "Your domain", body: "Same DNS onboarding as sending, one extra MX." },
    ],
  },
  "product/domains": {
    kind: "product",
    title: "Domains",
    eyebrow: "DNS",
    lede: "One DKIM record to start sending, fully aligned. Two more to put the envelope on your domain too.",
    hue: "domain",
    icon: "globe",
    graphic: "gauge",
    chapters: [
      {
        label: "Start",
        title: "One record to start.",
        muted: "Sending in two minutes.",
        body: "i10._domainkey TXT is enough: DKIM passes and aligns, so DMARC passes from the first message. The rest is an upgrade you make before volume matters.",
      },
      {
        label: "Own it",
        title: "Two more to own the envelope.",
        muted: "SPF aligns too.",
        body: "A return-path MX and an SPF include on a send subdomain move bounces onto your domain, and Gmail shows mailed-by: yourdomain.",
      },
    ],
    terms: [
      {
        term: "Provider detection",
        body: "A live NS lookup finds your DNS host and shows its exact steps.",
      },
      {
        term: "Connect Cloudflare",
        body: "One click writes the records through Cloudflare's API.",
      },
      {
        term: "Domain Connect",
        body: "One-click setup on the registrars that support the standard.",
      },
      {
        term: "Continuous checks",
        body: "Records are re-verified, and the console marks what needs attention.",
      },
    ],
    cards: [
      { title: "DKIM", body: "i10._domainkey TXT - enough to start." },
      { title: "Return path", body: "send MX, bounces come home." },
      { title: "SPF", body: "include:_spf.i10.tech, never an address." },
      { title: "DMARC", body: "Passes on alignment from the first send." },
    ],
  },
  "product/templates": {
    kind: "product",
    title: "Templates",
    eyebrow: "Templates",
    lede: "React Email, a visual editor, or a repository: templates that are versioned, diffed and published like code.",
    hue: "template",
    icon: "template",
    graphic: "branch",
    chapters: [
      {
        label: "Render once",
        title: "Rendered once per version.",
        muted: "Filled on every send.",
        body: "A template is rendered in a sandbox when its version is created. Sending only substitutes variables, which is why a template send costs what a plain send does.",
      },
      {
        label: "Git",
        title: "Push to main, live in seconds.",
        muted: "No deploy.",
        body: "Connect a GitHub repository and a push to the target branch renders a new version and makes it live. Every version is kept and diffable.",
      },
    ],
    terms: [
      {
        term: "React Email",
        body: "Write templates in JSX with the components you already know.",
      },
      {
        term: "Visual editor",
        body: "Design without code, and still get a versioned template.",
      },
      {
        term: "Images",
        body: "Uploaded to a public, content-addressed bucket per workspace.",
      },
      {
        term: "Versions",
        body: "Every change is a version, with a preview and a diff.",
      },
    ],
    cards: [
      { title: "Sandboxed", body: "Rendering runs isolated from your data." },
      { title: "Thumbnails", body: "Browse templates as a grid of previews." },
      { title: "Variables", body: "Checked to insert only what they declare." },
      { title: "Folders", body: "Upload a folder of templates in one go." },
    ],
  },
  "product/webhooks": {
    kind: "product",
    title: "Webhooks",
    eyebrow: "Events",
    lede: "Every delivery event, signed to the Standard Webhooks spec and retried until your endpoint answers.",
    hue: "hook",
    icon: "webhook",
    graphic: "burst",
    chapters: [
      {
        label: "Signed",
        title: "Signed end to end.",
        muted: "Replay-proof.",
        body: "i10 signs the id, the timestamp and the body together. A signature over the body alone is replayable forever, and a replayed email.bounced is a suppression list that suppresses everyone.",
      },
      {
        label: "Delivered",
        title: "Retried until you answer.",
        muted: "And replayable when you do not.",
        body: "Failed deliveries back off and retry. Anything that still failed can be replayed from the console once your endpoint is healthy.",
      },
    ],
    terms: [
      {
        term: "Standard Webhooks",
        body: "Any conforming library verifies an i10 webhook.",
      },
      {
        term: "createWebhookHandler",
        body: "@i10/next mounts a verified route handler in one line.",
      },
      {
        term: "Every event type",
        body: "Sent, delivered, opened, clicked, bounced, complained and more.",
      },
      {
        term: "Per-domain tracking",
        body: "Open and click tracking switched per sending domain.",
      },
    ],
    cards: [
      { title: "email.delivered", body: "The receiving server accepted it." },
      { title: "email.bounced", body: "Hard or soft, with the SMTP reason." },
      { title: "email.complained", body: "A recipient marked it as spam." },
      { title: "email.opened", body: "When tracking is on for the domain." },
    ],
  },
  "product/inbound": {
    kind: "product",
    title: "Inbound",
    eyebrow: "Coming soon",
    lede: "Receive mail on your domain as webhooks: parsed, signed and ready for your app. In development.",
    hue: "send",
    icon: "inbound",
    graphic: "field",
    chapters: [
      {
        label: "Status",
        title: "Not shipped yet.",
        muted: "Designed in the open.",
        body: "Inbound parsing is on the roadmap. This page will describe it once it is real; until then the changelog is the source of truth.",
      },
    ],
    terms: [
      {
        term: "Planned",
        body: "Parsed messages delivered to your endpoint as signed webhooks.",
      },
    ],
    cards: [
      { title: "Follow along", body: "Watch the changelog for the first release." },
    ],
  },
  "product/broadcasts": {
    kind: "product",
    title: "Broadcasts",
    eyebrow: "Beta",
    lede: "Contacts, segments and topics for the product updates that sit next to your transactional mail.",
    hue: "mail",
    icon: "broadcast",
    graphic: "field",
    chapters: [
      {
        label: "Audience",
        title: "Contacts, segments, topics.",
        muted: "One place.",
        body: "Keep your audience next to your sending domains, and let people choose the topics they want to hear about.",
      },
    ],
    terms: [
      { term: "Contacts", body: "Import, export and manage contacts per workspace." },
      { term: "Segments", body: "Target the people a message is for." },
      {
        term: "Topics",
        body: "Preference-based unsubscribes instead of all-or-nothing.",
      },
      {
        term: "Suppressions",
        body: "Shared with transactional, so a complaint is honoured everywhere.",
      },
    ],
    cards: [{ title: "Beta", body: "Available in the console, still changing." }],
  },
  "product/deliverability": {
    kind: "product",
    title: "Deliverability",
    eyebrow: "Deliverability",
    lede: "Aligned authentication from the first send, suppression lists, complaint guards, and reputation watched on every domain.",
    hue: "deliver",
    icon: "shield",
    graphic: "gauge",
    chapters: [
      {
        label: "Alignment",
        title: "Aligned from the first record.",
        muted: "Both of them.",
        body: "DKIM aligns with your From domain from the first send, and SPF aligns once the return path is on your domain. Google's bulk-sender rules are satisfied either way.",
      },
      {
        label: "Reputation",
        title: "Watched, not hoped for.",
        muted: "Every domain.",
        body: "i10 tracks reputation findings and daily sending health per tenant, pauses before a provider does, and tells the owner why.",
      },
    ],
    terms: [
      { term: "Suppression lists", body: "Per workspace, with an API and an export." },
      {
        term: "Complaint guard",
        body: "A complaint suppresses the address before the next send.",
      },
      {
        term: "Risk engine",
        body: "Rules that hold abusive workspaces before they hurt everyone else.",
      },
      { term: "Sending health", body: "Daily snapshots per domain in the console." },
    ],
    cards: [
      { title: "SPF", body: "include:_spf.i10.tech" },
      { title: "DKIM", body: "Your key, your selector" },
      { title: "DMARC", body: "Passes on alignment" },
      { title: "Bounces", body: "Handled and suppressed" },
    ],
  },

  "legal/privacy": legal(
    "Privacy policy",
    "How i10 collects, uses and protects personal data.",
    [
      "Who we are",
      "What we collect",
      "How we use it",
      "Where it is stored",
      "Your rights",
      "Contact",
    ],
  ),
  "legal/terms": legal(
    "Terms of service",
    "The agreement between you and i10 for using the service.",
    [
      "Accounts",
      "Acceptable use",
      "Fees and billing",
      "Service levels",
      "Liability",
      "Termination",
    ],
  ),
  "legal/dpa": legal(
    "Data processing agreement",
    "How i10 processes personal data on your behalf under the GDPR.",
    [
      "Scope",
      "Processing instructions",
      "Security measures",
      "Subprocessors",
      "International transfers",
      "Audits",
    ],
  ),
  "legal/aup": legal(
    "Acceptable use policy",
    "What you may and may not send through i10.",
    ["Permitted use", "Prohibited content", "Consent and unsubscribes", "Enforcement"],
  ),
  "legal/subprocessors": legal(
    "Subprocessors",
    "The third parties that process data for i10.",
    [
      "Infrastructure",
      "Email delivery",
      "Authentication",
      "Billing",
      "Changes to this list",
    ],
  ),
  "legal/cookies": legal("Cookie policy", "The cookies i10's websites set, and why.", [
    "Essential cookies",
    "Session cookies",
    "Analytics",
    "Your choices",
  ]),

  "compare/resend": {
    kind: "compare",
    title: "i10 vs Resend",
    them: "Resend",
    lede: "i10 is Resend-compatible on purpose. Here is what is the same, and what i10 adds.",
    rows: [
      { label: "API shape", i10: "Resend-compatible", them: "Resend API" },
      { label: "Records to start", i10: "1 (DKIM)", them: "3" },
      { label: "Mailboxes on your domain", i10: "Yes", them: "No" },
      { label: "Data region", i10: "EU (Frankfurt)", them: "Multi-region" },
      { label: "Templates from GitHub", i10: "Yes", them: "To verify" },
    ],
  },
  "compare/postmark": {
    kind: "compare",
    title: "i10 vs Postmark",
    them: "Postmark",
    lede: "A draft comparison. It will be completed and fact-checked before publishing.",
    rows: [
      { label: "Resend-compatible API", i10: "Yes", them: "To verify" },
      { label: "Mailboxes on your domain", i10: "Yes", them: "To verify" },
      { label: "EU data region", i10: "Yes", them: "To verify" },
    ],
  },
  "compare/sendgrid": {
    kind: "compare",
    title: "i10 vs SendGrid",
    them: "SendGrid",
    lede: "A draft comparison. It will be completed and fact-checked before publishing.",
    rows: [
      { label: "Resend-compatible API", i10: "Yes", them: "To verify" },
      { label: "Mailboxes on your domain", i10: "Yes", them: "To verify" },
      { label: "EU data region", i10: "Yes", them: "To verify" },
    ],
  },
  "compare/google-workspace": {
    kind: "compare",
    title: "i10 vs Google Workspace",
    them: "Google Workspace",
    lede: "For teams who want their product mail and their people's mail on one domain, with one bill. Draft.",
    rows: [
      { label: "Transactional API", i10: "Yes", them: "To verify" },
      { label: "Mailboxes", i10: "Yes", them: "Yes" },
      { label: "Developer-first console", i10: "Yes", them: "To verify" },
    ],
  },

  developers: {
    kind: "simple",
    title: "Developers",
    eyebrow: "SDKs",
    lede: "First-party packages for Node and Next.js, and a REST API for everything else.",
    variant: "grid",
    blocks: [
      {
        title: "@i10/node",
        meta: "bun add @i10/node",
        body: "The SDK. Zero runtime dependencies, typed errors with a computed retryable flag.",
      },
      {
        title: "@i10/next",
        meta: "bun add @i10/next",
        body: "A cached server client and a Standard Webhooks route handler for the App Router.",
      },
      {
        title: "REST API",
        meta: "api.i10.tech",
        body: "Bearer auth, JSON in and out, the same shapes as Resend.",
      },
      {
        title: "OpenAPI",
        meta: "docs.i10.tech/api",
        body: "The full reference, generated from the wire contract.",
      },
    ],
  },
  blog: {
    kind: "simple",
    title: "Blog",
    eyebrow: "Engineering notes",
    lede: "Notes from building an email platform, most of them about the thing that broke.",
    variant: "list",
    blocks: [
      {
        title: "Why SPF names us with an include, never an address",
        meta: "Deliverability · Draft",
        body: "One include lets us change relays without asking anyone to touch DNS again.",
      },
      {
        title: "Sealing message bodies into packs",
        meta: "Storage · Draft",
        body: "Why the only copy of a message is never the one in flight.",
      },
      {
        title: "The first connection to a ClusterIP is refused",
        meta: "Infrastructure · Draft",
        body: "A race that only showed up once our images started in milliseconds.",
      },
      {
        title: "Render once, fill on send",
        meta: "Templates · Draft",
        body: "How template sends cost what plain sends do.",
      },
    ],
  },
  customers: {
    kind: "simple",
    title: "Customers",
    eyebrow: "Customers",
    lede: "i10 is new. The first teams sending with it will be here, with their permission and in their words.",
    variant: "grid",
    blocks: [
      {
        title: "Your team here",
        body: "Sending with i10 and happy to talk about it? We would love to tell your story.",
      },
      {
        title: "Migrating from Resend?",
        body: "Tell us what you are sending and we will help you move it.",
      },
    ],
  },
  security: {
    kind: "simple",
    title: "Security",
    eyebrow: "Security",
    lede: "How i10 protects the mail it sends and the data it keeps.",
    variant: "grid",
    blocks: [
      {
        title: "Sealed bodies",
        body: "Message bodies are sealed into per-workspace packs and only released from Postgres after a read-back.",
      },
      {
        title: "EU region",
        body: "Mail is relayed through eu-central-1, Frankfurt. Data stays in the EU.",
      },
      {
        title: "Key hygiene",
        body: "API keys are stored as SHA-256 hashes, prefixed for secret scanners, and revoked immediately.",
      },
      {
        title: "Input guards",
        body: "Header injection is refused at the contract and again in the MIME builder.",
      },
      {
        title: "Isolation",
        body: "A default-deny network policy, row-level security in Postgres, and separate credentials per service.",
      },
      {
        title: "Disclosure",
        body: "Found something? Email security@i10.tech. We reply to every report.",
      },
    ],
  },
  about: {
    kind: "simple",
    title: "About",
    eyebrow: "Company",
    lede: "i10 is i + 10 letters: integration. An email platform for developers, with mailboxes for everyone else.",
    variant: "list",
    blocks: [
      {
        title: "Why",
        body: "Email is the one API every product needs and nobody wants to own. We think it should feel as good to use as the rest of your stack.",
      },
      {
        title: "How",
        body: "Resend-compatible on purpose, EU-hosted by design, and honest about what is not built yet.",
      },
      { title: "Where", body: "Built in the open from the European Union." },
    ],
  },
  careers: {
    kind: "simple",
    title: "Careers",
    eyebrow: "Careers",
    lede: "There are no open roles right now. If i10 is the kind of thing you want to build, say hello anyway.",
    variant: "list",
    blocks: [
      {
        title: "No open roles",
        meta: "Check back soon",
        body: "Send a note to hello@i10.tech with what you would want to work on.",
      },
    ],
  },
  contact: {
    kind: "simple",
    title: "Contact",
    eyebrow: "Contact",
    lede: "Real people, real inboxes - on i10, naturally.",
    variant: "grid",
    blocks: [
      {
        title: "Sales",
        meta: "sales@i10.tech",
        body: "Volume pricing, dedicated IPs and Enterprise terms.",
        href: "mailto:sales@i10.tech",
      },
      {
        title: "Support",
        meta: "support@i10.tech",
        body: "Something not working? We answer every message.",
        href: "mailto:support@i10.tech",
      },
      {
        title: "Security",
        meta: "security@i10.tech",
        body: "Responsible disclosure goes straight to the engineers.",
        href: "mailto:security@i10.tech",
      },
      {
        title: "Hello",
        meta: "hello@i10.tech",
        body: "Anything else. Press, partnerships, kind words.",
        href: "mailto:hello@i10.tech",
      },
    ],
  },

  changelog: {
    kind: "changelog",
    title: "Changelog",
    eyebrow: "Changelog",
    lede: "What shipped, when, and why it matters. Taken straight from the repository.",
  },
  status: {
    kind: "status",
    title: "Status",
    eyebrow: "Status",
    lede: "Live health of the i10 API, measured from this page every time it loads.",
  },
  brand: {
    kind: "brand",
    title: "Brand",
    eyebrow: "Brand",
    lede: "The i10 mark, the colours and the type. Use them well, and never stretch the mark.",
  },
  "migrate/resend": {
    kind: "migrate",
    title: "Migrate from Resend",
    eyebrow: "Migrate",
    lede: "Change one import. The transport is identical on purpose, so your call sites do not change.",
  },
}

export const pageSlugs = () => Object.keys(PAGES)
