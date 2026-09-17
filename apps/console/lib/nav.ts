import type { LucideIcon } from "lucide-react"
import {
  BookOpen,
  Building2,
  CreditCard,
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  LayoutGrid,
  Layers,
  Mail,
  Megaphone,
  ScrollText,
  Settings,
  ShieldBan,
  Tags,
  Users,
  Webhook,
} from "lucide-react"

/**
 * The navigation, as data.
 *
 * ⚠ ONE LIST, USED BY THREE THINGS: the sidebar, the mobile sheet and the
 * command menu. Three hand-written copies is how a page ends up reachable from
 * ⌘K and invisible in the sidebar — which is worse than it not existing,
 * because nobody will look for it.
 *
 * ⚠ AND `exact` IS NOT A STYLE PREFERENCE. Active state is a prefix match, so
 * `/` would be active on every page in the console. The root is the only entry
 * that needs an exact comparison, and getting it wrong makes the whole sidebar
 * look permanently half-selected.
 */

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  exact?: boolean
  /** Shown in the command menu but not the sidebar. */
  hidden?: boolean
  /** Extra words the command menu matches on. */
  keywords?: string[]
}

export interface NavGroup {
  label?: string
  items: NavItem[]
}

export const NAV: NavGroup[] = [
  {
    items: [
      {
        href: "/",
        label: "Overview",
        icon: LayoutGrid,
        exact: true,
        keywords: ["home", "dashboard", "metrics"],
      },
      {
        href: "/emails",
        label: "Emails",
        icon: Mail,
        keywords: ["log", "sent", "messages", "delivery"],
      },
      {
        href: "/logs",
        label: "Logs",
        icon: ScrollText,
        keywords: ["api", "requests", "http", "debug"],
      },
    ],
  },
  {
    label: "Audience",
    items: [
      {
        href: "/contacts",
        label: "Contacts",
        icon: Users,
        keywords: ["people", "subscribers", "import", "csv"],
      },
      {
        href: "/segments",
        label: "Segments",
        icon: Layers,
        keywords: ["lists", "groups", "audience"],
      },
      {
        href: "/topics",
        label: "Topics",
        icon: Tags,
        keywords: ["preferences", "unsubscribe", "opt in", "opt out"],
      },
    ],
  },
  {
    label: "Sending",
    items: [
      {
        href: "/broadcasts",
        label: "Broadcasts",
        icon: Megaphone,
        keywords: ["campaign", "newsletter", "marketing"],
      },
      {
        href: "/templates",
        label: "Templates",
        icon: BookOpen,
        keywords: ["reusable", "html", "design"],
      },
      {
        href: "/domains",
        label: "Domains",
        icon: Globe,
        keywords: ["dns", "spf", "dkim", "dmarc", "verify", "delegate"],
      },
      {
        href: "/suppressions",
        label: "Suppressions",
        icon: ShieldBan,
        keywords: ["bounce", "complaint", "blocklist", "unsubscribed"],
      },
    ],
  },
  {
    label: "Developers",
    items: [
      {
        href: "/api-keys",
        label: "API keys",
        icon: KeyRound,
        keywords: ["token", "secret", "credential", "rotate"],
      },
      {
        href: "/webhooks",
        label: "Webhooks",
        icon: Webhook,
        keywords: ["endpoint", "events", "deliveries", "replay"],
      },
      {
        href: "/mailboxes",
        label: "Mailboxes",
        icon: Inbox,
        keywords: ["imap", "human", "inbox", "seat"],
      },
    ],
  },
]

/**
 * Settings, which live in their own shell with their own sub-navigation.
 *
 * ⚠ SEPARATE FROM `NAV` BECAUSE THEY RENDER DIFFERENTLY, NOT BECAUSE THEY ARE
 * LESS IMPORTANT. The main sidebar stays visible inside settings and the
 * settings pages get a second column of their own; one flat list would make
 * `/settings/billing` a top-level destination and push the ten things somebody
 * uses daily below the fold.
 */
export const SETTINGS_NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/settings", label: "General", icon: Settings, exact: true },
      { href: "/settings/team", label: "Team", icon: Building2 },
      { href: "/settings/billing", label: "Billing", icon: CreditCard },
      { href: "/settings/usage", label: "Usage", icon: Gauge },
      {
        href: "/settings/unsubscribe-page",
        label: "Unsubscribe page",
        icon: ShieldBan,
      },
    ],
  },
  {
    label: "Account",
    items: [
      /*
       * ⚠ ONE PAGE FOR PROFILE *AND* SECURITY, BECAUSE CLERK'S `<UserProfile />`
       * OWNS BOTH. Splitting them would mean rendering the same component twice
       * with its internal navigation hidden and deep-linked by fragment — two
       * routes that are one component pretending to be two, and which drift the
       * moment Clerk adds a tab. Passkeys, MFA and sessions all live inside it.
       */
      { href: "/account", label: "Profile & security", icon: Users, exact: true },
      { href: "/account/appearance", label: "Appearance", icon: LayoutGrid },
    ],
  },
]

/** Every navigable destination, flattened. Used by the command menu. */
export function allDestinations(): NavItem[] {
  return [...NAV, ...SETTINGS_NAV].flatMap((g) => g.items)
}

/**
 * ⚠ A PREFIX MATCH EXCEPT WHERE `exact` SAYS OTHERWISE, AND THE `/` GUARD IS
 * WHAT STOPS `/emails` MATCHING `/emails-something`. Without it, adding a route
 * whose name starts with an existing one lights up the wrong sidebar item —
 * which is exactly the kind of bug nobody reports and everybody notices.
 */
export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href
  if (pathname === item.href) return true
  return pathname.startsWith(`${item.href}/`)
}
