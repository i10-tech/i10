/*
 * Everything the site links to, in one place: the hosts, the nav and the
 * footer. The pages behind those links are registered in lib/pages.ts, and
 * the catch-all route renders only what is registered there, so a link with
 * no page is a 404 in development rather than a surprise in production.
 */

export const hosts = {
  site: "https://i10.tech",
  dashboard: "https://dash.i10.tech",
  signIn: "https://auth.i10.tech/sign-in",
  signUp: "https://auth.i10.tech/sign-up",
  docs: "https://docs.i10.tech",
  api: "https://api.i10.tech",
  github: "https://github.com/i10-tech",
} as const

export type Badge = "new" | "beta" | "soon" | "labs"

export type Hue = "send" | "mail" | "domain" | "template" | "hook" | "deliver"

export interface NavItem {
  title: string
  href: string
  description?: string
  badge?: Badge
  hue?: Hue
  icon?: IconName
  external?: boolean
}

export type IconName =
  | "send"
  | "mailbox"
  | "globe"
  | "template"
  | "webhook"
  | "shield"
  | "inbound"
  | "broadcast"
  | "book"
  | "code"
  | "terminal"
  | "changelog"
  | "status"
  | "migrate"
  | "blog"
  | "brand"
  | "people"
  | "key"

export const productNav: NavItem[] = [
  {
    title: "Email API",
    href: "/product/email-api",
    description: "Resend-compatible sending. Change one import.",
    hue: "send",
    icon: "send",
  },
  {
    title: "Mailboxes",
    href: "/product/mailboxes",
    description: "Real inboxes on your domain, IMAP and JMAP.",
    hue: "mail",
    icon: "mailbox",
  },
  {
    title: "Domains",
    href: "/product/domains",
    description: "One DKIM record to start. One click with Cloudflare.",
    hue: "domain",
    icon: "globe",
  },
  {
    title: "Templates",
    href: "/product/templates",
    description: "React Email, a visual editor, and git push to publish.",
    hue: "template",
    icon: "template",
    badge: "new",
  },
  {
    title: "Webhooks",
    href: "/product/webhooks",
    description: "Every event, signed, retried, replayable.",
    hue: "hook",
    icon: "webhook",
  },
  {
    title: "Deliverability",
    href: "/product/deliverability",
    description: "Aligned SPF and DKIM, suppressions, reputation.",
    hue: "deliver",
    icon: "shield",
  },
]

export const developerNav: NavItem[] = [
  { title: "Documentation", href: hosts.docs, description: "Guides and concepts.", icon: "book", external: true },
  { title: "API reference", href: `${hosts.docs}/api`, description: "Every endpoint, typed.", icon: "code", external: true },
  { title: "SDKs", href: "/developers", description: "@i10/node, @i10/next and more.", icon: "terminal" },
  { title: "Migrate from Resend", href: "/migrate/resend", description: "Swap the import. Keep the code.", icon: "migrate" },
  { title: "Changelog", href: "/changelog", description: "What shipped, when.", icon: "changelog" },
  { title: "Status", href: "/status", description: "Live system health.", icon: "status" },
]

export const resourceNav: NavItem[] = [
  { title: "Blog", href: "/blog", description: "Notes from building i10.", icon: "blog" },
  { title: "Customers", href: "/customers", description: "Teams sending with i10.", icon: "people" },
  { title: "Security", href: "/security", description: "Sealed bodies, EU region, audits.", icon: "key" },
  { title: "Brand", href: "/brand", description: "Marks, colours and type.", icon: "brand" },
]

export interface FooterColumn {
  title: string
  links: NavItem[]
}

export const footerColumns: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { title: "Email API", href: "/product/email-api" },
      { title: "Mailboxes", href: "/product/mailboxes" },
      { title: "Domains", href: "/product/domains" },
      { title: "Templates", href: "/product/templates", badge: "new" },
      { title: "Webhooks", href: "/product/webhooks" },
      { title: "Inbound", href: "/product/inbound", badge: "soon" },
      { title: "Broadcasts", href: "/product/broadcasts", badge: "beta" },
      { title: "Deliverability", href: "/product/deliverability" },
    ],
  },
  {
    title: "Developers",
    links: [
      { title: "Documentation", href: hosts.docs, external: true },
      { title: "API reference", href: `${hosts.docs}/api`, external: true },
      { title: "SDKs", href: "/developers" },
      { title: "Migrate from Resend", href: "/migrate/resend" },
      { title: "Changelog", href: "/changelog", badge: "new" },
      { title: "Status", href: "/status" },
    ],
  },
  {
    title: "Company",
    links: [
      { title: "About", href: "/about" },
      { title: "Blog", href: "/blog" },
      { title: "Customers", href: "/customers" },
      { title: "Careers", href: "/careers" },
      { title: "Brand", href: "/brand" },
      { title: "Design system", href: "/design", badge: "labs" },
      { title: "Contact", href: "/contact" },
    ],
  },
  {
    title: "Compare",
    links: [
      { title: "i10 vs Resend", href: "/compare/resend" },
      { title: "i10 vs Postmark", href: "/compare/postmark" },
      { title: "i10 vs SendGrid", href: "/compare/sendgrid" },
      { title: "i10 vs Google Workspace", href: "/compare/google-workspace" },
    ],
  },
  {
    title: "Legal",
    links: [
      { title: "Privacy", href: "/legal/privacy" },
      { title: "Terms", href: "/legal/terms" },
      { title: "DPA", href: "/legal/dpa" },
      { title: "Acceptable use", href: "/legal/aup" },
      { title: "Subprocessors", href: "/legal/subprocessors" },
      { title: "Cookies", href: "/legal/cookies" },
      { title: "Security", href: "/security" },
    ],
  },
]

/*
 * ⚠ ONLY GITHUB IS A REAL ACCOUNT. The other handles are not registered yet,
 * and guessing one would send people to whoever owns it today, so they point
 * at the contact page until the accounts exist.
 */
export const socials = [
  { title: "GitHub", href: hosts.github, icon: "github" },
  { title: "X", href: "/contact", icon: "x" },
  { title: "LinkedIn", href: "/contact", icon: "linkedin" },
  { title: "Discord", href: "/contact", icon: "discord" },
] as const
