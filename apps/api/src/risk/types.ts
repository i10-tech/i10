/**
 * The shapes the risk engine passes around (#170). See docs/decisions/risk.md.
 *
 * ⚠ `Facts` IS EVERYTHING A RULE MAY READ, AND RULES READ NOTHING ELSE. Rules
 * are pure functions of it, which is what makes them testable against the
 * synthetic scenarios and what makes a score reproducible from the facts an
 * assessment recorded. A rule that queried the database itself would be a
 * rule nobody could replay.
 */
export type Band = "low" | "elevated" | "high" | "critical"
export type Plan = "free" | "paid"

export const BANDS: readonly Band[] = ["low", "elevated", "high", "critical"]
export const bandRank = (band: Band): number => BANDS.indexOf(band)
export const maxBand = (a: Band, b: Band): Band => (bandRank(a) >= bandRank(b) ? a : b)

/**
 * What the customer is told a hold or a demotion is about. ⚠ A CATEGORY, NEVER
 * A THRESHOLD: telling somebody "complaints above 0.3%" is telling them to
 * stay at 0.29%.
 */
export type Category =
  | "provider_flag"
  | "bounces"
  | "complaints"
  | "list_quality"
  | "sending_pattern"
  | "new_domain"
  | "linked_workspaces"
  | "account_security"
  | "unsafe_links"
  | "content"
  | "trust"

export const CATEGORY_TEXT: Readonly<Record<Category, string>> = {
  provider_flag: "our email provider flagged recent mail from this workspace",
  bounces: "too many recent messages bounced",
  complaints: "recipients marked recent messages as spam",
  list_quality: "recent mail went to many addresses that do not exist",
  sending_pattern: "unusual sending activity",
  new_domain: "mail is being sent from a very recently registered domain",
  linked_workspaces:
    "this workspace is linked to a group of workspaces sending the same mail",
  account_security: "unusual sign-in activity on the account",
  unsafe_links: "recent mail linked to a site listed as unsafe",
  content: "recent mail looks like phishing or unsolicited bulk mail",
  trust: "a history of good sending",
}

export interface Counts {
  sends: number
  hardBounces: number
  softBounces: number
  complaints: number
}

export interface SesPause {
  origin: string | null
  at: Date
}

export interface SesFindingFact {
  type: string
  impact: "high" | "low"
  openedAt: Date
  resolvedAt: Date | null
}

/** A workspace that sent the same content, with the features linking the two. */
export interface FarmPeer {
  peer: string
  exactShared: number
  nearShared: number
  free: boolean
  held: boolean
  young: boolean
  createdNear: boolean
  sameOwner: boolean
  ownerDevice: boolean
  ownerSubnet: boolean
  ownerCountry: boolean
}

export interface IdentityFacts {
  firstSeen: Date | null
  firstCountry: string | null
  latestCountry: string | null
  latestTimezone: string | null
  countries: number
  torSeen: boolean
  hostingSeen: boolean
  anomalies: number
  devicePeers: number
  heldDevicePeers: number
  subnetSignupPeers: number
  heldSubnetPeers: number
}

export interface Facts {
  tenantId: string
  now: Date
  plan: Plan
  createdAt: Date
  /** When a paid subscription started, for paid workspaces. */
  paidSince: Date | null
  billingTrouble: boolean

  ses: {
    current: "enabled" | "disabled" | "reinstated" | null
    currentOrigin: string | null
    changedAt: Date | null
    /** Disabled events in the last 180 days. */
    pauses: SesPause[]
    /** Open findings, and any opened in the last 90 days. */
    findings: SesFindingFact[]
  }

  rates: {
    day1: Counts
    day7: Counts
    /** Hard bounces among the workspace's first sends ever. */
    early: { sends: number; hardBounces: number }
    unsubscribes7d: number
    /** Sends per day for the six days before the last 24h, oldest first. */
    trailingDaily: number[]
  }

  api: {
    requests24h: number
    clientErrors24h: number
    quotaRefusals24h: number
    quotaDays7d: number
    keysCreated7d: number
    keyCountries24h: number
  }

  domains: {
    total: number
    added7d: number
    failedOrDisplaced: number
    /** The newest registration among verified sending domains; null if unknown. */
    youngestRegisteredAt: Date | null
    randomSubdomain: boolean
    parents: string[]
  }

  history: {
    tier: "strict" | "normal"
    tierSource: "default" | "score" | "staff"
    tierChangedAt: Date | null
    tierDemotions90d: number
    holds180d: number
    upheldHolds: number
  }

  owner: {
    clerkUserId: string
    mfa: boolean | null
    emailOnOwnDomain: boolean | null
    workspaces: number
  }

  identity: IdentityFacts | null

  farm: { peers: FarmPeer[] }

  parents: { sharedWith: number; sharedWithHeldOrDead: number }

  links: { unsafe: { host: string; verdict: string; day: string }[] }

  content: { probability: number; at: Date } | null

  /** How fast the person behind this workspace, and people sharing their device or network, create things. */
  actor: {
    linkedPeople: number
    workspaces24h: number
    workspaces7d: number
    linkedWorkspaces: number
    linkedTainted: number
    domains24h: number
    keys24h: number
  } | null

  /** How close this workspace's recent mail is to other workspaces' (pgvector). */
  similarity: {
    model: string
    similarPeers: number
    youngFreeSimilar: number
    taintedSimilar: number
    bestTaintedSimilarity: number | null
  } | null

  /** Its nearest LABELLED neighbours by behaviour (pgvector). */
  behaviour: {
    labelled: number
    abuse: number
    legit: number
    meanAbuseDistance: number | null
    nearestDistance: number | null
  } | null

  /** The workspace's own discovered templates: its normal mail. */
  templates: { established: number; recentMatchedShare: number | null } | null

  model: { probability: number; version: number } | null
}

/** What a rule says when it fires. */
export interface Hit {
  points: number
  evidence: Record<string, number | string | boolean | null>
  /** The lowest band this rule allows, whatever the points. */
  floor?: Band
  /**
   * ⚠ WHEN THE EVIDENCE HAPPENED, for rules that may act through a staff
   * release. After a release, only a `fresh` rule whose evidence is newer than
   * the release may hold the workspace again.
   */
  freshAt?: Date
}

export interface Rule {
  id: string
  category: Category
  /** One line for staff, in `risk-admin explain`. */
  summary: string
  /** May this rule's evidence re-hold a workspace after a staff release? */
  fresh?: boolean
  evaluate(facts: Facts): Hit | null
}

export interface Contribution {
  rule: string
  category: Category
  points: number
  evidence: Hit["evidence"]
  floor?: Band
  freshAt?: string
}

export interface Assessment {
  score: number
  band: Band
  contributions: Contribution[]
  rulesetVersion: number
}
