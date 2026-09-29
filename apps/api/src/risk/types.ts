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
  /** The closest shared content: 1 for identical, else shared MinHash bands / 8. */
  bestSimilarity: number
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

  farm: {
    peers: FarmPeer[]
    /** This workspace's recent fingerprints left out as trusted (#222). */
    trusted: TrustedCounts
  }

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
    /** Every neighbour hit at or above the threshold, across recent content. */
    neighbours: number
    medianSimilarity: number | null
    bestSimilarity: number | null
    trusted: TrustedCounts
    /** The boilerplate entry the unexcused content reads closest to (#222). */
    boilerplateNear: { name: string; similarity: number } | null
  } | null

  /** Its nearest LABELLED neighbours by behaviour (pgvector). */
  behaviour: {
    labelled: number
    abuse: number
    legit: number
    meanAbuseDistance: number | null
    nearestDistance: number | null
    medianDistance: number | null
  } | null

  /** The workspace's own discovered templates: its normal mail. */
  templates: { established: number; recentMatchedShare: number | null } | null

  model: { probability: number; version: number } | null
}

/** Recent content left out of the cross-workspace rules as trusted (#222). */
export interface TrustedCounts {
  /** Distinct contents that fitted the workspace's own approved templates. */
  template: number
  /** Distinct contents that fitted known public boilerplate. */
  boilerplate: number
}

/**
 * What a similarity finding was based on (#222), stored with the assessment
 * and shown to staff.
 *
 * ⚠ COUNTS AND DISTANCES ONLY. Never another workspace's id, content or
 * domains: staff see that eight workspaces sent something this close, not
 * which eight - the same line every definer draws.
 */
export interface SimilarityEvidence {
  signal: string
  /** The embedder, `minhash-8x4` for fingerprints, `behaviour-v1` for behaviour. */
  model: string
  neighbours: number
  distinct_workspaces: number
  median_similarity: number | null
  best_similarity: number | null
  /** Behaviour only: L2 distances between standardised feature vectors. */
  median_distance?: number | null
  nearest_distance?: number | null
  confirmed_abuse_neighbours: number
  known_template_matches: number
  boilerplate_matches: number
  boilerplate_match: { name: string; similarity: number } | null
}

/** What a rule says when it fires. */
export interface Hit {
  points: number
  evidence: Record<string, number | string | boolean | null>
  /** The evidence behind a similarity finding (#222). */
  detail?: SimilarityEvidence
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
  detail?: SimilarityEvidence
  floor?: Band
  freshAt?: string
}

export interface Assessment {
  score: number
  band: Band
  contributions: Contribution[]
  rulesetVersion: number
}
