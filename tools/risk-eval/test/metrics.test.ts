import { describe, expect, it } from "bun:test"
import type { Answers } from "../src/judge.js"
import {
  type EvalRow,
  type Scored,
  calibration,
  confusionAt,
  evaluateQuestion,
  headline,
  rates,
  rocAuc,
  sweep,
  thresholdForRecall,
  truthFor,
} from "../src/metrics.js"
import { mail } from "./helpers.js"

// Eight examples worked out by hand:
//   positives 0.9 0.8 0.6 0.2, negatives 0.7 0.4 0.3 0.1
const items: Scored[] = [
  { score: 0.9, truth: true },
  { score: 0.8, truth: true },
  { score: 0.7, truth: false },
  { score: 0.6, truth: true },
  { score: 0.4, truth: false },
  { score: 0.3, truth: false },
  { score: 0.2, truth: true },
  { score: 0.1, truth: false },
]

describe("confusion and rates", () => {
  it("counts at a threshold, flagging scores at or above it", () => {
    // flagged at 0.5: 0.9T 0.8T 0.7F 0.6T -> tp 3, fp 1; below: 0.4F 0.3F 0.2T 0.1F -> fn 1, tn 3
    expect(confusionAt(items, 0.5)).toEqual({ tp: 3, fp: 1, tn: 3, fn: 1 })
    expect(confusionAt(items, 0.6).tp).toBe(2 + 1)
  })

  it("derives precision, recall, F1 and FPR, with null for an empty denominator", () => {
    const r = rates({ tp: 3, fp: 1, tn: 3, fn: 1 })
    expect(r).toEqual({ precision: 0.75, recall: 0.75, f1: 0.75, fpr: 0.25 })
    expect(rates({ tp: 0, fp: 0, tn: 5, fn: 0 })).toEqual({
      precision: null,
      recall: null,
      f1: null,
      fpr: 0,
    })
    expect(rates({ tp: 0, fp: 2, tn: 0, fn: 3 }).f1).toBe(0)
  })

  it("sweeps nineteen thresholds from 0.05 to 0.95", () => {
    const rows = sweep(items)
    expect(rows).toHaveLength(19)
    expect(rows[0]?.threshold).toBe(0.05)
    expect(rows[18]?.threshold).toBe(0.95)
    expect(rows.find((r) => r.threshold === 0.5)).toMatchObject({
      tp: 3,
      fp: 1,
      tn: 3,
      fn: 1,
    })
  })
})

describe("rocAuc", () => {
  it("is the share of positive-negative pairs ranked correctly: 12 of 16", () => {
    expect(rocAuc(items)).toBe(0.75)
  })

  it("scores ties as half and a perfect or reversed ranking as 1 or 0", () => {
    expect(
      rocAuc([
        { score: 0.5, truth: true },
        { score: 0.5, truth: false },
      ]),
    ).toBe(0.5)
    expect(
      rocAuc([
        { score: 0.9, truth: true },
        { score: 0.1, truth: false },
      ]),
    ).toBe(1)
    expect(
      rocAuc([
        { score: 0.1, truth: true },
        { score: 0.9, truth: false },
      ]),
    ).toBe(0)
  })

  it("is null when a class is missing", () => {
    expect(rocAuc([{ score: 0.3, truth: true }])).toBeNull()
    expect(rocAuc([])).toBeNull()
  })
})

describe("calibration", () => {
  it("bins by tenths and weights |positive rate - mean score| by bin size: ECE 3.0 / 8", () => {
    const { bins, ece } = calibration(items)
    expect(bins).toHaveLength(10)
    expect(ece).toBeCloseTo(0.375, 10)
    expect(bins[9]).toMatchObject({ n: 1, meanScore: 0.9, positiveRate: 1 })
    expect(bins[0]).toMatchObject({ n: 0, meanScore: null, positiveRate: null })
  })

  it("puts a score of exactly 1 in the last bin", () => {
    const { bins } = calibration([{ score: 1, truth: true }])
    expect(bins[9]?.n).toBe(1)
  })
})

describe("thresholdForRecall", () => {
  it("is the score of the k-th highest positive, k = ceil(target * positives)", () => {
    expect(thresholdForRecall(items, 0.9)).toBe(0.2) // needs all 4
    expect(thresholdForRecall(items, 0.75)).toBe(0.6) // needs 3
    expect(thresholdForRecall(items, 0.5)).toBe(0.8) // needs 2
  })

  it("is null with no positives", () => {
    expect(thresholdForRecall([{ score: 0.5, truth: false }], 0.9)).toBeNull()
  })
})

describe("ground truth", () => {
  it("scores phishing against everything else and spam against legit only", () => {
    expect(truthFor("phishing", "phishing")).toBe(true)
    expect(truthFor("phishing", "spam")).toBe(false)
    expect(truthFor("phishing", "legit")).toBe(false)
    expect(truthFor("spam", "spam")).toBe(true)
    expect(truthFor("spam", "legit")).toBe(false)
    expect(truthFor("spam", "phishing")).toBeUndefined()
    expect(truthFor("is_marketing", "legit")).toBeUndefined()
  })
})

function row(
  label: "phishing" | "spam" | "legit",
  phishing: number,
  extra: Partial<Parameters<typeof mail>[0]> = {},
): EvalRow {
  const answers: Answers = { phishing }
  return { mail: mail({ label, ...extra }), answers }
}

describe("headline: false-positive rate on legit mail at 90% phishing recall", () => {
  // 10 phishing 0.95 .. 0.50, so 90% needs 9 of them -> threshold 0.55 (recall 0.9)
  // 5 legit 0.6 0.55 0.4 0.3 0.2 -> flagged at >= 0.55: two of five
  const phishing = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5].map((s) =>
    row("phishing", s),
  )
  const legit = [0.6, 0.55, 0.4, 0.3, 0.2].map((s) => row("legit", s))
  // spam flagged as phishing is an error, but not THE error: it must not move the headline
  const spam = [row("spam", 0.99), row("spam", 0.98)]

  it("uses the threshold that gives 90% recall and counts only legit mail as false positives", () => {
    const rows = [...phishing, ...legit, ...spam]
    const report = evaluateQuestion("phishing", rows)
    const h = report?.overall.headline
    expect(h?.threshold).toBe(0.55)
    expect(h?.recallAchieved).toBeCloseTo(0.9, 10)
    expect(h).toMatchObject({ legit: 5, falsePositives: 2, falsePositiveRate: 0.4 })
  })

  it("applies the same threshold to every slice instead of re-deriving it", () => {
    const tagged = [
      ...phishing.map((r) => ({ ...r, mail: { ...r.mail, dataset: "a" } })),
      ...legit.map((r, i) => ({
        ...r,
        mail: { ...r.mail, dataset: i < 2 ? "a" : "b" },
      })),
    ]
    const report = evaluateQuestion("phishing", tagged)
    expect(report?.breakdowns.dataset.a?.headline).toMatchObject({
      legit: 2,
      falsePositiveRate: 1,
    })
    expect(report?.breakdowns.dataset.b?.headline).toMatchObject({
      legit: 3,
      falsePositiveRate: 0,
    })
  })

  it("returns null fields when there is nothing to measure", () => {
    expect(headline([], null)).toMatchObject({
      threshold: null,
      falsePositiveRate: null,
      legit: 0,
    })
    expect(evaluateQuestion("phishing", [])).toBeNull()
  })
})

describe("evaluateQuestion", () => {
  it("leaves phishing mail out of the spam question and skips questions without truth", () => {
    const rows: EvalRow[] = [
      { mail: mail({ label: "spam" }), answers: { spam: 0.9, is_marketing: 0.9 } },
      { mail: mail({ label: "legit" }), answers: { spam: 0.1 } },
      { mail: mail({ label: "phishing" }), answers: { spam: 0.9 } },
    ]
    const report = evaluateQuestion("spam", rows)
    expect(report?.overall.n).toBe(2)
    expect(report?.overall.headline).toBeNull()
    expect(evaluateQuestion("is_marketing", rows)).toBeNull()
  })

  it("breaks results down by dataset, language, year bucket and real or synthetic", () => {
    const rows: EvalRow[] = [
      {
        mail: mail({ label: "phishing", dataset: "nazario", lang: "ar", year: 2024 }),
        answers: { phishing: 0.9 },
      },
      {
        mail: mail({ label: "legit", dataset: "synth", lang: "id", synthetic: true }),
        answers: { phishing: 0.1 },
      },
    ]
    const report = evaluateQuestion("phishing", rows)
    expect(Object.keys(report?.breakdowns.dataset ?? {})).toEqual(["nazario", "synth"])
    expect(Object.keys(report?.breakdowns.lang ?? {})).toEqual(["ar", "id"])
    expect(Object.keys(report?.breakdowns.yearBucket ?? {})).toEqual([
      "2023+",
      "unknown",
    ])
    expect(Object.keys(report?.breakdowns.origin ?? {})).toEqual(["real", "synthetic"])
  })
})
