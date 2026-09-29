import type { Counts, Facts, FarmPeer, IdentityFacts } from "../src/risk/types.js"

/** Nothing left out as trusted (#222). */
export const NO_TRUST = { template: 0, boilerplate: 0 }

/**
 * Facts for the risk engine's tests (#170): a quiet, legitimate baseline, and
 * the synthetic scenarios every rule change is held to.
 *
 * ⚠ THE SCENARIOS ARE THE RULES' TEST SUITE, NEVER THE MODEL'S TRAINING DATA.
 * See docs/decisions/risk.md: a model trained on what we imagine abuse looks
 * like learns our imagination.
 */
export const NOW = new Date("2026-09-28T12:00:00Z")
const DAY = 86_400_000
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

export const counts = (
  sends: number,
  hardBounces = 0,
  complaints = 0,
  softBounces = 0,
): Counts => ({
  sends,
  hardBounces,
  softBounces,
  complaints,
})

export function baseFacts(over: Partial<Facts> = {}): Facts {
  return {
    tenantId: "00000000-0000-7000-8000-000000000001",
    now: NOW,
    plan: "free",
    createdAt: daysAgo(10),
    paidSince: null,
    billingTrouble: false,
    ses: {
      current: null,
      currentOrigin: null,
      changedAt: null,
      pauses: [],
      findings: [],
    },
    rates: {
      day1: counts(20),
      day7: counts(140, 1),
      early: { sends: 140, hardBounces: 1 },
      unsubscribes7d: 0,
      trailingDaily: [20, 20, 20, 20, 20, 20],
    },
    api: {
      requests24h: 20,
      clientErrors24h: 1,
      quotaRefusals24h: 0,
      quotaDays7d: 0,
      keysCreated7d: 1,
      keyCountries24h: 1,
    },
    domains: {
      total: 1,
      added7d: 0,
      failedOrDisplaced: 0,
      youngestRegisteredAt: daysAgo(900),
      randomSubdomain: false,
      parents: ["acme.com"],
    },
    history: {
      tier: "normal",
      tierSource: "default",
      tierChangedAt: null,
      tierDemotions90d: 0,
      holds180d: 0,
      upheldHolds: 0,
    },
    owner: {
      clerkUserId: "user_owner",
      mfa: false,
      emailOnOwnDomain: false,
      workspaces: 1,
    },
    identity: identity(),
    farm: { peers: [], trusted: { template: 0, boilerplate: 0 } },
    parents: { sharedWith: 0, sharedWithHeldOrDead: 0 },
    links: { unsafe: [] },
    content: null,
    model: null,
    actor: null,
    similarity: null,
    behaviour: null,
    templates: null,
    ...over,
  }
}

export function identity(over: Partial<IdentityFacts> = {}): IdentityFacts {
  return {
    firstSeen: daysAgo(10),
    firstCountry: "DE",
    latestCountry: "DE",
    latestTimezone: "Europe/Berlin",
    countries: 1,
    torSeen: false,
    hostingSeen: false,
    anomalies: 0,
    devicePeers: 0,
    heldDevicePeers: 0,
    subnetSignupPeers: 0,
    heldSubnetPeers: 0,
    ...over,
  }
}

export function peer(over: Partial<FarmPeer> = {}): FarmPeer {
  return {
    peer: crypto.randomUUID(),
    exactShared: 0,
    nearShared: 1,
    bestSimilarity: 0.5,
    free: true,
    held: false,
    young: true,
    createdNear: true,
    sameOwner: false,
    ownerDevice: false,
    ownerSubnet: true,
    ownerCountry: true,
    ...over,
  }
}

/** Legitimate workspaces the score must leave alone. */
export const LEGIT: Record<string, () => Facts> = {
  "a developer's first day, three test emails": () =>
    baseFacts({
      createdAt: daysAgo(0.2),
      rates: {
        day1: counts(3),
        day7: counts(3),
        early: { sends: 3, hardBounces: 0 },
        unsubscribes7d: 0,
        trailingDaily: [0, 0, 0, 0, 0, 0],
      },
      domains: {
        total: 1,
        added7d: 1,
        failedOrDisplaced: 0,
        youngestRegisteredAt: daysAgo(2000),
        randomSubdomain: false,
        parents: ["dev.io"],
      },
    }),
  "a startup a month in, sending receipts": () =>
    baseFacts({
      createdAt: daysAgo(35),
      rates: {
        day1: counts(80),
        day7: counts(520, 2),
        early: { sends: 500, hardBounces: 3 },
        unsubscribes7d: 0,
        trailingDaily: [70, 75, 72, 80, 78, 76],
      },
    }),
  "a paying newsletter with ordinary unsubscribes": () =>
    baseFacts({
      plan: "paid",
      paidSince: daysAgo(120),
      createdAt: daysAgo(200),
      rates: {
        day1: counts(4000, 20, 1),
        day7: counts(26000, 150, 3, 400),
        early: { sends: 500, hardBounces: 4 },
        unsubscribes7d: 180,
        trailingDaily: [3500, 3700, 3600, 3800, 3900, 3700],
      },
      owner: { clerkUserId: "u", mfa: true, emailOnOwnDomain: true, workspaces: 1 },
    }),
  "a legitimate launch day: volume up, rates clean": () =>
    baseFacts({
      plan: "paid",
      paidSince: daysAgo(40),
      createdAt: daysAgo(60),
      rates: {
        day1: counts(3000, 10),
        day7: counts(4000, 14),
        early: { sends: 500, hardBounces: 2 },
        unsubscribes7d: 5,
        trailingDaily: [150, 160, 170, 150, 170, 190],
      },
    }),
  "an agency owner with four client workspaces": () =>
    baseFacts({
      owner: { clerkUserId: "u", mfa: true, emailOnOwnDomain: false, workspaces: 4 },
    }),
  "somebody travelling, with a VPN, once": () =>
    baseFacts({ identity: identity({ anomalies: 1, countries: 2 }) }),
  "an office network where two colleagues signed up": () =>
    baseFacts({ identity: identity({ subnetSignupPeers: 2, devicePeers: 0 }) }),
  "a small sender with one complaint in a hundred": () =>
    baseFacts({
      rates: {
        day1: counts(20),
        day7: counts(100, 0, 1),
        early: { sends: 100, hardBounces: 0 },
        unsubscribes7d: 0,
        trailingDaily: [14, 14, 14, 14, 14, 14],
      },
    }),
  "a new domain for a new brand from a trusted paying customer": () =>
    baseFacts({
      plan: "paid",
      paidSince: daysAgo(300),
      createdAt: daysAgo(400),
      rates: {
        day1: counts(500),
        day7: counts(3500, 10),
        early: { sends: 500, hardBounces: 2 },
        unsubscribes7d: 3,
        trailingDaily: [480, 500, 520, 490, 510, 500],
      },
      domains: {
        total: 3,
        added7d: 1,
        failedOrDisplaced: 0,
        youngestRegisteredAt: daysAgo(5),
        randomSubdomain: false,
        parents: ["brand.com", "acme.com"],
      },
      owner: { clerkUserId: "u", mfa: true, emailOnOwnDomain: true, workspaces: 1 },
    }),
}

/** Abuse the score must catch, with the band it must reach at least. */
export const ABUSE: Record<
  string,
  { facts: () => Facts; atLeast: "elevated" | "high" | "critical" }
> = {
  "a bought list: first sends bounce hard": {
    atLeast: "high",
    facts: () =>
      baseFacts({
        createdAt: daysAgo(2),
        rates: {
          day1: counts(100, 14, 1),
          day7: counts(180, 20, 1),
          early: { sends: 180, hardBounces: 20 },
          unsubscribes7d: 0,
          trailingDaily: [0, 0, 0, 0, 40, 40],
        },
        domains: {
          total: 1,
          added7d: 1,
          failedOrDisplaced: 0,
          youngestRegisteredAt: daysAgo(3),
          randomSubdomain: false,
          parents: ["cheap-deals.top"],
        },
      }),
  },
  "a farm: five linked free workspaces sending the same mail": {
    atLeast: "high",
    facts: () =>
      baseFacts({
        createdAt: daysAgo(1),
        rates: {
          day1: counts(95),
          day7: counts(95),
          early: { sends: 95, hardBounces: 2 },
          unsubscribes7d: 0,
          trailingDaily: [0, 0, 0, 0, 0, 0],
        },
        farm: { peers: [peer(), peer(), peer(), peer(), peer()], trusted: NO_TRUST },
        domains: {
          total: 1,
          added7d: 1,
          failedOrDisplaced: 0,
          youngestRegisteredAt: daysAgo(4),
          randomSubdomain: true,
          parents: ["mailer-x.top"],
        },
        parents: { sharedWith: 4, sharedWithHeldOrDead: 0 },
      }),
  },
  "a farm member after another member was held": {
    atLeast: "critical",
    facts: () =>
      baseFacts({
        createdAt: daysAgo(1),
        farm: {
          peers: [peer({ held: true }), peer(), peer(), peer()],
          trusted: NO_TRUST,
        },
        parents: { sharedWith: 3, sharedWithHeldOrDead: 1 },
        identity: identity({ heldDevicePeers: 1, devicePeers: 3 }),
      }),
  },
  "phishing: a link Web Risk lists": {
    atLeast: "critical",
    facts: () =>
      baseFacts({
        links: {
          unsafe: [
            {
              host: "login-verify.example",
              verdict: "SOCIAL_ENGINEERING",
              day: "2026-09-28",
            },
          ],
        },
      }),
  },
  "AWS Trust & Safety paused the workspace": {
    atLeast: "high",
    facts: () =>
      baseFacts({
        ses: {
          current: "disabled",
          currentOrigin: "aws_managed",
          changedAt: daysAgo(1),
          pauses: [{ origin: "aws_managed", at: daysAgo(1) }],
          findings: [],
        },
      }),
  },
  "complaints at three times Gmail's limit": {
    atLeast: "elevated",
    facts: () =>
      baseFacts({
        rates: {
          day1: counts(300, 0, 2),
          day7: counts(1500, 3, 6),
          early: { sends: 500, hardBounces: 2 },
          unsubscribes7d: 2,
          trailingDaily: [200, 200, 200, 200, 200, 200],
        },
      }),
  },
  "ban evasion: the owner's device belongs to a held workspace's owner": {
    atLeast: "elevated",
    facts: () =>
      baseFacts({
        createdAt: daysAgo(0.5),
        identity: identity({ heldDevicePeers: 1, devicePeers: 1, hostingSeen: true }),
      }),
  },
  "a sign-up burst from one network on a fresh domain, hammering the cap": {
    atLeast: "elevated",
    facts: () =>
      baseFacts({
        createdAt: daysAgo(1),
        rates: {
          day1: counts(100),
          day7: counts(100),
          early: { sends: 100, hardBounces: 3 },
          unsubscribes7d: 0,
          trailingDaily: [0, 0, 0, 0, 0, 0],
        },
        api: {
          requests24h: 600,
          clientErrors24h: 20,
          quotaRefusals24h: 450,
          quotaDays7d: 1,
          keysCreated7d: 6,
          keyCountries24h: 1,
        },
        identity: identity({ subnetSignupPeers: 8, devicePeers: 4, torSeen: true }),
        domains: {
          total: 1,
          added7d: 1,
          failedOrDisplaced: 0,
          youngestRegisteredAt: daysAgo(2),
          randomSubdomain: true,
          parents: ["x7.top"],
        },
      }),
  },
  "an open HIGH finding and a bad week": {
    atLeast: "high",
    facts: () =>
      baseFacts({
        ses: {
          current: "enabled",
          currentOrigin: null,
          changedAt: null,
          pauses: [],
          findings: [
            { type: "bounce", impact: "high", openedAt: daysAgo(1), resolvedAt: null },
          ],
        },
        rates: {
          day1: counts(400, 40),
          day7: counts(1200, 70, 1),
          early: { sends: 500, hardBounces: 20 },
          unsubscribes7d: 4,
          trailingDaily: [100, 120, 140, 150, 130, 160],
        },
      }),
  },
}
