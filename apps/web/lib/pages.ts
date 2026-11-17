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

export interface DocTable {
  columns: string[]
  /** One cell per column. */
  rows: string[][]
}

export interface DocPage {
  kind: "legal"
  title: string
  lede: string
  updated: string
  /** A section shows its paragraphs, then its table, then `after`. */
  sections: {
    title: string
    paragraphs: string[]
    table?: DocTable
    after?: string[]
  }[]
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

  "legal/privacy": {
    kind: "legal",
    title: "Privacy policy",
    lede: "What personal data i10 collects, why, how long it is kept, who receives it, and the rights you have.",
    updated: "16 Nov 2026",
    sections: [
      {
        title: "About this policy",
        paragraphs: [
          "This policy explains how i10 collects and uses personal data when you visit our websites, create an account, or use the service. It names the data we process, why we process it, how long we keep it, who receives it, and the rights you have and how to use them.",
          "We collect only the data we need to run the service. We do not sell personal data, and we do not use it for advertising.",
        ],
      },
      {
        title: "Definitions",
        paragraphs: [
          '"i10", "we" and "us" mean the operator named in the next section.',
          '"Service" means the i10 email API, the console, hosted mailboxes, and our websites at i10.tech and its subdomains.',
          '"Customer" means the person or organisation that holds an i10 workspace. "You" means a visitor to our websites or a person with an i10 account.',
          '"Customer content" means the messages, recipient addresses, attachments, templates and mailbox content that a Customer sends, receives or stores through the Service.',
          '"Personal data" means any information about an identified or identifiable person. "GDPR" means Regulation (EU) 2016/679.',
        ],
      },
      {
        title: "Who is responsible for your data",
        paragraphs: [
          "i10 is operated by Mohamed Abdelkhalek, Building 16, Narges Buildings, 5th Settlement, New Cairo 11835, Egypt. Contact: privacy@i10.tech.",
          "For the data described in this policy, i10 is the controller. That is the data of visitors and of people with an account.",
          "For Customer content, the Customer is the controller and i10 is a processor. i10 handles that data only on the Customer's instructions, under the data processing agreement. If you received an email that a Customer sent through i10, or you use a mailbox that a Customer gave you, contact that Customer first about your data. We help them answer you.",
        ],
      },
      {
        title: "What we collect, why, and for how long",
        paragraphs: [
          "We receive most of this data from you, when you sign up and use the Service. We receive some from the owner of a workspace who invites you, from your organisation's identity provider when you use single sign-on, and from the lookup services named in this policy.",
          "You must give us an email address and sign-in details to have an account. Without them we cannot provide the Service. Everything else you give us is optional unless the console says it is required.",
        ],
        table: {
          columns: ["Purpose", "Data", "Legal basis", "How long we keep it"],
          rows: [
            [
              "Create your account and sign you in",
              "Name, email address, password, two-factor settings, passkeys, sessions, profile photo, single sign-on identifiers",
              "Contract",
              "Until you delete your account. We then delete it within 90 days",
            ],
            [
              "Run your workspace",
              "Workspace name, members and roles, domains, API key records, settings",
              "Contract",
              "Until the workspace is deleted. We then delete it within 90 days",
            ],
            [
              "Billing",
              "Plan, usage counts, payment status. When paid plans start, our payment provider (Polar) will hold your billing name, address and payment details",
              "Contract and legal obligation",
              "Usage and billing records: as long as tax and accounting law requires",
            ],
            [
              "Keep accounts secure and prevent abuse",
              "IP address, browser details, a device identifier, the country and network of your connection, time zone and language, sign-in history",
              "Legitimate interest: protecting the Service, our customers and the people who receive their mail",
              "IP address and browser details: 90 days. Country, network and device identifier: until the account is deleted. Risk records: 180 days",
            ],
            [
              "Operate and debug the API",
              "API request logs with IP address and country, error reports",
              "Legitimate interest: running a reliable service",
              "Request logs: 30 days. Error reports: up to 90 days",
            ],
            [
              "Send you service messages",
              "Email address, name",
              "Contract",
              "As long as you have an account",
            ],
            [
              "Answer your questions",
              "Your email address and what you write to us",
              "Legitimate interest: answering you",
              "3 years after the last message",
            ],
            [
              "Stop closed accounts from returning",
              "Email address, domain, network, device identifier and the reason for the closure",
              "Legitimate interest: stopping abuse and protecting the people who receive mail",
              "3 years after the account is closed",
            ],
            [
              "Protect our legal rights",
              "The data needed for the claim",
              "Legitimate interest: defending legal claims",
              "As long as the claim can be brought",
            ],
          ],
        },
      },
      {
        title: "Customer content",
        paragraphs: [
          "We process Customer content to deliver it, store it and show it in the console, and for nothing else, with one exception described in the next section: we analyse outgoing mail to detect abuse.",
          "Sent messages and their logs are kept for the retention period of the Customer's plan: 3 days on the Free plan and 30 days on the Pro and Scale plans, or the period agreed on a custom plan. Mailbox content is kept until the Customer deletes it. A deleted mailbox is removed for good after 30 days.",
          "Addresses on a suppression list (people who unsubscribed, complained, or whose address bounced) are kept until the Customer removes them or the workspace is deleted. This is how we make sure they are not mailed again.",
          "Database backups are kept for 30 days, so deleted data can remain in a backup for up to 30 days more.",
        ],
      },
      {
        title: "Abuse prevention and automated decisions",
        paragraphs: [
          "Email is abused for phishing and spam, and one abusive sender harms every other sender. So we check accounts and outgoing mail automatically.",
          "We look at sign-up and sign-in signals (IP address, network, country, device identifier), at sending behaviour (bounces, complaints, volume), and at outgoing messages. For a message we check the links against lists of harmful sites, and an automated model may read the subject, the text, the sender name and the link hosts to estimate whether the message is phishing or spam. Recipient addresses are not sent to that model. The provider of the model may not use the content to train models.",
          "These checks produce a risk score. A rule adds points when a signal matches, and a score above a fixed limit pauses sending for the workspace. While sending is paused, new messages are refused and queued messages are cancelled, until a person decides. A pause is not a final decision: a person at i10 reviews every pause within 24 hours. Only a person can close an account. We tell the workspace owners when sending is paused and which rule the decision rests on.",
          "You can ask for a human review, give your view and contest the decision by writing to appeals@i10.tech.",
        ],
      },
      {
        title: "Who receives your data",
        paragraphs: [
          "We share personal data with the companies that help us run the Service, such as hosting, email delivery and sign-in providers, and, when paid plans start, a payment provider. Each one is named on the subprocessors page, with the data it receives and where it processes it. They may use the data only to provide their service to us.",
          "We may also share data with our professional advisers when we need to defend our rights; with public authorities when the law requires it; and with a buyer or successor if i10 is sold or reorganised, under a duty of confidentiality.",
          "Services that a Customer connects itself, such as a DNS provider, an identity provider or a webhook endpoint, receive data on the Customer's instruction.",
        ],
      },
      {
        title: "Where your data is processed",
        paragraphs: [
          "Mail data is stored in the European Union: we send through Frankfurt and store in Germany and in European object storage.",
          "Account and sign-in data is processed in the United States by our sign-in provider. Some checks also run in the United States or on a global network: IP address lookups, link checks and the automated analysis of messages. i10 itself is operated from Egypt, and we access the systems from there to run and support the Service.",
          "When personal data leaves the European Economic Area, we rely on a safeguard that the GDPR accepts: the provider's certification under the EU-US Data Privacy Framework where it has one, and otherwise the European Commission's standard contractual clauses. You can ask us at privacy@i10.tech for a copy of the safeguard that applies to a provider.",
        ],
      },
      {
        title: "Your rights",
        paragraphs: [
          "You have these rights over your personal data. Access: ask whether we process your data and get a copy. Correction: have wrong or incomplete data corrected. Deletion: have your data deleted in the cases the law provides. Restriction: have us pause the use of some data. Portability: receive your data in a usable format, to move it elsewhere. Where we rely on your consent, you can withdraw it at any time.",
          "You also have the right to object, at any time, to processing that rests on our legitimate interest, including the abuse checks described above. We then stop, unless we have compelling reasons to continue or need the data for legal claims.",
          "The law sets conditions and limits for some of these rights.",
          "To use a right, write to privacy@i10.tech. We answer within one month. We may ask you to confirm your identity if we are not sure who is writing. You can also change most account data, and delete your account, in the console.",
          "You can complain to the data protection authority of the country where you live or work. We would like the chance to solve the problem first, so please write to us.",
        ],
      },
      {
        title: "Cookies",
        paragraphs: [
          "Our websites use cookies and similar storage to sign you in, to keep accounts secure and to remember your settings. The cookie policy lists each one. We do not use advertising cookies. If we add analytics, we ask for your consent first.",
        ],
      },
      {
        title: "Security",
        paragraphs: [
          "We use technical and organisational measures to protect your data against unauthorised access, loss, change or disclosure. Connections to i10 are encrypted. Message bodies and attachments held in object storage are encrypted, and so are database backups and the secrets we hold for you, such as signing keys. Access to production systems is limited to the people who need it. We review these measures as risks change.",
          "No system is perfectly secure. If a breach affects your personal data, we tell you and the authorities as the law requires.",
        ],
      },
      {
        title: "Children",
        paragraphs: [
          "The Service is for businesses and developers. It is not meant for anyone under 18, and we do not knowingly collect their data.",
        ],
      },
      {
        title: "Changes to this policy",
        paragraphs: [
          "We may change this policy. The date at the top shows the latest version. If a change is important, we tell account holders by email before it takes effect.",
        ],
      },
      {
        title: "Contact",
        paragraphs: [
          "Questions and requests about your personal data: privacy@i10.tech. By post: Mohamed Abdelkhalek, Building 16, Narges Buildings, 5th Settlement, New Cairo 11835, Egypt.",
        ],
      },
    ],
  },
  "legal/terms": {
    kind: "legal",
    title: "Terms of service",
    lede: "The agreement between you and i10 for using the service.",
    updated: "16 Nov 2026",
    sections: [
      {
        title: "This agreement",
        paragraphs: [
          'These terms of service (the "Terms") are an agreement between you and Mohamed Abdelkhalek, Building 16, Narges Buildings, 5th Settlement, New Cairo 11835, Egypt, who operates i10 ("i10", "we", "us").',
          'You accept the Terms when you create an account or use the Service. If you use the Service for a company or another organisation, you accept the Terms for it, and you confirm that you have the authority to do so. "You" and "Customer" mean the person or organisation that accepts the Terms.',
          "The Service is for businesses and developers. It is not for consumers. You must be at least 18 years old.",
          "The acceptable use policy and the data processing agreement are part of the Terms. If you have a separate written agreement signed with us, that agreement prevails where it differs from the Terms.",
        ],
      },
      {
        title: "Definitions",
        paragraphs: [
          '"Service" means the i10 email API, the console, templates and broadcasts, hosted mailboxes, and our websites at i10.tech and its subdomains.',
          '"Customer content" means the messages, recipient addresses, attachments, templates and mailbox content that you send, receive or store through the Service.',
          '"Workspace" means the account of a Customer in the Service, with its members, domains and data.',
          '"AUP" means the acceptable use policy at i10.tech/legal/aup. Where the AUP says "account", it means a Workspace. "DPA" means the data processing agreement at i10.tech/legal/dpa.',
          '"Plan" means the level of Service you chose, free or paid, with the limits and prices shown on the pricing page or agreed with us in writing.',
        ],
      },
      {
        title: "Your account",
        paragraphs: [
          "Give us accurate information when you sign up and keep it up to date. This includes the email address where we send notices.",
          "Keep your passwords and API keys secret. You are responsible for everything that happens in your Workspace and with your keys, including what your members and your own customers do, until you tell us that an account or a key may be compromised.",
          "A person or an organisation may have one free Workspace. Do not open more free Workspaces to get around a limit.",
        ],
      },
      {
        title: "The Service",
        paragraphs: [
          "We give you a right to use the Service during the term of the Terms, within the limits of your Plan. The right is not exclusive and you cannot transfer it.",
          "We improve the Service all the time, and it will change. We may add, change or remove features. If we remove a feature that paid Customers rely on, we give at least 30 days' notice, unless we must act sooner for security or legal reasons.",
          "Some features are marked as beta or preview. They are offered as they are, without any commitment. They may change or end at any time, and you should not rely on them for important work.",
        ],
      },
      {
        title: "Your responsibilities",
        paragraphs: [
          "You must follow the AUP. It says what you may send, what you may not, and what we do when the rules are broken.",
          "You are responsible for your Customer content and for the people you send it to. In particular: you have the right to use each address you send to; you have the consent of the recipient where the law requires it, and you keep proof of it and show it to us when we ask; and your messages follow the laws that apply to you and to your recipients, such as anti-spam, privacy and consumer laws.",
          "Do not send payment card numbers, health records or other specially regulated data through the Service unless we agree in writing. You confirm that no sanctions or export rules forbid us to provide the Service to you.",
          "If your product sends email for your own customers, you are responsible for their use of the Service as for your own.",
          "You must not copy, resell or reverse engineer the Service, get around its limits or its security, or use it to build a competing service, except where the law gives you a right that cannot be removed by contract.",
        ],
      },
      {
        title: "Delivery and limits",
        paragraphs: [
          "We send your email to the receiving mail servers. We do not control those servers or the networks between us. We do not guarantee that a message is delivered, that it arrives at a certain time, or that it reaches the inbox and not the spam folder.",
          "Your Plan has limits, such as the number of messages, domains and mailboxes. We may also set sending limits for a new or risky Workspace, and raise them as it builds a good record.",
          "The AUP sets the bounce and complaint rates you must stay under.",
          "The IP addresses and sending infrastructure we use are ours or our providers'. Where a Plan includes a dedicated IP address, it stays ours, you get no right to it, and we may change it when needed.",
        ],
      },
      {
        title: "Abuse checks and suspension",
        paragraphs: [
          "We may check Workspaces and Customer content to detect phishing, spam, malware and other abuse, and to protect the people who receive your mail and the delivery of other Customers. These checks are automated and include machine-learning models that read message content. We have the right to make these checks, but not the duty: we do not review all content, and you remain responsible for yours. Automated checks can make mistakes. We do not promise that they find all abuse or that they never stop lawful mail. The subprocessors page names the services that do this analysis.",
          "If we believe a rule of the AUP is broken, we may limit, hold, suspend or close a Workspace, as the AUP describes. We choose the mildest step that stops the harm, we tell you which rule the decision rests on, and you can appeal as the AUP describes, at appeals@i10.tech. An automated check can slow or pause sending. Only a person can close a Workspace.",
          "We may also suspend the Service without notice when this is needed to stop harm to recipients, to other Customers or to the Service, or when the law or one of our providers requires it. We tell you as soon as we can.",
        ],
      },
      {
        title: "Fees and payment",
        paragraphs: [
          "The Free plan costs nothing. We may change or end the Free plan, or its limits, with 30 days' notice. Paid Plans cost the price shown when you subscribe, plus any usage above what the Plan includes, at the rate shown on the pricing page.",
          'Payments are handled by Polar Software, Inc. ("Polar"), which acts as the merchant of record. This means Polar sells you the subscription, takes the payment, charges the taxes that apply, and sends you the invoice. Polar\'s terms apply to the payment. Card details go to Polar and never reach us.',
          "A paid Plan renews automatically for the same period, monthly or yearly, until you cancel. You can cancel at any time in the console. A cancellation or a downgrade takes effect at the end of the period you paid for. An upgrade takes effect at once.",
          "Fees already paid are not refunded, except where the Terms say so or the law requires it. A refund goes through Polar.",
          "A lower Plan can have a shorter retention period and fewer mailboxes. Moving to it can delete older messages and logs and turn off mailboxes. Export what you need first.",
          "We may change prices. For a paid Plan we tell you by email at least 30 days before, and the new price applies from your next renewal. If you do not agree, you can cancel before that renewal.",
          "If a payment fails, we may move the Workspace to the Free plan, with its limits, after telling you.",
        ],
      },
      {
        title: "Your content and data",
        paragraphs: [
          "Your Customer content is yours. You give us the right to host, copy, send, display and process it only as needed to provide the Service to you, to keep the Service secure, and to follow the law.",
          "Where we process personal data for you, the DPA applies. The privacy policy explains how we handle the data for which we are responsible ourselves, such as your account data.",
          "We keep messages sent through the API, and their logs, for the retention period of your Plan and then delete them. We keep mailbox content until you delete it, and remove a deleted mailbox for good after 30 days. Backups keep copies for up to 30 days more. We may keep the records of confirmed abuse that the AUP describes, and we may use data about how the Service is used, which identifies neither you nor any person, to run and improve the Service.",
          "The Service is not a backup or an archive: keep your own copy of anything you need. Our backups exist to recover the Service after a failure, and not to restore data that one Customer deleted.",
          "You can export your data in the console and through the API while your Workspace is open.",
        ],
      },
      {
        title: "Our rights and your feedback",
        paragraphs: [
          "The Service, its software, its design and the i10 name and logos belong to us or to our licensors. The Terms give you no right to them other than the right to use the Service.",
          "If you send us ideas or feedback, we may use them freely and without payment.",
        ],
      },
      {
        title: "Confidentiality",
        paragraphs: [
          "Each of us may receive information from the other that is not public, such as security details or business plans. The one who receives it uses it only for the purposes of the Terms, protects it with reasonable care, and does not share it, except with staff and advisers who need it and are bound to keep it confidential.",
          "This does not apply to information that is public without a breach, that the receiver already had or developed alone, or that the law requires it to disclose.",
        ],
      },
      {
        title: "Availability and support",
        paragraphs: [
          "We work to keep the Service available at all times, but we do not promise a level of availability on the plans you can buy on our website. A service level agreement, with service credits, is offered only as part of a signed agreement with our sales team.",
          "We may interrupt the Service for maintenance, and we try to do so at quiet times. The status page shows the current state.",
          "Support is by email, at the address shown in the console, and by the other channels that your Plan lists. We answer as fast as we reasonably can.",
        ],
      },
      {
        title: "Warranties",
        paragraphs: [
          "We provide the Service with reasonable care and skill.",
          'Apart from that, and as far as the law allows, the Service is provided "as is" and "as available". We give no other warranty, express or implied, including warranties of merchantability, fitness for a particular purpose and non-infringement. We do not warrant that the Service will be free of interruptions or errors.',
        ],
      },
      {
        title: "Liability",
        paragraphs: [
          "As far as the law allows, neither of us is liable to the other for lost profit, lost revenue, lost business, lost goodwill or lost data, or for any indirect, special or consequential damage.",
          "As far as the law allows, the total liability of each of us for all claims under the Terms together is limited to the fees you paid for the Service in the 12 months before the event that caused the claim, or 100 US dollars if that is more.",
          "We are not liable for a message that is lost, delayed, blocked or not delivered.",
          "These limits do not apply to your duty to pay fees, to your duties under the next section, to damage caused on purpose or by gross negligence, to fraud, or to any liability that the law does not allow to be limited.",
        ],
      },
      {
        title: "Claims by others",
        paragraphs: [
          "You defend us against any claim by a third party, and pay the damages, fines and reasonable costs that result, where the claim arises from your Customer content, from mail sent from your Workspace, or from your breach of the AUP or of the law. This includes the charges and penalties that our providers put on us because of your breach.",
          "We tell you promptly about such a claim, let you lead the defence, and help you at your cost. You do not settle a claim in a way that puts a duty on us without our agreement.",
        ],
      },
      {
        title: "Term and ending",
        paragraphs: [
          "The Terms apply from when you accept them until your Workspace is closed.",
          "You can close your Workspace at any time in the console. Closing takes effect at once: sending stops, and a paid subscription is cancelled without a refund for the rest of the period.",
          "We may end the Terms with 30 days' notice by email. If we do this without a breach on your side, we refund the fees paid in advance for the time after the end.",
          "We may end the Terms at once, or suspend the Service, if you seriously breach the Terms or the AUP, if you do not pay, or if the law requires it.",
          "When the Terms end, your right to use the Service ends, and we delete your data as the DPA describes. Export what you need before you close your Workspace. If we close your Workspace for a breach, we give you a reasonable chance to export your data, unless the law or the safety of others prevents it. The sections that by their nature should continue, such as those on fees owed, confidentiality, liability and claims by others, continue after the end.",
        ],
      },
      {
        title: "Changes to the Terms",
        paragraphs: [
          "We may change the Terms. For an important change, we tell you by email at least 30 days before it takes effect, unless a shorter time is needed for legal or security reasons. Other changes take effect when we publish them here. The date at the top shows the latest version.",
          "If you do not agree with a change, you can close your Workspace before it takes effect. If you continue to use the Service after that date, you accept the change.",
        ],
      },
      {
        title: "Law and disputes",
        paragraphs: [
          "The Terms are governed by the laws of the Arab Republic of Egypt. The courts of Cairo, Egypt, have exclusive jurisdiction over any dispute about the Terms. The DPA names a different law and different courts for the standard contractual clauses.",
          "Before going to court, each of us writes to the other and tries in good faith for 30 days to solve the dispute. Our address for this is legal@i10.tech. This does not stop either of us from asking a court for urgent protection, and it does not apply to unpaid fees.",
        ],
      },
      {
        title: "General",
        paragraphs: [
          "The Terms, with the AUP and the DPA, are the whole agreement between us about the Service. If these documents conflict, the DPA prevails on data protection matters, and otherwise the Terms prevail over the AUP. Where the standard contractual clauses in the DPA apply, they prevail over everything else.",
          "If a court finds part of the Terms invalid, the rest stays in force. If we do not enforce a right at once, we do not give it up.",
          "You may not transfer the Terms to someone else without our written agreement. We may transfer them to a company that takes over the Service, including a company set up to run i10, and we will tell you if we do.",
          "Neither of us is liable for a failure caused by events beyond reasonable control, such as a failure of the internet or of a provider, a natural disaster, or an act of a government. This does not excuse a duty to pay.",
          "We send notices to the email addresses of the owners of your Workspace. A notice by email counts as received on the day after we send it. You send notices to legal@i10.tech.",
        ],
      },
      {
        title: "Contact",
        paragraphs: [
          "Questions about the Terms: legal@i10.tech. By post: Mohamed Abdelkhalek, Building 16, Narges Buildings, 5th Settlement, New Cairo 11835, Egypt.",
        ],
      },
    ],
  },
  "legal/dpa": {
    kind: "legal",
    title: "Data processing agreement",
    lede: "How i10 processes personal data for you under the GDPR. It is part of the terms of service.",
    updated: "16 Nov 2026",
    sections: [
      {
        title: "Parties and scope",
        paragraphs: [
          'This data processing agreement (the "DPA") is between the Customer that accepts the i10 terms of service (the "Terms") and Mohamed Abdelkhalek, Building 16, Narges Buildings, 5th Settlement, New Cairo 11835, Egypt, who operates i10 ("i10"). It is part of the Terms and takes effect when the Customer accepts them. No signature is needed. A Customer that needs a signed copy can ask for one at legal@i10.tech.',
          "The DPA applies when i10 processes Personal Data for the Customer while providing the Service, and data protection law applies to that processing. It implements Article 28(3) of the GDPR.",
          "The DPA does not cover the data for which i10 is itself a controller, such as account, billing and security data. The privacy policy describes that data.",
        ],
      },
      {
        title: "Definitions",
        paragraphs: [
          '"Applicable Data Protection Law" means the GDPR, the UK GDPR, the Swiss Federal Act on Data Protection, and any other data protection law that applies to the processing under this DPA.',
          '"GDPR" means Regulation (EU) 2016/679.',
          '"Personal Data" means any information about an identified or identifiable person that is part of Customer content and that i10 processes for the Customer under this DPA.',
          '"Personal Data Breach" has the meaning given in Article 4(12) of the GDPR.',
          '"Sub-processor" means a third party that i10 engages to process Personal Data for the Customer.',
          '"SCCs" means the standard contractual clauses approved by Commission Implementing Decision (EU) 2021/914.',
          '"Service", "Customer" and "Customer content" have the meaning given in the Terms. Other terms have the meaning given in the GDPR.',
        ],
      },
      {
        title: "Roles and instructions",
        paragraphs: [
          "The Customer is the controller of the Personal Data and i10 is its processor. Where the Customer is itself a processor for its own customers, i10 is a sub-processor, and the Customer confirms that its instructions to i10 are authorised by the controller.",
          "i10 processes the Personal Data only on the documented instructions of the Customer, including for transfers to a third country, unless Union or Member State law that applies to i10 requires other processing. In that case i10 tells the Customer before the processing, unless that law forbids it. If an authority outside the European Economic Area asks i10 for Personal Data, i10 tells the Customer where the law allows, and challenges a request it believes is unlawful.",
          "The Customer's instructions are this DPA, the Terms, and what the Customer does through the API, the console and its settings. i10 tells the Customer promptly if it believes an instruction infringes Applicable Data Protection Law, and may pause that instruction until the question is solved.",
          "i10 does not sell the Personal Data and does not use it for advertising or to train models. i10 processes Customer content to detect and prevent abuse of the Service, as the Terms and the acceptable use policy describe. This is part of providing a secure Service and is an instruction of the Customer. i10 may create statistics from the use of the Service that do not identify the Customer or any person.",
          "The Customer is responsible for the lawfulness of the Personal Data and of its instructions. This includes having a legal basis to send each message and the consent of recipients where the law requires it.",
        ],
      },
      {
        title: "Confidentiality",
        paragraphs: [
          "i10 makes sure that every person it authorises to process the Personal Data is bound by a duty of confidentiality. The duty continues after that person's work for i10 ends and after this DPA ends.",
        ],
      },
      {
        title: "Security",
        paragraphs: [
          "i10 implements and maintains the technical and organisational measures in Annex 2, to give a level of security appropriate to the risk.",
          "i10 may change these measures over time, provided that the overall level of security does not go down.",
        ],
      },
      {
        title: "Sub-processors",
        paragraphs: [
          "The Customer gives i10 a general authorisation to engage Sub-processors. The Sub-processors at any time are those listed as in use on the subprocessors page, which is Annex 3 of this DPA. That page also names services that receive no Personal Data, and says so. They are not Sub-processors.",
          "i10 updates the subprocessors page and emails the owners of the workspace at least 30 days before a new Sub-processor starts to process Personal Data.",
          "The Customer may object on reasonable data protection grounds within that period by writing to legal@i10.tech. The parties then look for a solution in good faith. If there is none, the Customer may close its workspace before the change takes effect, and i10 refunds the fees paid in advance for the time after closing.",
          "i10 may replace a Sub-processor sooner when that is needed to keep the Service secure or running. i10 then tells the Customer as soon as it can, and the Customer keeps the right to object and to close its workspace with the same refund.",
          "i10 binds each Sub-processor by a written contract to the same data protection duties that this DPA sets for i10. i10 remains responsible to the Customer for what its Sub-processors do.",
        ],
      },
      {
        title: "Requests from data subjects",
        paragraphs: [
          "If a person asks i10 directly to use a data protection right over Personal Data, i10 forwards the request to the Customer without undue delay, where it can identify the Customer, and does not answer it itself except to say that it has been forwarded.",
          "The Service gives the Customer the means to answer most requests: it can find, read and delete messages, contacts, suppressions and mailboxes in the console and through the API. Where the Customer cannot do this itself, i10 helps on request, as far as this is possible. i10 may charge for its reasonable time when the help goes beyond what the Service offers.",
        ],
      },
      {
        title: "Personal data breaches and other help",
        paragraphs: [
          "i10 tells the Customer about a Personal Data Breach without undue delay, and at the latest 72 hours after it becomes aware of it. The notice goes by email to the owners of the workspace. It describes, as far as i10 knows it at that time: what happened, the kinds and approximate numbers of people and records affected, the likely consequences, the measures taken or planned, and a contact for more information. i10 adds information as it becomes available.",
          "A notice of a breach is not an admission of fault or liability. The Customer is responsible for notifying its supervisory authority and the people concerned.",
          "i10 gives the Customer the information it reasonably needs for its own duties under Articles 32 to 36 of the GDPR, including data protection impact assessments and consultations with a supervisory authority, taking into account the nature of the processing and the information available to i10.",
        ],
      },
      {
        title: "Deletion and return",
        paragraphs: [
          "During the term, messages and their logs are deleted automatically at the end of the retention period of the Customer's plan. The Customer can export and delete Personal Data at any time in the console and through the API.",
          "When the Customer closes its workspace or the Terms end, i10 deletes the Personal Data within 90 days. The Customer chooses the return of its data by exporting it before it closes the workspace. For 30 days after the Terms end, the Customer may also ask legal@i10.tech to return the Personal Data that i10 still holds, in a common format. On request, i10 confirms the deletion in writing. Where a workspace is closed for a breach of the acceptable use policy, i10 gives the Customer a reasonable chance to export its data unless the law or the safety of others prevents it.",
          "Copies in backups are deleted when the backup expires, at most 30 days later. Until then they are protected and are not used for anything else.",
          "i10 may keep Personal Data where a law that applies to i10 requires it, and keeps the records described in the acceptable use policy that are needed to stop a closed account from returning. i10 protects that data and uses it only for that purpose.",
        ],
      },
      {
        title: "Information and audits",
        paragraphs: [
          "i10 makes available to the Customer the information needed to show that it meets its duties under this DPA and Article 28 of the GDPR. i10 holds no third-party security certification today. It answers reasonable written security questions and gives the Customer the documentation it has.",
          "If that information is not enough to show compliance, the Customer may audit i10, itself or through an independent auditor bound by confidentiality. An audit takes place at most once a year, with 30 days' written notice, during working hours, and in a way that does not disturb the Service or expose the data of other customers. The limit of once a year does not apply after a Personal Data Breach or when a supervisory authority requires an audit. The auditor may not be a competitor of i10.",
          "The Customer bears the cost of an audit it asks for. If the audit shows that i10 materially breached this DPA, i10 bears its own cost of the audit and corrects the breach. Where the SCCs apply, their Clause 8.9 prevails over this section.",
        ],
      },
      {
        title: "International transfers",
        paragraphs: [
          "i10 stores Customer content in the European Union, except the addresses and sign-in details of mailbox users, which the sign-in provider holds in the United States. i10 is operated from Egypt, and some Sub-processors process Personal Data outside the European Economic Area, as the subprocessors page shows. The Customer instructs i10 to make these transfers.",
          "Where the Customer transfers Personal Data that is subject to the GDPR to i10, the parties enter into the SCCs, which are part of this DPA. Module Two (controller to processor) applies where the Customer is a controller, and Module Three (processor to processor) where the Customer is a processor. Annex 4 completes the SCCs.",
          "For transfers subject to the UK GDPR, the UK International Data Transfer Addendum to the SCCs applies, completed with the information in Annex 4. i10 may end the UK Addendum as its Table 4 allows. For transfers subject to Swiss law, the SCCs apply with these changes: references to the GDPR include the Swiss Federal Act on Data Protection, the supervisory authority is the Swiss Federal Data Protection and Information Commissioner, and people in Switzerland may bring their claims in Switzerland.",
          "Where i10 transfers Personal Data to a Sub-processor outside the European Economic Area, it uses a safeguard that the GDPR accepts: an adequacy decision, including the EU-US Data Privacy Framework for a certified provider, or the SCCs.",
          "If the SCCs and the rest of this DPA conflict, the SCCs prevail.",
        ],
      },
      {
        title: "Liability",
        paragraphs: [
          "The liability of each party under this DPA is subject to the limits and exclusions in the Terms. Nothing in this DPA limits the rights of a data subject under the GDPR or the SCCs, or a liability that the SCCs do not allow to be limited.",
        ],
      },
      {
        title: "Term and order of precedence",
        paragraphs: [
          "This DPA applies for as long as i10 processes Personal Data for the Customer. The duties of confidentiality and deletion continue until the Personal Data is deleted.",
          "If this DPA and the Terms conflict on a data protection matter, this DPA prevails. The governing law and the courts named in the Terms apply to this DPA, except where the SCCs say otherwise.",
        ],
      },
      {
        title: "Annex 1: Description of the processing",
        paragraphs: [],
        table: {
          columns: ["Item", "Description"],
          rows: [
            [
              "Subject matter",
              "Providing the Service: an email API, templates and broadcasts, and hosted mailboxes.",
            ],
            [
              "Duration",
              "The term of the Terms, plus the time until deletion under this DPA.",
            ],
            [
              "Nature of the processing",
              "Receiving, storing, sending and delivering email; recording delivery events; hosting mailboxes; showing logs; automated analysis to detect abuse; backup; deletion.",
            ],
            [
              "Purpose",
              "To send, receive and store the Customer's email on its instructions, and to keep the Service secure and free of abuse.",
            ],
            [
              "Categories of personal data",
              "Email addresses and names of senders and recipients; message headers, subjects, bodies and attachments; contact lists and their fields; delivery, open and click events with time, and IP address and browser details where tracking is on; suppression lists; mailbox content; the addresses of mailbox users.",
            ],
            [
              "Special categories of data",
              "The Service is not designed for them. The Customer decides what its messages contain and should not send special categories of data, or data about criminal convictions, unless it has a legal basis and has protected the content suitably.",
            ],
            [
              "Categories of data subjects",
              "The people the Customer sends email to or receives email from: its customers, users, contacts and staff; and the users of its hosted mailboxes.",
            ],
            ["Frequency", "Continuous, for as long as the Customer uses the Service."],
            [
              "Retention",
              "Messages and logs: the retention period of the plan (3 days on Free, 30 days on Pro and Scale, or as agreed). Mailbox content: until the Customer deletes it; a deleted mailbox is removed after 30 days. Backups: 30 days.",
            ],
          ],
        },
      },
      {
        title: "Annex 2: Technical and organisational measures",
        paragraphs: [],
        table: {
          columns: ["Area", "Measures"],
          rows: [
            [
              "Encryption in transit",
              "Connections to the API, the console, the sign-in pages and hosted mailboxes use TLS. Connections from i10 to its Sub-processors use TLS. Outgoing mail is delivered with TLS when the receiving server supports it.",
            ],
            [
              "Encryption at rest",
              "Message bodies, attachments and mailbox export archives held in object storage are encrypted with AES-256-GCM. Each item has its own key, and that key is encrypted with a master key held apart from the data. Mailbox content in object storage is encrypted with AES-256-GCM. Database backups are encrypted with a key that the storage provider does not keep. Secrets that i10 holds for the Customer, such as DKIM private keys, webhook signing secrets and DNS credentials, are encrypted with a key derived for each workspace.",
            ],
            [
              "Key management",
              "Master keys are held in a secrets manager in wrapped form. They are not stored in the database or in object storage. The keys for secrets, message bodies and stored files can be rotated. API keys are stored only as hashes. Passwords are held by the sign-in provider.",
            ],
            [
              "Separation of customers",
              "Each workspace's data is separated in the database by row-level security. Encrypted items are bound to their workspace, so a value moved to another workspace does not open.",
            ],
            [
              "Access control",
              "Access to production systems is limited to the people who need it to run the Service, over a private network. The database and the queues are not reachable from the internet, and network policies limit which internal services can reach them.",
            ],
            [
              "Hosting",
              "Servers run in data centres in Germany operated by providers certified under ISO/IEC 27001. Customer content is stored in the European Union.",
            ],
            [
              "Backup and recovery",
              "The database is backed up every night, with continuous archiving of changes, to a separate storage provider. Backups are kept for 30 days.",
            ],
            [
              "Monitoring and abuse prevention",
              "Errors are monitored, and sensitive values are removed from error reports before they leave i10. Sending is monitored for abuse, with automated checks and human review.",
            ],
            [
              "Development",
              "Changes pass automated checks before release. The code is scanned for leaked secrets.",
            ],
            [
              "Data minimisation and deletion",
              "Messages and logs are deleted automatically at the end of the plan's retention period. IP addresses in security records are removed after 90 days.",
            ],
            [
              "People and organisation",
              "Everyone with access is bound by confidentiality. Sub-processors are bound by written contracts. i10 has a process to assess a security incident and to notify the Customer.",
            ],
          ],
        },
      },
      {
        title: "Annex 3: Sub-processors",
        paragraphs: [
          "The Sub-processors are those listed as in use on the subprocessors page at i10.tech/legal/subprocessors, with their purpose, the data they receive and their location. That page is updated as this DPA describes.",
        ],
      },
      {
        title: "Annex 4: Standard contractual clauses",
        paragraphs: ["The SCCs are completed as follows."],
        table: {
          columns: ["Item", "Choice"],
          rows: [
            [
              "Parties",
              "Data exporter: the Customer, with the contact details of its workspace. Data importer: i10, with the details at the top of this DPA and the contact legal@i10.tech.",
            ],
            ["Clause 7 (docking)", "Does not apply."],
            [
              "Clause 9 (sub-processors)",
              "Option 2, general written authorisation. The notice period is the one in this DPA.",
            ],
            ["Clause 11 (redress)", "The optional wording does not apply."],
            ["Clause 17 (governing law)", "Option 1. The law of Ireland."],
            ["Clause 18 (courts)", "The courts of Ireland."],
            ["Annex I.B (description of transfer)", "Annex 1 of this DPA."],
            [
              "Annex I.C (supervisory authority)",
              "The authority of the Member State where the Customer is established. If the Customer is not established in the European Economic Area, the authority of the Member State of its representative, or, if it has none, of the Member State where most of the people concerned are.",
            ],
            ["Annex II (security measures)", "Annex 2 of this DPA."],
            ["Annex III (sub-processors)", "Annex 3 of this DPA."],
            [
              "Signature",
              "Accepting the Terms counts as signing the SCCs and their annexes. The date of signing is the date the Customer accepts the Terms.",
            ],
          ],
        },
      },
    ],
  },
  "legal/aup": {
    kind: "legal",
    title: "Acceptable use policy",
    lede: "What you may and may not send through i10, and what we do when the rules are broken.",
    updated: "16 Nov 2026",
    sections: [
      {
        title: "The short version",
        paragraphs: [
          "This policy says what you may send through i10, what you may not, and what we do when the rules are broken. It applies to everything sent or received through i10: the email API, broadcasts, templates, hosted mailboxes, and anything a customer of yours sends through your account.",
          "Every rule has a short code, such as AUP-C1. When we limit, hold or close an account, we tell you which rule the decision rests on. If we cannot name a rule, we do not act for abuse. This does not limit our right to act for non-payment, a legal order, a provider's requirement, or a threat to the security of the service.",
          "Send only to people who asked for your mail or who expect it because of something they did with you.",
          "Say honestly who you are and what the message is.",
          "Never send phishing, malware, scams or illegal content.",
          "Make leaving easy, and honor it.",
          "Keep your bounces and complaints low.",
          "Do not try to get around a limit, a hold or a closed account.",
        ],
      },
      {
        title: "Consent and recipients",
        paragraphs: [],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-R1",
              "Transactional mail needs a reason. You may send a message that a person triggered or needs: a receipt, a password reset, a security alert, a shipping notice, an invitation they were told to expect.",
            ],
            [
              "AUP-R2",
              "Marketing mail needs consent. Newsletters, promotions and announcements go only to people who asked for them, clearly and for that sender. A pre-ticked box, a line buried in terms, or a business card is not consent.",
            ],
            [
              "AUP-R3",
              "No bought, rented, traded or scraped lists. This includes addresses harvested from websites, public directories, social networks, data brokers or another company's customer list.",
            ],
            [
              "AUP-R4",
              "No cold outreach. Unsolicited sales or prospecting email to people you have no relationship with is not allowed, whether sent to one address or a million, and whether the recipient is a person or a business.",
            ],
            [
              "AUP-R5",
              "No guessing or testing addresses. Do not send mail to find out which addresses exist, and do not send to addresses built from patterns.",
            ],
            [
              "AUP-R6",
              'Keep proof. For marketing mail, keep a record of when and how each person consented. We may ask for it during a review, and "we cannot show it" is treated as "there was none".',
            ],
            [
              "AUP-R7",
              "Consent goes stale. Do not start mailing a list you have not written to in over twelve months without first confirming those people still want it.",
            ],
          ],
        },
      },
      {
        title: "Unsubscribes and suppression",
        paragraphs: [],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-U1",
              "Every marketing message can be left in one step. It carries a working unsubscribe link, and i10 adds one-click unsubscribe headers to broadcasts. Do not remove or hide them.",
            ],
            [
              "AUP-U2",
              'Honor it within two days, and sooner where the law says so. No login, no survey, no fee, no "are you sure" maze.',
            ],
            [
              "AUP-U3",
              "Do not mail suppressed addresses. An address that hard-bounced, complained or unsubscribed stays off your list. Do not re-import it, and do not work around suppression by changing the sending domain, the workspace or the list.",
            ],
            [
              "AUP-U4",
              "Transactional mail is not a loophole. Do not put promotions in a receipt or a password reset to reach people who unsubscribed from marketing.",
            ],
          ],
        },
      },
      {
        title: "Honesty about who you are",
        paragraphs: [],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-H1",
              "Send only from domains you own or control. You verify each domain with us before sending.",
            ],
            [
              "AUP-H2",
              "No impersonation. Do not pretend to be another company, brand, government body or person, in the sender name, the address, the design, a logo or the wording.",
            ],
            [
              "AUP-H3",
              'No misleading headers or subjects. The From, Reply-To and subject line must not deceive the reader about who sent the message or what it is. No fake "Re:" or "Fwd:", no false urgency about an account that does not exist.',
            ],
            [
              "AUP-H4",
              "Links go where they say. Link text that shows one address must not lead to another. Do not hide the destination behind chains of redirects.",
            ],
            [
              "AUP-H5",
              "Identify yourself where the law requires it. Marketing mail includes your real business name and a valid postal address where laws such as CAN-SPAM, GDPR or CASL apply to you.",
            ],
            [
              "AUP-H6",
              "Tell us the truth. The information you give us about your business, your mail and your identity must be accurate, at signup and during any review.",
            ],
          ],
        },
      },
      {
        title: "Content that is never allowed",
        paragraphs: [
          "These are closed immediately when confirmed. There is no warning step.",
        ],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-C1",
              "Phishing and credential theft. Any message that tries to obtain passwords, codes, payment details, recovery phrases or personal data under false pretences, or that links to a page that does.",
            ],
            [
              "AUP-C2",
              "Malware. Any attachment or link that delivers a virus, ransomware, spyware, a remote access tool or any code meant to harm or control a device without consent. This includes scripts in HTML attachments and files disguised as another type.",
            ],
            [
              "AUP-C3",
              "Fraud and scams. Advance-fee schemes, fake invoices and fake overdue notices, fake prizes, fake job offers, fake charities, romance scams, tech-support scams, and business email compromise.",
            ],
            [
              "AUP-C4",
              "Child sexual abuse material and exploitation. We report it to the authorities as the law requires.",
            ],
            [
              "AUP-C5",
              "Threats, harassment and incitement. Threats of violence, targeted harassment, doxxing, and content that incites violence or hatred against people for who they are.",
            ],
            [
              "AUP-C6",
              "Sexual content shared without consent, including fabricated images of real people.",
            ],
            [
              "AUP-C7",
              "Illegal goods and services. Illegal drugs, weapons sold unlawfully, stolen data or accounts, forged documents, and anything unlawful where you or your recipients are.",
            ],
            [
              "AUP-C8",
              "Infringement and counterfeits. Pirated content, counterfeit goods, and use of another party's trademarks or copyrighted work without the right to do so.",
            ],
            [
              "AUP-C9",
              'Deceptive money and health claims. "Guaranteed returns", get-rich-quick programmes, pump-and-dump promotions, miracle cures and fake medical claims.',
            ],
          ],
        },
      },
      {
        title: "Content that needs our approval first",
        paragraphs: [
          "These are lawful for some senders in some places, and they draw complaints and blocks far more often than ordinary mail. You may send them only where it is legal for you and every recipient, with explicit consent, and after we have approved your use in writing. Without approval they are treated as a violation.",
        ],
        table: {
          columns: ["Code", "Category"],
          rows: [
            ["AUP-A1", "Gambling, betting, lotteries and sweepstakes"],
            ["AUP-A2", "Adult content and services"],
            ["AUP-A3", "Alcohol, tobacco, vaping and cannabis"],
            ["AUP-A4", "Lending, credit repair, debt collection and debt relief"],
            ["AUP-A5", "Investment products, cryptocurrency and trading signals"],
            ["AUP-A6", "Prescription medicines, supplements and weight-loss products"],
            ["AUP-A7", "Political campaigning and fundraising"],
            ["AUP-A8", "Affiliate and multi-level marketing"],
          ],
        },
        after: [
          "To ask for approval, write to compliance@i10.tech with what you send, to whom, how they consented, and the licences you hold.",
        ],
      },
      {
        title: "How you send",
        paragraphs: [],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-S1",
              "Keep hard bounces low. Stay below 4% of the mail you send. At 10% and above we limit or stop your sending. A high bounce rate means the list is old, bought or guessed.",
            ],
            [
              "AUP-S2",
              "Keep complaints low. Stay below 0.1%, one complaint in a thousand messages. At 0.3% and above we limit or stop your sending. These are the same numbers Gmail and Yahoo apply to you.",
            ],
            [
              "AUP-S3",
              "We do not judge rates on a handful of messages. Below about a hundred messages in the period we look at counts, not percentages. One bounce in three messages is not a 33% bounce rate. We measure rates over the last seven days.",
            ],
            [
              "AUP-S4",
              "Do not spread out to hide. Do not split sending across workspaces, accounts, domains or API keys to stay under a limit or to dilute a bad reputation.",
            ],
            [
              "AUP-S5",
              "One closed account means closed. If we suspend or close an account for abuse, do not open another, yourself or through someone else. We keep a record of confirmed abuse after an account is deleted, for exactly this purpose.",
            ],
            [
              "AUP-S6",
              "Do not manipulate reputation. No inbox warm-up networks, no paid engagement, no mail sent only to make a domain or address look trusted, no seed-list gaming.",
            ],
            [
              "AUP-S7",
              "Grow at a human pace. A new sender ramps up over days and weeks. A sudden jump to large volume from a new account is held for review.",
            ],
            [
              "AUP-S8",
              "Attachments. Do not send executable files or scripts, files whose real type differs from their name, password-protected archives meant to avoid scanning, or documents with macros. We refuse messages that carry them.",
            ],
          ],
        },
      },
      {
        title: "Sending for your own customers",
        paragraphs: [],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-P1",
              "You may build on i10. If your product sends mail for your own customers, that is allowed.",
            ],
            [
              "AUP-P2",
              "You answer for them. This policy applies to their mail as it does to yours. You must have terms that bind them to these rules, a way to stop a customer who breaks them, and a contact who answers us within one business day.",
            ],
            [
              "AUP-P3",
              "Do not resell raw access. Do not hand out i10 API keys or SMTP access to third parties, and do not offer i10 as an open relay.",
            ],
          ],
        },
      },
      {
        title: "Security and fair use of the platform",
        paragraphs: [],
        table: {
          columns: ["Code", "Rule"],
          rows: [
            [
              "AUP-X1",
              "Protect your keys. Keep API keys and passwords secret, scope them, and rotate them if they may have leaked. Tell us at once if you think an account is compromised. You are responsible for mail sent with your keys until you do.",
            ],
            [
              "AUP-X2",
              "Do not attack or probe. No scanning, load testing or attempts to bypass limits, authentication or isolation on i10 or through it, without our written agreement.",
            ],
            [
              "AUP-X3",
              "Do not interfere with other customers. This includes using shared sending reputation carelessly. One sender's abuse harms delivery for everyone.",
            ],
            [
              "AUP-X4",
              "Mailboxes are for correspondence. Hosted mailboxes are for people writing to people. Do not use them for bulk sending, as a drop for fraud proceeds or stolen credentials, or to register accounts in bulk elsewhere.",
            ],
            [
              "AUP-X5",
              "Do not evade our checks. Do not obfuscate text, hide content in images or attachments to avoid scanning, cloak links, or vary content to defeat duplicate detection.",
            ],
          ],
        },
      },
      {
        title: "How we check",
        paragraphs: [
          "Automated checks run on everything. We look at bounce and complaint rates, sending patterns, the sites your messages link to, the files you attach, and the content of messages. Automated systems, including machine-learning models, read message content for this purpose.",
          "Signals are evidence, not verdicts. An automated check can slow or pause sending. It cannot close an account.",
          "People decide the serious cases. A person reviews every hold within 24 hours and every suspension before it becomes permanent.",
          "A decision made by a person stays made. Once a reviewer has cleared a concern, we do not raise the same concern again without new evidence.",
        ],
      },
      {
        title: "What happens when a rule is broken",
        paragraphs: ["We choose the mildest step that stops the harm."],
        table: {
          columns: ["Step", "What it means"],
          rows: [
            [
              "Notice",
              "We tell you what we saw and which rule it concerns. Nothing is restricted.",
            ],
            ["Limits", "Your sending volume is reduced while the problem is fixed."],
            [
              "Hold",
              "Sending stops until a person has reviewed the account. New messages are refused, and queued and scheduled messages are cancelled. They are not sent later, so send them again if the hold is lifted. Hosted mailboxes keep working.",
            ],
            [
              "Suspension",
              "Sending stops. You keep access to your data and can appeal.",
            ],
            [
              "Closure",
              "The account is closed and the abuse is recorded under AUP-S5.",
            ],
          ],
        },
        after: [
          "We skip straight to suspension or closure for anything in section 5, for malware or phishing links, for evading a previous decision, and when the law or our providers require it. We may also act without notice when waiting would cause harm to recipients or to other customers' delivery.",
          "When we act, we tell you the step, the rule code and what you can do next. We do not describe the specific signals we used, because that would teach abusers to avoid them.",
        ],
      },
      {
        title: "Appeals",
        paragraphs: [
          "Who: anyone whose account was limited, held, suspended or closed.",
          "How: reply to the notice or write to appeals@i10.tech from the account owner's address.",
          'What to include: what you send and to whom, how those people came to be on your list, what went wrong, and what you have changed. Specifics decide appeals. "Please reinstate my account" does not.',
          "How long: we answer within two business days. A hold is reviewed within 24 hours whether or not you appeal.",
          "Who decides: a person. An appeal is never refused by an automated system alone.",
          "Once is not the limit: you may appeal again with new information. Repeating the same appeal does not change the answer.",
        ],
      },
      {
        title: "Reporting abuse",
        paragraphs: [
          "If you received unwanted or harmful mail sent through i10, forward it with full headers to abuse@i10.tech. We read every report and act on confirmed abuse. We do not share the reporter's identity with the sender.",
        ],
      },
      {
        title: "Changes",
        paragraphs: [
          "We may change this policy as abuse and the law change. For changes that restrict what you may send, we give at least 30 days' notice by email, unless a shorter time is needed to stop harm or comply with the law. The date at the top shows the current version.",
        ],
      },
    ],
  },
  "legal/subprocessors": {
    kind: "legal",
    title: "Subprocessors",
    lede: "The companies that process data for i10, what each one receives, and where.",
    updated: "16 Nov 2026",
    sections: [
      {
        title: "What this page covers",
        paragraphs: [
          "i10 uses other companies to run parts of the service. A subprocessor is a company that processes personal data for i10 while i10 provides the service to you. This page names each one, what it does, the data it receives and where it processes that data.",
          "The list also names services that receive only limited technical data, and services i10 plans to use but does not use yet. Each of those is marked.",
        ],
      },
      {
        title: "Subprocessors in use",
        paragraphs: [],
        table: {
          columns: ["Company", "What it does for i10", "Data it receives", "Location"],
          rows: [
            [
              "Amazon Web Services (Amazon SES)",
              "Delivers every outgoing message, from the API and from hosted mailboxes, and reports bounces and complaints.",
              "The full message: sender, recipients, headers, body and attachments.",
              "EU: Frankfurt, Germany",
            ],
            [
              "Hetzner Online GmbH",
              "Hosts the servers that run i10: the database, the queues and the mail server.",
              "Everything stored with i10: messages, mailboxes, logs, and workspace and account records.",
              "EU: Nuremberg, Germany",
            ],
            [
              "Cloudflare, Inc.",
              "Network edge and DNS in front of i10, including the gateway that carries sign-in traffic. Object storage (R2) for message bodies, attachments, mailbox data and database backups. Automated analysis of message content (Workers AI) to detect phishing and spam.",
              "Requests to i10, with IP addresses. The stored content named on the left. The content of messages that are analysed.",
              "Storage: Europe. Network and analysis: Cloudflare's global network",
            ],
            [
              "Clerk, Inc.",
              "Sign-in and account management.",
              "Name, email address, password, two-factor settings, sessions, and the IP address and device used to sign in.",
              "United States",
            ],
            [
              "Functional Software, Inc. (Sentry)",
              "Error monitoring.",
              "Error reports from i10's servers. Sensitive values are removed before a report is sent.",
              "EU: Frankfurt, Germany",
            ],
            [
              "IPinfo (IDB LLC)",
              "Looks up the country and network of an IP address at sign-up and sign-in, to prevent abuse.",
              "IP addresses.",
              "United States",
            ],
            [
              "Google LLC (Web Risk)",
              "Checks the links in outgoing mail against lists of known harmful sites.",
              "The host names of links. No message content and no recipient.",
              "United States",
            ],
          ],
        },
      },
      {
        title: "Services that receive limited technical data",
        paragraphs: [
          "These services answer lookups. They receive a host name or a domain name, and nothing that identifies a sender or a recipient. They receive no personal data of our customers, and they are not subprocessors.",
        ],
        table: {
          columns: ["Service", "What it does for i10", "Data it receives", "Location"],
          rows: [
            [
              "Cloudflare DNS and Quad9 (DNS over HTTPS)",
              "Resolve the host names of links in outgoing mail, to detect harmful sites.",
              "The host names of links.",
              "Global",
            ],
            [
              "rdap.org and domain registries",
              "Return the registration date of a domain, to detect newly registered domains.",
              "Domain names.",
              "Global",
            ],
          ],
        },
      },
      {
        title: "Planned services",
        paragraphs: [
          "i10 does not use these services yet. They are listed now so that the list does not change by surprise when they start.",
        ],
        table: {
          columns: [
            "Company",
            "What it will do for i10",
            "Data it will receive",
            "Location",
          ],
          rows: [
            [
              "Polar Software, Inc.",
              "Payments. Polar is the merchant of record: it sells the subscription, takes the payment, and handles tax and invoices.",
              "Billing name, email address, billing address and payment details. Card numbers go to Polar and never reach i10.",
              "United States",
            ],
            [
              "PostHog",
              "Product analytics on i10's websites and console, only with your consent.",
              "Usage events, device and browser details, and IP address.",
              "EU: Frankfurt, Germany",
            ],
            [
              "TypeSafe AI, Inc. (Jev)",
              "Automated analysis of message content to detect phishing and spam.",
              "The content of messages that are analysed.",
              "United States",
            ],
          ],
        },
      },
      {
        title: "Where data is stored",
        paragraphs: [
          "Mail data is stored in Europe. Outgoing mail is sent through Amazon SES in Frankfurt. Messages, mailboxes and logs are stored on Hetzner servers in Nuremberg and in Cloudflare R2 buckets located in Europe.",
          "One exception: the address and sign-in details of a mailbox user are held by Clerk in the United States, like other account data.",
          "Account data is processed in the United States. Your name, email address and sign-in details are held by Clerk, which has no European region.",
          "Some checks run outside Europe, as the tables above show: IP address lookups, link checks, and the automated analysis of message content. These services process the data to answer the check. i10 does not use them to store mail.",
        ],
      },
      {
        title: "Not on this list",
        paragraphs: [
          "Services that you choose and connect yourself are not i10's subprocessors. Examples are your DNS provider, your identity provider for single sign-on, your GitHub account, and the endpoints that receive your webhooks. i10 sends data to them on your instruction.",
          "The mailbox providers that receive the mail you send, such as the recipient's email service, are also not subprocessors.",
        ],
      },
      {
        title: "Changes to this list",
        paragraphs: [
          "i10 updates this page before a new subprocessor starts to process customer data. For a new subprocessor that will process customer data, i10 also emails the owners of each workspace at least 30 days before.",
          "If you object to a new subprocessor, write to legal@i10.tech within that period. If i10 cannot offer a way to use the service without it, you may close your workspace before the change takes effect, and i10 refunds the fees you paid in advance for the time after closing.",
          "i10 may replace a subprocessor sooner when that is needed to keep the service secure or running. i10 then tells you as soon as it can.",
        ],
      },
    ],
  },
  "legal/cookies": {
    kind: "legal",
    title: "Cookie policy",
    lede: "The cookies and browser storage that i10's websites use, what each one is for, and how you control them.",
    updated: "16 Nov 2026",
    sections: [
      {
        title: "About this policy",
        paragraphs: [
          "The websites at i10.tech and its subdomains (the marketing site, the sign-in pages and the console) use technologies that store information in your browser. This policy explains which ones, what they do, and how you control them.",
          'A cookie is a small text file that your browser stores and sends back on later visits. Local storage and session storage are places where a site can keep small pieces of data in your browser; unlike cookies, the browser does not send them to the server by itself. For simplicity, this policy calls all of these "cookies".',
        ],
      },
      {
        title: "The short version",
        paragraphs: [
          "i10 uses only cookies that are needed to run the Service: to sign you in, to keep accounts secure, and to remember your settings. These do not need your consent.",
          "We do not use advertising or tracking cookies. We do not use analytics cookies today. The marketing site at i10.tech sets no cookies of its own.",
        ],
      },
      {
        title: "Sign-in and security cookies",
        paragraphs: [
          "These cookies sign you in and protect your account. They are set on the sign-in pages and the console.",
        ],
        table: {
          columns: ["Cookie", "Set by", "What it does", "Lifetime"],
          rows: [
            [
              "__session, __client, __client_uat",
              "Clerk, our sign-in provider",
              "Keep you signed in and tell our pages whether you are signed in.",
              "Up to 1 year. The session ends sooner when you sign out",
            ],
            [
              "__Host-i10_sso, __Host-i10_sso_saml, __Host-i10_sso_handoff",
              "i10",
              "Tie a single sign-on attempt to your browser, so that nobody else can finish it.",
              "5 to 15 minutes",
            ],
            [
              "__Host-i10_devices",
              "i10",
              "Remembers this device for the accounts you saved on it, so that you can sign back in faster.",
              "45 days",
            ],
            [
              "i10_ctx",
              "i10",
              "Holds your time zone, your language and a device identifier. We use it only when you are signed in, to detect account abuse.",
              "30 days",
            ],
            [
              "Cloudflare cookies, such as cf_clearance",
              "Cloudflare",
              "Set only when a bot check runs, for example at sign-up. They tell people from bots.",
              "Up to 1 year",
            ],
          ],
        },
      },
      {
        title: "Cookies that remember your settings and your place",
        paragraphs: [
          "These cookies keep the console the way you left it. They hold no information about what you do on other sites.",
        ],
        table: {
          columns: ["Cookie", "Set by", "What it does", "Lifetime"],
          rows: [
            [
              "i10-view-<list>",
              "i10",
              "Remembers whether you view a list as a table or as a grid.",
              "1 year",
            ],
            [
              "i10-count-<list>",
              "i10",
              "Remembers how many rows a list had, so that the page loads without jumping.",
              "1 year",
            ],
            [
              "i10_saved_accounts",
              "i10",
              "Remembers how many accounts are saved on this device (a number from 0 to 4).",
              "1 year",
            ],
            [
              "i10_onboarding_step, i10_onboarding_domain, i10_add_domain",
              "i10",
              "Keep your place and what you typed while you set up a workspace or add a domain.",
              "Until you close the browser",
            ],
            [
              "i10_onboarding_skipped",
              "i10",
              "Remembers that you chose to skip set-up.",
              "7 days",
            ],
            [
              "i10_checkout_id, i10_published",
              "i10",
              "Carry the result of one step, such as a checkout, to the next page.",
              "10 minutes",
            ],
          ],
        },
      },
      {
        title: "Local storage and session storage",
        paragraphs: [
          "The sign-in pages keep the accounts you saved on this device in local storage (i10_remembered_accounts): the email address, name and photo of up to four accounts, and the sign-in method you used last. It never holds a password or a session. You can remove each saved account on the sign-in page. Local storage has no expiry date: it stays until you remove the saved account or clear your browser data.",
          "The console keeps interface settings in local storage, such as the view of a list, notices you dismissed and editor settings.",
          "Session storage keeps the state of a form or a flow while a tab is open, for example a sign-in in progress. It is erased when you close the tab.",
        ],
      },
      {
        title: "Analytics",
        paragraphs: [
          "We do not use analytics cookies today. If we add product analytics, we will ask for your consent first. Refusing will be as easy as accepting, nothing will be set before you choose, and you will be able to change your choice at any time. We will update this policy before that starts.",
        ],
      },
      {
        title: "How to control cookies",
        paragraphs: [
          "You can block or delete cookies in your browser settings. The help pages of your browser explain how.",
          "If you block the cookies named in this policy, you will not be able to sign in, and parts of the console will not work. If you delete them, you are signed out and your saved settings are lost.",
        ],
      },
      {
        title: "Your personal data",
        paragraphs: [
          "Some of the information in these cookies is personal data. The privacy policy explains your rights and how to use them.",
        ],
      },
      {
        title: "Changes and contact",
        paragraphs: [
          "We may update this policy when the law or our use of cookies changes. The date at the top shows the latest version.",
          "Questions: privacy@i10.tech. By post: Mohamed Abdelkhalek, Building 16, Narges Buildings, 5th Settlement, New Cairo 11835, Egypt.",
        ],
      },
    ],
  },

  "compare/resend": {
    kind: "compare",
    title: "i10 vs Resend",
    them: "Resend",
    lede: "i10 is Resend-compatible on purpose. Here is what is the same, and what i10 adds.",
    rows: [
      { label: "API shape", i10: "Resend-compatible", them: "Resend API" },
      { label: "Records to start", i10: "1 (DKIM)", them: "3" },
      { label: "Mailboxes on your domain", i10: "Yes", them: "No" },
      {
        label: "Data region",
        i10: "Mail in Europe, sign-in in the US",
        them: "Multi-region",
      },
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
        body: "Mail is sent through eu-central-1, Frankfurt, and stored in Europe. Sign-in data is processed in the US.",
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
