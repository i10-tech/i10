import { describe, expect, it } from "bun:test"
import {
  ACTIVATION,
  auc,
  explainPrediction,
  features,
  FEATURE_NAMES,
  fit,
  predict,
  train,
  type LabeledRow,
} from "../src/risk/model.js"
import { ABUSE, LEGIT } from "./risk-fixtures.js"

/**
 * The learned half of the score (#170).
 *
 * ⚠ SYNTHETIC ROWS HERE TEST THE MACHINERY - that it learns a separable
 * signal, evaluates honestly and refuses to activate on too little - never
 * the model we ship, which only ever trains on real labels.
 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function rows(n: number, seed = 1): LabeledRow[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const abuse = i % 2 === 0
    return {
      label: abuse ? "abuse" : "legit",
      weight: 1,
      features: {
        hard_bounce_7d: abuse ? 0.06 + r() * 0.1 : r() * 0.02,
        farm_linked: abuse ? 1 + r() * 2 : r() * 0.3,
        age_days_log: abuse ? r() * 2 : 2 + r() * 4,
        owner_mfa: abuse ? 0 : r() > 0.5 ? 1 : 0,
      },
    }
  })
}

describe("AUC", () => {
  it("is 1 for a perfect ranking, 0.5 for a tie, null for one class", () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1)
    expect(auc([0.5, 0.5], [0, 1])).toBe(0.5)
    expect(auc([0.3, 0.4], [1, 1])).toBeNull()
  })
})

describe("fitting", () => {
  it("learns a separable signal", () => {
    const data = rows(300)
    const m = fit(data)
    const scores = data.map((r) => predict(m, r.features))
    expect(
      auc(
        scores,
        data.map((r) => (r.label === "abuse" ? 1 : 0)),
      )!,
    ).toBeGreaterThan(0.95)
  })

  it("explains a prediction by feature, largest pull first", () => {
    const m = fit(rows(200))
    const pulls = explainPrediction(m, rows(1)[0]!.features)
    expect(pulls).toHaveLength(FEATURE_NAMES.length)
    expect(Math.abs(pulls[0]!.pull)).toBeGreaterThanOrEqual(Math.abs(pulls[1]!.pull))
  })

  it("ignores features it has never seen and non-numbers", () => {
    const m = fit(rows(100))
    expect(
      Number.isFinite(predict(m, { unknown: 5, hard_bounce_7d: Number.NaN })),
    ).toBe(true)
  })
})

describe("the activation gate", () => {
  it("stays inactive on too few labels, and says why", () => {
    const r = train(rows(50))
    expect(r.active).toBe(false)
    expect(r.evaluation.reason).toContain(`needs ${ACTIVATION.minLabels}`)
  })

  it("stays inactive with one class missing", () => {
    const r = train(rows(300).filter((x) => x.label === "legit"))
    expect(r.active).toBe(false)
  })

  it("activates on enough separable labels", () => {
    const r = train(rows(400))
    expect(r.evaluation.auc!).toBeGreaterThan(ACTIVATION.minAuc)
    expect(r.active).toBe(true)
  })

  it("stays inactive when the labels carry no signal", () => {
    const r0 = rng(7)
    const noise: LabeledRow[] = Array.from({ length: 400 }, (_, i) => ({
      label: i % 2 ? "abuse" : "legit",
      weight: 1,
      features: { hard_bounce_7d: r0(), farm_linked: r0() },
    }))
    expect(train(noise).active).toBe(false)
  })

  it("is deterministic: the same labels give the same verdict", () => {
    expect(train(rows(400)).evaluation).toEqual(train(rows(400)).evaluation)
  })
})

describe("features", () => {
  it("are finite numbers for every scenario, legitimate or not", () => {
    const all = [
      ...Object.values(LEGIT).map((f) => f()),
      ...Object.values(ABUSE).map((a) => a.facts()),
    ]
    for (const facts of all) {
      const f = features(facts)
      for (const name of FEATURE_NAMES) expect(Number.isFinite(f[name])).toBe(true)
    }
  })
})
