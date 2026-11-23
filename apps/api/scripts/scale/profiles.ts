/**
 * How big each table is in each profile, and why.
 *
 * `large` is sized for "a successful first year": about 20,000 workspaces, most
 * of them free and idle, one very large customer, and the mail volume a few
 * hundred paying senders would produce over six months. The assumption behind
 * every number is next to it, and docs/research/db-scale/README.md repeats them.
 *
 * `small` keeps every shape and every lifecycle state but runs in seconds, for
 * the generator's own tests.
 */
export interface Profile {
  name: "small" | "large"
  /** Workspaces. Zipf-skewed: tenant 0 is the huge one, most are tiny. */
  tenants: number
  /** Zipf exponent for how activity spreads across tenants. Near 1: one giant, long tail. */
  skew: number
  /** The huge tenant's share of messages, on top of the Zipf curve. */
  hugeShare: number
  /** Workspace members, total (workspace_roles). */
  members: number
  /** core.domains rows, total, across states. */
  domains: number
  /** authd.accounts (mailboxes), total. */
  accounts: number
  /** Mailboxes on i10's own domain with no tenant (pre-tenancy). */
  ownDomainAccounts: number
  /** Tenants with an SSO connection. */
  ssoTenants: number
  apiKeys: number
  webhookEndpoints: number
  /** core.messages over `days`. */
  messages: number
  days: number
  contacts: number
  suppressions: number
  templates: number
  identityEvents: number
  mailboxAuthFailures: number
}

export const PROFILES: Record<Profile["name"], Profile> = {
  small: {
    name: "small",
    tenants: 60,
    skew: 1.05,
    hugeShare: 0.25,
    members: 200,
    domains: 120,
    accounts: 400,
    ownDomainAccounts: 20,
    ssoTenants: 6,
    apiKeys: 100,
    webhookEndpoints: 30,
    messages: 4_000,
    days: 60,
    contacts: 1_000,
    suppressions: 300,
    templates: 80,
    identityEvents: 600,
    mailboxAuthFailures: 200,
  },
  large: {
    name: "large",
    // 20,000 workspaces: the size the mail front sweep was measured at (section 9
    // of mail-device-binding.md), so the two sets of numbers compare.
    tenants: 20_000,
    skew: 1.05,
    // One customer sends a quarter of all mail: a marketplace or a SaaS sending
    // its users' notifications. This is the tenant every list query is worst for.
    hugeShare: 0.25,
    // Three members a workspace on average; the huge one has thousands.
    members: 60_000,
    // 1.5 domains a workspace, every state; verified names are globally unique.
    domains: 30_000,
    // 300,000 mailboxes: 15 a workspace on average, 40,000 in the huge tenant.
    accounts: 300_000,
    ownDomainAccounts: 5_000,
    // 3% of workspaces run SSO; half of those require it on their domains.
    ssoTenants: 600,
    apiKeys: 40_000,
    webhookEndpoints: 15_000,
    // 3 million messages over six months: about 500,000 a month, with growth
    // toward the present, daily cycles and campaign bursts.
    messages: 3_000_000,
    days: 180,
    // Broadcast audiences: the huge tenant holds 30% of all contacts.
    contacts: 1_000_000,
    suppressions: 300_000,
    templates: 50_000,
    identityEvents: 500_000,
    mailboxAuthFailures: 100_000,
  },
}

export function profileNamed(name: string): Profile {
  if (name !== "small" && name !== "large") {
    throw new Error(`unknown profile "${name}" (small or large)`)
  }
  return PROFILES[name]
}
