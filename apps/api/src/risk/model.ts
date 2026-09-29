import { linkingFeatures } from "./rules.js"
import type { Facts } from "./types.js"

/**
 * The learned half of the score (#170): a logistic regression over features
 * derived from `Facts`.
 *
 * ⚠ LOGISTIC REGRESSION, NOT SOMETHING CLEVERER, BECAUSE IT CAN BE EXPLAINED.
 * Each feature's contribution is its weight times its value, which is what an
 * appeal and a staff review need; a model that can only say "0.93" is a
 * liability under GDPR Article 22 however accurate it is.
 *
 * ⚠ IT IS ONE RULE AMONG THE OTHERS AND ONLY WHEN IT HAS EARNED IT. `train`
 * evaluates on a held-out split of REAL labels and marks the model active
 * only when every bar in `ACTIVATION` is met. Until then it is stored,
 * consulted by nobody, and the rules carry the whole score. Synthetic
 * scenarios test the rules; they never train this.
 */
/**
 * ⚠ THE FIRST 39 ARE THE BEHAVIOUR VECTOR AND THEIR ORDER IS FROZEN. They are
 * stored in `core.behaviour_vectors` (vector(39)); reordering or inserting one
 * would silently compare today's vectors with last month's in a different
 * space. New features go in `EXTRA_FEATURES`, which the model learns from and
 * the behaviour vector does not carry.
 */
export const BEHAVIOUR_FEATURES = [
  "age_days_log",
  "paid",
  "ses_paused_now",
  "ses_pauses",
  "ses_high_open",
  "ses_low_open",
  "hard_bounce_7d",
  "complaint_7d",
  "soft_bounce_7d",
  "hard_bounce_24h",
  "sends_7d_log",
  "early_bounce",
  "unsubscribe_7d",
  "quota_days_7d",
  "api_error_rate",
  "keys_created_7d",
  "key_countries",
  "domains_added_7d",
  "domains_failed",
  "domain_age_log",
  "random_subdomain",
  "parent_shared",
  "parent_held",
  "owner_workspaces",
  "owner_mfa",
  "owner_email_domain",
  "farm_linked",
  "farm_loose",
  "farm_held",
  "id_device_peers",
  "id_subnet_peers",
  "id_held_peers",
  "id_tor",
  "id_hosting",
  "id_anomalies",
  "id_countries",
  "unsafe_links",
  "tier_demotions",
  "upheld_holds",
] as const

/**
 * Features the model learns from beyond the behaviour vector: the actor's
 * velocity and what the similarity layer found. ⚠ NOT IN THE BEHAVIOUR VECTOR,
 * because "how close to labelled abusers" must not be computed from itself.
 */
export const EXTRA_FEATURES = [
  "actor_workspaces_24h",
  "actor_linked_workspaces",
  "content_tainted_similar",
  "content_young_free_similar",
  "behaviour_abuse_share",
] as const

export const FEATURE_NAMES = [...BEHAVIOUR_FEATURES, ...EXTRA_FEATURES] as const

export type FeatureName = (typeof FEATURE_NAMES)[number]
export type Features = Record<FeatureName, number>

const DAY = 24 * 60 * 60 * 1000
const rate = (n: number, d: number) => (d > 0 ? n / d : 0)
const log1p = (n: number) => Math.log1p(Math.max(0, n))

export function features(f: Facts): Features {
  const domainAge = f.domains.youngestRegisteredAt
    ? (f.now.getTime() - f.domains.youngestRegisteredAt.getTime()) / DAY
    : 3650
  const linked = f.farm.peers.filter((p) => linkingFeatures(p) >= 2).length
  return {
    age_days_log: log1p((f.now.getTime() - f.createdAt.getTime()) / DAY),
    paid: f.plan === "paid" ? 1 : 0,
    ses_paused_now: f.ses.current === "disabled" ? 1 : 0,
    ses_pauses: f.ses.pauses.length,
    ses_high_open: f.ses.findings.filter((x) => x.impact === "high" && !x.resolvedAt)
      .length,
    ses_low_open: f.ses.findings.filter((x) => x.impact === "low" && !x.resolvedAt)
      .length,
    hard_bounce_7d: rate(f.rates.day7.hardBounces, f.rates.day7.sends),
    complaint_7d: rate(f.rates.day7.complaints, f.rates.day7.sends) * 100,
    soft_bounce_7d: rate(f.rates.day7.softBounces, f.rates.day7.sends),
    hard_bounce_24h: rate(f.rates.day1.hardBounces, f.rates.day1.sends),
    sends_7d_log: log1p(f.rates.day7.sends),
    early_bounce: rate(f.rates.early.hardBounces, f.rates.early.sends),
    unsubscribe_7d: rate(f.rates.unsubscribes7d, f.rates.day7.sends),
    quota_days_7d: f.api.quotaDays7d,
    api_error_rate: rate(f.api.clientErrors24h, f.api.requests24h),
    keys_created_7d: log1p(f.api.keysCreated7d),
    key_countries: f.api.keyCountries24h,
    domains_added_7d: log1p(f.domains.added7d),
    domains_failed: log1p(f.domains.failedOrDisplaced),
    domain_age_log: log1p(domainAge),
    random_subdomain: f.domains.randomSubdomain ? 1 : 0,
    parent_shared: log1p(f.parents.sharedWith),
    parent_held: f.parents.sharedWithHeldOrDead > 0 ? 1 : 0,
    owner_workspaces: log1p(f.owner.workspaces),
    owner_mfa: f.owner.mfa ? 1 : 0,
    owner_email_domain: f.owner.emailOnOwnDomain ? 1 : 0,
    farm_linked: log1p(linked),
    farm_loose: log1p(f.farm.peers.length - linked),
    farm_held: f.farm.peers.some((p) => p.held) ? 1 : 0,
    id_device_peers: log1p(f.identity?.devicePeers ?? 0),
    id_subnet_peers: log1p(f.identity?.subnetSignupPeers ?? 0),
    id_held_peers:
      (f.identity?.heldDevicePeers ?? 0) + (f.identity?.heldSubnetPeers ?? 0) > 0
        ? 1
        : 0,
    id_tor: f.identity?.torSeen ? 1 : 0,
    id_hosting: f.identity?.hostingSeen ? 1 : 0,
    id_anomalies: log1p(f.identity?.anomalies ?? 0),
    id_countries: log1p(f.identity?.countries ?? 0),
    unsafe_links: f.links.unsafe.length > 0 ? 1 : 0,
    tier_demotions: f.history.tierDemotions90d,
    upheld_holds: f.history.upheldHolds,
    actor_workspaces_24h: log1p(f.actor?.workspaces24h ?? 0),
    actor_linked_workspaces: log1p(f.actor?.linkedWorkspaces ?? 0),
    content_tainted_similar: log1p(f.similarity?.taintedSimilar ?? 0),
    content_young_free_similar: log1p(f.similarity?.youngFreeSimilar ?? 0),
    behaviour_abuse_share:
      f.behaviour && f.behaviour.labelled > 0
        ? f.behaviour.abuse / f.behaviour.labelled
        : 0,
  }
}

export interface ModelWeights {
  features: readonly string[]
  weights: number[]
  bias: number
  mean: number[]
  std: number[]
}

export interface LabeledRow {
  label: "abuse" | "legit"
  weight: number
  features: Partial<Record<string, number>>
}

export interface Evaluation {
  labels: number
  abuse: number
  legit: number
  holdout: number
  auc: number | null
  precisionAt90: number | null
  recallAt90: number | null
  reason: string
}

/** The bars a model must clear before it is allowed to add a single point. */
export const ACTIVATION = { minLabels: 200, minPerClass: 30, minAuc: 0.85 } as const

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

function vector(
  row: Partial<Record<string, number>>,
  names: readonly string[],
): number[] {
  return names.map((n) => {
    const v = row[n]
    return typeof v === "number" && Number.isFinite(v) ? v : 0
  })
}

export function predict(
  model: ModelWeights,
  feats: Partial<Record<string, number>>,
): number {
  const x = vector(feats, model.features)
  let z = model.bias
  for (let i = 0; i < x.length; i++) {
    const std = model.std[i] || 1
    z += model.weights[i]! * ((x[i]! - model.mean[i]!) / std)
  }
  return sigmoid(z)
}

/** Each feature's pull on one prediction, largest first: the explanation. */
export function explainPrediction(
  model: ModelWeights,
  feats: Partial<Record<string, number>>,
) {
  const x = vector(feats, model.features)
  return model.features
    .map((name, i) => ({
      feature: name,
      pull: model.weights[i]! * ((x[i]! - model.mean[i]!) / (model.std[i] || 1)),
    }))
    .sort((a, b) => Math.abs(b.pull) - Math.abs(a.pull))
}

/**
 * Fits a weighted, L2-regularised logistic regression by gradient descent.
 * Small data, small model: a few thousand iterations on a few hundred rows is
 * milliseconds.
 */
export function fit(
  rows: readonly LabeledRow[],
  names: readonly string[] = FEATURE_NAMES,
  { iterations = 3000, rate: lr = 0.1, l2 = 0.01 } = {},
): ModelWeights {
  const X = rows.map((r) => vector(r.features, names))
  const y = rows.map((r) => (r.label === "abuse" ? 1 : 0))
  const w = rows.map((r) => r.weight)
  const d = names.length
  const mean = Array.from({ length: d }, (_, j) => avg(X.map((x) => x[j]!)))
  const std = Array.from({ length: d }, (_, j) => {
    const m = mean[j]!
    const s = Math.sqrt(avg(X.map((x) => (x[j]! - m) ** 2)))
    return s > 1e-9 ? s : 1
  })
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]!) / std[j]!))
  const weights = new Array<number>(d).fill(0)
  let bias = 0
  const total = w.reduce((a, b) => a + b, 0) || 1
  for (let it = 0; it < iterations; it++) {
    const grad = new Array<number>(d).fill(0)
    let gb = 0
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i]!
      let s = bias
      for (let j = 0; j < d; j++) s += weights[j]! * z[j]!
      const err = (sigmoid(s) - y[i]!) * w[i]!
      for (let j = 0; j < d; j++) grad[j]! += err * z[j]!
      gb += err
    }
    for (let j = 0; j < d; j++)
      weights[j]! -= lr * (grad[j]! / total + l2 * weights[j]!)
    bias -= lr * (gb / total)
  }
  return { features: [...names], weights, bias, mean, std }
}

/** Area under the ROC curve, by the rank-sum formula. Null for one class. */
export function auc(
  scores: readonly number[],
  labels: readonly number[],
): number | null {
  const pos = labels.filter((l) => l === 1).length
  const neg = labels.length - pos
  if (pos === 0 || neg === 0) return null
  const order = scores
    .map((s, i) => [s, labels[i]!] as const)
    .sort((a, b) => a[0] - b[0])
  let rankSum = 0
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++
    const rank = (i + j + 2) / 2
    for (let k = i; k <= j; k++) if (order[k]![1] === 1) rankSum += rank
    i = j + 1
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg)
}

/**
 * Trains on every label, evaluates on a deterministic 25% hold-out, and says
 * whether the result may be activated.
 *
 * ⚠ THE HOLD-OUT IS CHOSEN BY POSITION WITHIN EACH CLASS, NOT AT RANDOM, so
 * the same labels always produce the same verdict and a retrain cannot be
 * rerun until a lucky split activates it.
 */
export function train(rows: readonly LabeledRow[]): {
  model: ModelWeights
  evaluation: Evaluation
  active: boolean
} {
  const abuse = rows.filter((r) => r.label === "abuse")
  const legit = rows.filter((r) => r.label === "legit")
  const split = <T>(xs: readonly T[]) => ({
    test: xs.filter((_, i) => i % 4 === 3),
    fit: xs.filter((_, i) => i % 4 !== 3),
  })
  const a = split(abuse)
  const l = split(legit)
  const trained = fit([...a.fit, ...l.fit])
  const test = [...a.test, ...l.test]
  const scores = test.map((r) => predict(trained, r.features))
  const labels = test.map((r) => (r.label === "abuse" ? 1 : 0))
  const area = auc(scores, labels)
  const flagged = scores.map((s) => s >= 0.9)
  const tp = flagged.filter((f, i) => f && labels[i] === 1).length
  const fp = flagged.filter((f, i) => f && labels[i] === 0).length
  const fn = flagged.filter((f, i) => !f && labels[i] === 1).length

  const shortfalls = [
    rows.length < ACTIVATION.minLabels &&
      `${rows.length} labels, needs ${ACTIVATION.minLabels}`,
    (abuse.length < ACTIVATION.minPerClass || legit.length < ACTIVATION.minPerClass) &&
      `${abuse.length} abuse / ${legit.length} legit, needs ${ACTIVATION.minPerClass} of each`,
    (area === null || area < ACTIVATION.minAuc) &&
      `hold-out AUC ${area === null ? "n/a" : area.toFixed(3)}, needs ${ACTIVATION.minAuc}`,
  ].filter(Boolean) as string[]

  // The final model uses every label; the evaluation is of the same recipe.
  const model = rows.length > 0 ? fit(rows) : trained
  return {
    model,
    active: shortfalls.length === 0,
    evaluation: {
      labels: rows.length,
      abuse: abuse.length,
      legit: legit.length,
      holdout: test.length,
      auc: area,
      precisionAt90: tp + fp > 0 ? tp / (tp + fp) : null,
      recallAt90: tp + fn > 0 ? tp / (tp + fn) : null,
      reason: shortfalls.length === 0 ? "activated" : shortfalls.join("; "),
    },
  }
}

function avg(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
