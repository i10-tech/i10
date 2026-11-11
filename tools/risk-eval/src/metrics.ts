import type { Answers, Question } from "./judge.js"
import { type Label, type Mail, yearBucket } from "./schema.js"

/** One scored example: the judge's probability and the ground truth. */
export interface Scored {
  score: number
  truth: boolean
}

export interface Confusion {
  tp: number
  fp: number
  tn: number
  fn: number
}

/** A mail is flagged when its score is AT OR ABOVE the threshold. */
export function confusionAt(items: Scored[], threshold: number): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 }
  for (const { score, truth } of items) {
    const flagged = score >= threshold
    if (flagged && truth) c.tp++
    else if (flagged) c.fp++
    else if (truth) c.fn++
    else c.tn++
  }
  return c
}

export interface Rates {
  precision: number | null
  recall: number | null
  f1: number | null
  fpr: number | null
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den
}

export function rates(c: Confusion): Rates {
  const precision = ratio(c.tp, c.tp + c.fp)
  const recall = ratio(c.tp, c.tp + c.fn)
  const f1 =
    precision === null || recall === null
      ? null
      : precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1, fpr: ratio(c.fp, c.fp + c.tn) }
}

export const SWEEP_THRESHOLDS = Array.from(
  { length: 19 },
  (_, i) => Math.round((i + 1) * 5) / 100,
)

export interface SweepRow extends Rates, Confusion {
  threshold: number
}

export function sweep(
  items: Scored[],
  thresholds: number[] = SWEEP_THRESHOLDS,
): SweepRow[] {
  return thresholds.map((threshold) => {
    const c = confusionAt(items, threshold)
    return { threshold, ...c, ...rates(c) }
  })
}

/**
 * ROC AUC as the probability that a random positive outscores a random
 * negative, counting ties as one half (the Mann-Whitney U statistic, with
 * average ranks). Null when either class is empty.
 */
export function rocAuc(items: Scored[]): number | null {
  const positives = items.filter((i) => i.truth).length
  const negatives = items.length - positives
  if (positives === 0 || negatives === 0) return null
  const sorted = [...items].sort((a, b) => a.score - b.score)
  let rankSumPositive = 0
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1]?.score === sorted[i]?.score) j++
    const averageRank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) if (sorted[k]?.truth) rankSumPositive += averageRank
    i = j + 1
  }
  return (rankSumPositive - (positives * (positives + 1)) / 2) / (positives * negatives)
}

export interface CalibrationBin {
  lo: number
  hi: number
  n: number
  meanScore: number | null
  positiveRate: number | null
}

/**
 * Ten equal-width bins over [0, 1] (the last includes 1). ECE is the
 * count-weighted mean of |positive rate - mean score| over the bins.
 */
export function calibration(
  items: Scored[],
  binCount = 10,
): { bins: CalibrationBin[]; ece: number | null } {
  const sums = Array.from({ length: binCount }, () => ({
    n: 0,
    score: 0,
    positives: 0,
  }))
  for (const { score, truth } of items) {
    const bin = sums[Math.min(binCount - 1, Math.floor(score * binCount))]
    if (bin === undefined) continue
    bin.n++
    bin.score += score
    if (truth) bin.positives++
  }
  let weighted = 0
  const bins = sums.map((s, i): CalibrationBin => {
    if (s.n > 0) weighted += Math.abs(s.positives / s.n - s.score / s.n) * s.n
    return {
      lo: i / binCount,
      hi: (i + 1) / binCount,
      n: s.n,
      meanScore: ratio(s.score, s.n),
      positiveRate: ratio(s.positives, s.n),
    }
  })
  return { bins, ece: items.length === 0 ? null : weighted / items.length }
}

/**
 * The highest threshold at which recall is at least `target`: the operating
 * point "catch 90% of the bad mail" with the fewest flags. Null when there are
 * no positives. Scores are compared with `>=`, so ties are kept together.
 */
export function thresholdForRecall(items: Scored[], target: number): number | null {
  const positives = items.filter((i) => i.truth).map((i) => i.score)
  if (positives.length === 0) return null
  const needed = Math.ceil(target * positives.length - 1e-9)
  const descending = positives.sort((a, b) => b - a)
  return descending[Math.max(0, needed - 1)] ?? null
}

/** What a question's ground truth is for a label; undefined = not scored. */
export function truthFor(question: Question, label: Label): boolean | undefined {
  if (question === "phishing") return label === "phishing"
  // Phishing is unwanted mail too, so it is neither a spam hit nor a spam miss.
  if (question === "spam") return label === "phishing" ? undefined : label === "spam"
  return undefined
}

export const SCORED_QUESTIONS: Question[] = ["phishing", "spam"]

export interface EvalRow {
  mail: Mail
  answers: Answers
}

function scoredItems(question: Question, rows: EvalRow[]): Scored[] {
  const items: Scored[] = []
  for (const { mail, answers } of rows) {
    const score = answers[question]
    const truth = truthFor(question, mail.label)
    if (score !== undefined && truth !== undefined) items.push({ score, truth })
  }
  return items
}

export interface Headline {
  /** Highest threshold with recall >= `recallTarget` on the phishing mails. */
  threshold: number | null
  recallTarget: number
  recallAchieved: number | null
  legit: number
  falsePositives: number
  /** Share of legitimate mail flagged at that threshold. The number to watch. */
  falsePositiveRate: number | null
}

/**
 * Flagging honest mail is the expensive error, so the headline is the
 * false-positive rate on LEGIT mail at the threshold that catches 90% of
 * phishing. Only legit mail counts as a false positive here: a spam mail
 * flagged as phishing is a different, cheaper mistake and is in the confusion
 * counts instead.
 */
export function headline(
  rows: EvalRow[],
  threshold: number | null,
  recallTarget = 0.9,
): Headline {
  const legit = rows.filter(
    (r) => r.mail.label === "legit" && r.answers.phishing !== undefined,
  )
  const phishing = scoredItems("phishing", rows).filter((i) => i.truth)
  const flagged =
    threshold === null
      ? 0
      : legit.filter((r) => (r.answers.phishing ?? 0) >= threshold).length
  return {
    threshold,
    recallTarget,
    recallAchieved:
      threshold === null || phishing.length === 0
        ? null
        : phishing.filter((i) => i.score >= threshold).length / phishing.length,
    legit: legit.length,
    falsePositives: flagged,
    falsePositiveRate: threshold === null ? null : ratio(flagged, legit.length),
  }
}

export interface SliceMetrics {
  n: number
  positives: number
  atHalf: Confusion & Rates
  auc: number | null
  ece: number | null
  /** Only the phishing question has a headline. */
  headline: Headline | null
}

function sliceMetrics(
  question: Question,
  rows: EvalRow[],
  threshold: number | null,
  atHalf: number,
): SliceMetrics {
  const items = scoredItems(question, rows)
  const c = confusionAt(items, atHalf)
  return {
    n: items.length,
    positives: items.filter((i) => i.truth).length,
    atHalf: { ...c, ...rates(c) },
    auc: rocAuc(items),
    ece: calibration(items).ece,
    headline: question === "phishing" ? headline(rows, threshold) : null,
  }
}

export const BREAKDOWNS = ["dataset", "lang", "yearBucket", "origin"] as const
export type Breakdown = (typeof BREAKDOWNS)[number]

export function sliceKey(breakdown: Breakdown, mail: Mail): string {
  switch (breakdown) {
    case "dataset":
      return mail.dataset
    case "lang":
      return mail.lang
    case "yearBucket":
      return yearBucket(mail.year)
    case "origin":
      return mail.synthetic ? "synthetic" : "real"
  }
}

export interface QuestionReport {
  question: Question
  overall: SliceMetrics
  sweep: SweepRow[]
  calibration: { bins: CalibrationBin[]; ece: number | null }
  breakdowns: Record<Breakdown, Record<string, SliceMetrics>>
}

/**
 * Everything the report shows for one question, or null when the judge did not
 * answer it or the labels give it no ground truth. The headline threshold is
 * chosen ONCE, on the overall phishing mails, and applied unchanged to every
 * slice: a per-slice threshold would hide exactly the failures the slices are
 * there to expose.
 */
export function evaluateQuestion(
  question: Question,
  rows: EvalRow[],
  atHalf = 0.5,
): QuestionReport | null {
  const items = scoredItems(question, rows)
  if (items.length === 0) return null
  const threshold = thresholdForRecall(scoredItems("phishing", rows), 0.9)

  const breakdowns = {} as QuestionReport["breakdowns"]
  for (const breakdown of BREAKDOWNS) {
    const groups = new Map<string, EvalRow[]>()
    for (const row of rows) {
      const key = sliceKey(breakdown, row.mail)
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }
    breakdowns[breakdown] = Object.fromEntries(
      [...groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, group]) => [key, sliceMetrics(question, group, threshold, atHalf)]),
    )
  }
  return {
    question,
    overall: sliceMetrics(question, rows, threshold, atHalf),
    sweep: sweep(items),
    calibration: calibration(items),
    breakdowns,
  }
}
