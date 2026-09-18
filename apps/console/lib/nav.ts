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
  {
    /*
     * ⚠ SETTINGS NEEDS A LINK IN THE SIDEBAR, AND FOR A WHILE IT HAD NONE AT
     * ALL. `SETTINGS_NAV` below has always described the settings pages, but
     * nothing rendered a route INTO them: not this list, not the workspace bar,
     * not the mobile drawer. The only way to reach `/settings` — and therefore
     * billing, the team, and the usage detail — was ⌘K, which is a shortcut
     * people learn after they have found a thing, not before. Billing in
     * particular was unreachable by clicking, so "there is nowhere to change my
     * plan" was literally true.
     *
     * ⚠ ONE ENTRY, NOT THE WHOLE SETTINGS TREE. The note on `SETTINGS_NAV`
     * stands: flattening five settings pages into the primary sidebar pushes
     * the ten daily destinations below the fold. This is a door, and the
     * settings shell has its own second column behind it.
     */
    items: [
      {
        href: "/settings",
        label: "Settings",
        icon: Settings,
        keywords: ["billing", "plan", "team", "usage", "workspace", "account"],
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

/**
 * Every navigable destination, flattened. Used by the command menu.
 *
 * ⚠ DEDUPED BY `href`, BECAUSE `/settings` IS NOW IN BOTH LISTS. The sidebar
 * needs a door into settings and `SETTINGS_NAV` needs a "General" tab, and both
 * are the same route — so without this the command menu offers it twice, one
 * line apart, labelled differently.
 */
export function allDestinations(): NavItem[] {
  const seen = new Set<string>()
  return [...NAV, ...SETTINGS_NAV]
    .flatMap((g) => g.items)
    .filter((item) => {
      if (seen.has(item.href)) return false
      seen.add(item.href)
      return true
    })
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

/**
 * Whether a path belongs to the settings world rather than the console.
 *
 * ⚠ `/account` COUNTS, EVEN THOUGH IT IS NOT UNDER `/settings`. The profile and
 * appearance pages are listed in `SETTINGS_NAV` and reached from it, so a rail
 * that reverted to the console navigation on them would drop somebody out of
 * the section they were still in — with the links they had just been using
 * gone from the screen.
 *
 * ⚠ AND IT MATCHES ON A SEGMENT BOUNDARY, for the same reason `isActive` does.
 * A future `/settings-export` is not settings, and a naive `startsWith` would
 * put the wrong navigation on it.
 */
export function inSettings(pathname: string): boolean {
  return ["/settings", "/account"].some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  )
}
