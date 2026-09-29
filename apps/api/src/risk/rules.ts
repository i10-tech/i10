import { parse } from "tldts"
import { countryLongitude } from "./geo.js"
import type { Band, Facts, Hit, Rule } from "./types.js"

/**
 * The rules (#170). Every one is a pure function of `Facts`, adds or
 * subtracts points, says why, and may set a minimum band.
 *
 * ⚠ BUMP `RULESET_VERSION` WITH ANY CHANGE TO A NUMBER OR A RULE. Assessments
 * record it, and "the score moved because we changed the rules" has to be
 * distinguishable from "the customer changed behaviour" - in an appeal, and in
 * the model's training data.
 *
 * ⚠ EVERY RATE HAS A MINIMUM VOLUME. On 100 sends one complaint is 1%, which
 * would read as three times Gmail's limit. A rate that has not seen enough
 * mail says nothing, and saying nothing is the correct answer.
 *
 * ⚠ THE NUMBERS FOLLOW WHAT THE PEOPLE WHO PAUSE US ENFORCE: Resend pauses at
 * 4% bounces and 0.08% spam, SES reviews an account at 5% and 0.1% and pauses
 * around 10% and 0.5%, Gmail requires spam under 0.3%. We act before them.
 *
 * ⚠ AND EACH RULE IS CHECKED AGAINST THE SYNTHETIC SCENARIOS in
 * test/risk-scenarios.test.ts: a change must still catch every abuse scenario
 * and leave every legitimate one alone.
 */
export const RULESET_VERSION = 2

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const ageDays = (at: Date | null, now: Date) =>
  at ? (now.getTime() - at.getTime()) / DAY : Number.POSITIVE_INFINITY
const within = (at: Date | null, days: number, now: Date) => ageDays(at, now) <= days
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 100 : 0)

/** A rule from its parts, so each reads as its threshold and nothing else. */
function rule(
  id: string,
  category: Rule["category"],
  summary: string,
  evaluate: (f: Facts) => Hit | null,
  fresh = false,
): Rule {
  return { id, category, summary, evaluate, fresh }
}

const hit = (
  points: number,
  evidence: Hit["evidence"],
  extra: { floor?: Band; freshAt?: Date } = {},
): Hit => ({ points, evidence, ...extra })

/** The highest tier of a graded rule that applies, or null. */
function graded<T>(tiers: readonly (readonly [boolean, T])[]): T | null {
  for (const [applies, value] of tiers) if (applies) return value
  return null
}

// ─── SES: the strongest signals there are ────────────────────────────────────

const sesRules: Rule[] = [
  rule(
    "ses.paused.aws",
    "provider_flag",
    "SES or AWS Trust & Safety paused this workspace in the last 30 days",
    (f) => {
      const pause = f.ses.pauses.find(
        (p) => p.origin?.toLowerCase().includes("aws") && within(p.at, 30, f.now),
      )
      return pause
        ? hit(
            60,
            { pausedAt: pause.at.toISOString() },
            { floor: "high", freshAt: pause.at },
          )
        : null
    },
    true,
  ),
  rule(
    "ses.paused.now",
    "provider_flag",
    "The workspace's SES tenant is paused right now",
    (f) =>
      f.ses.current === "disabled"
        ? hit(40, { origin: f.ses.currentOrigin }, { floor: "elevated" })
        : null,
  ),
  rule("ses.paused.history", "provider_flag", "Paused by SES 31-180 days ago", (f) => {
    const old = f.ses.pauses.filter((p) => !within(p.at, 30, f.now))
    return old.length > 0 ? hit(15, { pauses: old.length }) : null
  }),
  rule(
    "ses.finding.high.open",
    "provider_flag",
    "An open HIGH reputation finding (the warning before a pause)",
    (f) => {
      const open = f.ses.findings.filter((x) => x.impact === "high" && !x.resolvedAt)
      return open.length > 0
        ? hit(35, { types: open.map((x) => x.type).join(","), open: open.length })
        : null
    },
  ),
  rule(
    "ses.finding.high.recent",
    "provider_flag",
    "A HIGH finding opened in the last 30 days, since resolved",
    (f) => {
      const recent = f.ses.findings.filter(
        (x) => x.impact === "high" && x.resolvedAt && within(x.openedAt, 30, f.now),
      )
      return recent.length > 0 ? hit(15, { episodes: recent.length }) : null
    },
  ),
  rule(
    "ses.finding.low.open",
    "provider_flag",
    "An open LOW reputation finding",
    (f) => {
      const open = f.ses.findings.filter((x) => x.impact === "low" && !x.resolvedAt)
      return open.length > 0
        ? hit(12, { types: open.map((x) => x.type).join(",") })
        : null
    },
  ),
  rule(
    "ses.reinstated",
    "provider_flag",
    "Reinstated after a pause and still on SES's probation",
    (f) => (f.ses.current === "reinstated" ? hit(10, {}) : null),
  ),
]

// ─── Rates, each with a minimum volume ───────────────────────────────────────

const rateRules: Rule[] = [
  rule("bounce.hard.7d", "bounces", "Hard-bounce rate over 7 days", (f) => {
    const { sends, hardBounces } = f.rates.day7
    if (sends < 100) return null
    const rate = pct(hardBounces, sends)
    const points = graded([
      [rate >= 8, 40],
      [rate >= 4, 25],
      [rate >= 2, 10],
    ] as const)
    return points === null ? null : hit(points, { rate, sends, hardBounces })
  }),
  rule(
    "bounce.hard.24h",
    "bounces",
    "Hard-bounce rate in the last 24 hours (fast reaction to a bad list)",
    (f) => {
      const { sends, hardBounces } = f.rates.day1
      if (sends < 50) return null
      const rate = pct(hardBounces, sends)
      return rate >= 10 ? hit(30, { rate, sends, hardBounces }) : null
    },
  ),
  rule("complaint.7d", "complaints", "Spam-complaint rate over 7 days", (f) => {
    const { sends, complaints } = f.rates.day7
    if (sends < 100) return null
    const rate = pct(complaints, sends)
    const points = graded([
      [rate >= 0.3 && complaints >= 3, 45],
      [rate >= 0.1 && complaints >= 2, 25],
      [rate >= 0.08 && complaints >= 1 && sends >= 1_000, 10],
    ] as const)
    return points === null ? null : hit(points, { rate, sends, complaints })
  }),
  rule(
    "complaint.24h",
    "complaints",
    "Spam-complaint rate in the last 24 hours",
    (f) => {
      const { sends, complaints } = f.rates.day1
      if (sends < 50) return null
      const rate = pct(complaints, sends)
      return rate >= 0.5 && complaints >= 2
        ? hit(30, { rate, sends, complaints })
        : null
    },
  ),
  rule(
    "bounce.soft.7d",
    "list_quality",
    "Soft bounces climbing: a list going stale",
    (f) => {
      const { sends, softBounces } = f.rates.day7
      if (sends < 100) return null
      const rate = pct(softBounces, sends)
      return rate >= 10 ? hit(8, { rate, sends, softBounces }) : null
    },
  ),
  rule("unsubscribe.7d", "list_quality", "Unsubscribe rate over 7 days", (f) => {
    const sends = f.rates.day7.sends
    if (sends < 200) return null
    const rate = pct(f.rates.unsubscribes7d, sends)
    return rate >= 2
      ? hit(8, { rate, sends, unsubscribes: f.rates.unsubscribes7d })
      : null
  }),
  rule(
    "list.early_bounce",
    "list_quality",
    "Hard bounces among the workspace's first sends: the sign of a bought list",
    (f) => {
      const { sends, hardBounces } = f.rates.early
      if (sends < 100) return null
      const rate = pct(hardBounces, sends)
      const points = graded([
        [rate >= 10, 30],
        [rate >= 5, 20],
      ] as const)
      return points === null ? null : hit(points, { rate, sends, hardBounces })
    },
  ),
]

// ─── Behaviour ───────────────────────────────────────────────────────────────

const behaviourRules: Rule[] = [
  rule(
    "quota.hammering",
    "sending_pattern",
    "Keeps sending into the quota: refused on several days, or hundreds of times a day",
    (f) => {
      const { quotaDays7d, quotaRefusals24h } = f.api
      if (quotaDays7d >= 3 || quotaRefusals24h >= 200) {
        return hit(f.plan === "free" ? 12 : 6, { quotaDays7d, quotaRefusals24h })
      }
      return null
    },
  ),
  rule(
    "velocity.day_one_cap",
    "sending_pattern",
    "Reached the free daily cap within 48 hours of sign-up",
    (f) =>
      f.plan === "free" && ageDays(f.createdAt, f.now) <= 2 && f.rates.day1.sends >= 90
        ? hit(10, { sends24h: f.rates.day1.sends })
        : null,
  ),
  rule(
    "velocity.spike",
    "sending_pattern",
    "Volume jumped to ten times the workspace's own trailing average",
    (f) => {
      const trailing = f.rates.trailingDaily
      const avg = trailing.length
        ? trailing.reduce((a, b) => a + b, 0) / trailing.length
        : 0
      const today = f.rates.day1.sends
      return today >= 1_000 && today >= Math.max(1, avg) * 10
        ? hit(15, { today, trailingAverage: Math.round(avg) })
        : null
    },
  ),
  rule(
    "api.client_errors",
    "sending_pattern",
    "Most API calls in the last day were refused: probing, or a broken integration",
    (f) => {
      const { requests24h, clientErrors24h } = f.api
      if (requests24h < 100) return null
      const rate = pct(clientErrors24h, requests24h)
      return rate >= 50 ? hit(8, { rate, requests24h }) : null
    },
  ),
  rule(
    "api.key_churn",
    "sending_pattern",
    "Five or more API keys created in a week",
    (f) =>
      f.api.keysCreated7d >= 5 ? hit(6, { keysCreated7d: f.api.keysCreated7d }) : null,
  ),
  rule(
    "api.key_geo_spread",
    "account_security",
    "An API key used from three or more countries in a day: usually a leaked key",
    (f) =>
      f.api.keyCountries24h >= 3 ? hit(10, { countries: f.api.keyCountries24h }) : null,
  ),
  rule("domains.churn", "sending_pattern", "Many domains added in a week", (f) =>
    f.domains.added7d >= 5 ? hit(10, { added7d: f.domains.added7d }) : null,
  ),
  rule(
    "domains.failing",
    "sending_pattern",
    "Several domains failed verification or were taken back by their owner",
    (f) =>
      f.domains.failedOrDisplaced >= 3
        ? hit(8, { failedOrDisplaced: f.domains.failedOrDisplaced })
        : null,
  ),
  rule(
    "history.demotions",
    "sending_pattern",
    "Demoted to the strict tier twice or more in 90 days",
    (f) =>
      f.history.tierDemotions90d >= 2
        ? hit(8, { demotions: f.history.tierDemotions90d })
        : null,
  ),
  rule(
    "history.holds",
    "sending_pattern",
    "Held in the last 180 days, and the hold was upheld",
    (f) =>
      f.history.upheldHolds > 0
        ? hit(15, { upheld: f.history.upheldHolds, holds: f.history.holds180d })
        : null,
  ),
  rule(
    "billing.trouble",
    "sending_pattern",
    "The subscription is past due or unpaid",
    (f) => (f.billingTrouble ? hit(5, {}) : null),
  ),
]

// ─── Domains ─────────────────────────────────────────────────────────────────

const domainRules: Rule[] = [
  rule(
    "domain.young",
    "new_domain",
    "Sending from a domain registered in the last 30 days",
    (f) => {
      const age = ageDays(f.domains.youngestRegisteredAt, f.now)
      const points = graded([
        [age <= 7, 25],
        [age <= 30, 12],
      ] as const)
      return points === null ? null : hit(points, { domainAgeDays: Math.floor(age) })
    },
  ),
  rule(
    "domain.random_subdomain",
    "linked_workspaces",
    "Sending from a random-looking subdomain",
    (f) => (f.domains.randomSubdomain ? hit(8, {}) : null),
  ),
  rule(
    "link.parent_shared",
    "linked_workspaces",
    "Other workspaces send from subdomains of the same registrable domain",
    (f) => {
      const { sharedWith, sharedWithHeldOrDead } = f.parents
      if (sharedWithHeldOrDead > 0) {
        return hit(40, { sharedWith, heldOrTerminated: sharedWithHeldOrDead })
      }
      return sharedWith >= 3 ? hit(15, { sharedWith }) : null
    },
  ),
  rule(
    "owner.many_workspaces",
    "linked_workspaces",
    "The owner runs five or more workspaces",
    (f) =>
      f.owner.workspaces >= 5 ? hit(10, { workspaces: f.owner.workspaces }) : null,
  ),
]

// ─── Farms: the priority (see docs/decisions/risk.md) ────────────────────────

/** How many linking features a peer shares, beyond the content itself. */
export const linkingFeatures = (p: Facts["farm"]["peers"][number]): number =>
  [
    p.createdNear,
    p.sameOwner,
    p.ownerDevice,
    p.ownerSubnet,
    p.ownerCountry && p.young,
    p.free && p.young,
  ].filter(Boolean).length

const farmRules: Rule[] = [
  rule(
    "farm.cluster",
    "linked_workspaces",
    "Sends the same content as other workspaces it is linked to (a farm)",
    (f) => {
      const linked = f.farm.peers.filter((p) => linkingFeatures(p) >= 2)
      const loose = f.farm.peers.filter((p) => linkingFeatures(p) === 1)
      if (linked.length >= 4) {
        return hit(
          55,
          { linkedPeers: linked.length, loosePeers: loose.length },
          { floor: "high" },
        )
      }
      if (linked.length >= 2) {
        return hit(30, { linkedPeers: linked.length, loosePeers: loose.length })
      }
      if (linked.length + loose.length >= 4) {
        return hit(15, { linkedPeers: linked.length, loosePeers: loose.length })
      }
      return null
    },
  ),
  rule(
    "farm.with_held",
    "linked_workspaces",
    "Sends the same content as a workspace confirmed abusive by staff",
    (f) => {
      const held = f.farm.peers.filter((p) => p.held)
      return held.length > 0 ? hit(35, { heldPeers: held.length }) : null
    },
  ),
]

// ─── Identity: the people behind the workspace ───────────────────────────────

const identityRules: Rule[] = [
  rule(
    "identity.ban_evasion",
    "account_security",
    "The owner's device or sign-up network is shared with the owner of a workspace confirmed abusive",
    (f) => {
      const id = f.identity
      if (!id) return null
      const held = id.heldDevicePeers + id.heldSubnetPeers
      return held > 0
        ? hit(40, {
            heldDevicePeers: id.heldDevicePeers,
            heldSubnetPeers: id.heldSubnetPeers,
          })
        : null
    },
  ),
  rule(
    "identity.shared_device",
    "account_security",
    "The owner's device is used by several other accounts",
    (f) => {
      const peers = f.identity?.devicePeers ?? 0
      const points = graded([
        [peers >= 3, 25],
        [peers >= 1, 8],
      ] as const)
      return points === null ? null : hit(points, { devicePeers: peers })
    },
  ),
  rule(
    "identity.signup_burst",
    "account_security",
    "Many accounts signed up from the owner's network within a day",
    (f) => {
      const peers = f.identity?.subnetSignupPeers ?? 0
      return peers >= 4 ? hit(15, { subnetSignupPeers: peers }) : null
    },
  ),
  rule("identity.tor", "account_security", "The owner used Tor", (f) =>
    f.identity?.torSeen ? hit(15, {}) : null,
  ),
  rule(
    "identity.hosting",
    "account_security",
    "The owner signed in from a hosting provider's network",
    (f) => (f.identity?.hostingSeen ? hit(10, {}) : null),
  ),
  rule(
    "identity.anomalies",
    "account_security",
    "Impossible travel or another sign-in anomaly in the last 30 days",
    (f) => {
      const n = f.identity?.anomalies ?? 0
      return n > 0 ? hit(Math.min(20, 8 * n), { anomalies: n }) : null
    },
  ),
  rule(
    "identity.many_countries",
    "account_security",
    "The owner appeared from four or more countries in 30 days",
    (f) => {
      const n = f.identity?.countries ?? 0
      return n >= 4 ? hit(8, { countries: n }) : null
    },
  ),
  rule(
    "identity.timezone_mismatch",
    "account_security",
    "The browser's timezone is far from the IP's country",
    (f) => {
      const id = f.identity
      if (!id?.latestTimezone || !id.latestCountry) return null
      const gap = timezoneGapHours(id.latestTimezone, id.latestCountry, f.now)
      return gap !== null && gap >= 6 ? hit(3, { gapHours: gap }) : null
    },
  ),
]

// ─── Content and links ───────────────────────────────────────────────────────

const contentRules: Rule[] = [
  rule(
    "links.unsafe",
    "unsafe_links",
    "Mail linked to a host Google Web Risk lists as malware or phishing",
    (f) =>
      f.links.unsafe.length > 0
        ? hit(
            90,
            {
              hosts: f.links.unsafe
                .slice(0, 5)
                .map((l) => `${l.host} (${l.verdict})`)
                .join(", "),
            },
            {
              floor: "critical",
              // ⚠ THE DAY THE LINK WAS SENT, NOT NOW: only mail sent after a
              // staff release is evidence the person releasing never saw.
              freshAt: new Date(
                Math.max(
                  ...f.links.unsafe.map((l) => Date.parse(`${l.day}T23:59:59Z`)),
                ),
              ),
            },
          )
        : null,
    true,
  ),
  rule(
    "content.classifier",
    "content",
    "A content classifier judged recent mail phishing or unsolicited bulk",
    (f) => {
      const p = f.content?.probability ?? 0
      const points = graded([
        [p >= 0.9, 30],
        [p >= 0.75, 12],
      ] as const)
      return points === null
        ? null
        : hit(points, { probability: Math.round(p * 100) / 100 })
    },
  ),
  rule(
    "model",
    "sending_pattern",
    "The trained model's estimate that this workspace is abusive",
    (f) => {
      const p = f.model?.probability ?? 0
      const points = graded([
        [p >= 0.9, 20],
        [p >= 0.7, 10],
      ] as const)
      return points === null
        ? null
        : hit(points, {
            probability: Math.round(p * 100) / 100,
            version: f.model!.version,
          })
    },
  ),
]

// ─── Earned trust: negative points ───────────────────────────────────────────

// ─── Actors: the person behind the workspace, and everyone sharing their device ─

const actorRules: Rule[] = [
  rule(
    "actor.velocity",
    "linked_workspaces",
    "The person behind this workspace (or people on their device or network) created several workspaces in a day",
    (f) => {
      const n = f.actor?.workspaces24h ?? 0
      const points = graded([
        [n >= 6, 30],
        [n >= 3, 15],
      ] as const)
      return points === null
        ? null
        : hit(points, { workspaces24h: n, linkedPeople: f.actor!.linkedPeople })
    },
  ),
  rule(
    "actor.domain_velocity",
    "sending_pattern",
    "Ten or more domains added across the actor's workspaces in a day",
    (f) =>
      (f.actor?.domains24h ?? 0) >= 10
        ? hit(10, { domains24h: f.actor!.domains24h })
        : null,
  ),
  rule(
    "actor.cluster_size",
    "linked_workspaces",
    "The actor's device or network reaches ten or more live workspaces",
    (f) =>
      (f.actor?.linkedWorkspaces ?? 0) >= 10
        ? hit(10, { linkedWorkspaces: f.actor!.linkedWorkspaces })
        : null,
  ),
]

// ─── Similarity (pgvector): evidence, deliberately not verdicts ──────────────

/**
 * ⚠ MODEST POINTS ON PURPOSE. Embedding similarity is new here and has not
 * been calibrated on real traffic; it is evidence that adds up with other
 * evidence, never enough alone to hold anybody. The weights rise once labels
 * show how it performs - which is also when the model starts to weigh it.
 */
const similarityRules: Rule[] = [
  rule(
    "content.like_confirmed_abuse",
    "content",
    "Recent mail reads like mail from a workspace confirmed abusive",
    (f) => {
      const s = f.similarity
      if (!s || s.taintedSimilar === 0) return null
      return hit(s.taintedSimilar >= 2 ? 30 : 20, {
        confirmedWorkspaces: s.taintedSimilar,
        similarity:
          s.bestTaintedSimilarity === null
            ? null
            : Math.round(s.bestTaintedSimilarity * 100) / 100,
        model: s.model,
      })
    },
  ),
  rule(
    "content.semantic_crowd",
    "linked_workspaces",
    "The same message, reworded, is going out from four or more new free workspaces",
    (f) => {
      const n = f.similarity?.youngFreeSimilar ?? 0
      return n >= 4
        ? hit(12, { youngFreeWorkspaces: n, model: f.similarity!.model })
        : null
    },
  ),
  rule(
    "behaviour.like_abuse",
    "sending_pattern",
    "Behaves like workspaces that turned out to be abusive",
    (f) => {
      const b = f.behaviour
      if (!b || b.labelled < 5) return null
      const share = b.abuse / b.labelled
      const points = graded([
        [share >= 0.7, 20],
        [share >= 0.5, 8],
      ] as const)
      return points === null
        ? null
        : hit(points, { abuseNeighbours: b.abuse, labelledNeighbours: b.labelled })
    },
  ),
]

const trustRules: Rule[] = [
  rule(
    "trust.known_templates",
    "trust",
    "Recent mail fits the workspace's own long-established templates",
    (f) => {
      const t = f.templates
      return t && t.established > 0 && (t.recentMatchedShare ?? 0) >= 0.8
        ? hit(-5, {
            established: t.established,
            matchedShare: Math.round((t.recentMatchedShare ?? 0) * 100) / 100,
          })
        : null
    },
  ),
  rule(
    "trust.tenure",
    "trust",
    "Thirty days or more with real volume and no SES trouble in 90 days",
    (f) => {
      const trouble =
        f.ses.pauses.some((p) => within(p.at, 90, f.now)) ||
        f.ses.findings.some((x) => x.impact === "high" && within(x.openedAt, 90, f.now))
      return ageDays(f.createdAt, f.now) >= 30 && f.rates.day7.sends >= 250 && !trouble
        ? hit(-15, { ageDays: Math.floor(ageDays(f.createdAt, f.now)) })
        : null
    },
  ),
  rule("trust.paid", "trust", "A paying customer for 60 days or more", (f) => {
    if (f.plan !== "paid" || !f.paidSince) return null
    const days = ageDays(f.paidSince, f.now)
    return days >= 60
      ? hit(-10, { paidDays: Math.floor(days) })
      : hit(-4, { paidDays: Math.floor(days) })
  }),
  rule(
    "trust.mfa",
    "trust",
    "The owner protects the account with MFA or a passkey",
    (f) => (f.owner.mfa ? hit(-5, {}) : null),
  ),
  rule(
    "trust.owner_domain",
    "trust",
    "The owner's email address is on one of the workspace's own verified domains",
    (f) => (f.owner.emailOnOwnDomain ? hit(-8, {}) : null),
  ),
  rule(
    "trust.clean_volume",
    "trust",
    "Five hundred or more sends in 7 days with almost no bounces and no complaints",
    (f) => {
      const { sends, hardBounces, complaints } = f.rates.day7
      return sends >= 500 && pct(hardBounces, sends) < 1 && complaints === 0
        ? hit(-5, { sends })
        : null
    },
  ),
]

export const RULES: readonly Rule[] = [
  ...sesRules,
  ...rateRules,
  ...behaviourRules,
  ...domainRules,
  ...farmRules,
  ...identityRules,
  ...contentRules,
  ...actorRules,
  ...similarityRules,
  ...trustRules,
]

// ─── Helpers the facts loader shares with the rules ──────────────────────────

/**
 * Whether a hostname's first label looks machine-made: long and high-entropy,
 * or mixed letters and digits with no vowels to speak of. `mail.acme.com` and
 * `send.acme.com` are not; `x7kq2vd9.acme.com` is.
 */
export function looksRandomLabel(label: string): boolean {
  if (label.length < 8) return false
  const counts = new Map<string, number>()
  for (const ch of label) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const n of counts.values()) {
    const p = n / label.length
    entropy -= p * Math.log2(p)
  }
  const digits = [...label].filter((c) => c >= "0" && c <= "9").length
  const vowels = [...label].filter((c) => "aeiou".includes(c)).length
  return (
    (entropy >= 3.2 && digits >= 2) ||
    (label.length >= 12 && vowels / label.length < 0.15)
  )
}

/** The registrable parent of a hostname (`a.b.example.co.uk` -> `example.co.uk`). */
export function registrable(host: string): string | null {
  return parse(host).domain ?? null
}

/** The subdomain labels in front of the registrable domain, if any. */
export function subdomainOf(host: string): string | null {
  return parse(host).subdomain || null
}

/**
 * How far the browser's timezone is from where the IP's country is, in hours.
 *
 * ⚠ WEAK ON PURPOSE. It compares the zone's current UTC offset with the
 * country centre's solar offset, which is off by hours for wide countries -
 * hence the six-hour threshold and three points. It only matters in company.
 */
export function timezoneGapHours(
  tz: string,
  country: string,
  now: Date,
): number | null {
  const offset = zoneOffsetHours(tz, now)
  const lon = countryLongitude(country)
  if (offset === null || lon === null) return null
  const solar = lon / 15
  let gap = Math.abs(offset - solar)
  if (gap > 12) gap = 24 - gap
  return Math.round(gap)
}

function zoneOffsetHours(tz: string, now: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value
    if (!name) return null
    const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(name)
    if (!m) return null
    if (!m[1]) return 0
    const sign = m[1] === "-" ? -1 : 1
    return sign * (Number(m[2]) + Number(m[3] ?? 0) / 60)
  } catch {
    return null
  }
}
