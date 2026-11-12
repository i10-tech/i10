import type { JudgedContent, JudgedQuestion } from "../types.js"
import { JUDGE_QUESTION_IDS, type JudgeQuestion } from "./contract.js"
import type { Answers } from "./providers.js"

/**
 * How two models' answers become one, and how a workspace's judged content
 * becomes facts (docs/decisions/risk.md, "The content judge").
 *
 * ⚠ THE SECOND OPINION CAN ONLY TAKE SUSPICION AWAY, NEVER ADD IT. A question
 * is unsafe when the first model is above the threshold and, where it was
 * unsure, the second model agrees. Unsure and with no second answer, the first
 * model's answer stands and is counted as unconfirmed.
 */
export const JUDGE_THRESHOLD = 0.5

/** Where the first model is unsure enough that the second one is asked. */
export const UNSURE_BAND = { from: 0.35, to: 0.75 } as const

/** The questions a second opinion is asked for: the ones that may hold mail. */
export const SECOND_OPINION_QUESTIONS: readonly JudgeQuestion[] = [
  "phishing",
  "impersonates_brand",
]

export type SecondStatus =
  "not_needed" | "answered" | "unavailable" | "over_budget" | "not_configured"

const unsure = (p: number) => p >= UNSURE_BAND.from && p <= UNSURE_BAND.to

export const needsSecondOpinion = (answers: Answers): boolean =>
  SECOND_OPINION_QUESTIONS.some((q) => unsure(answers[q]))

export interface QuestionVerdict {
  unsafe: boolean
  /** Unsafe, and either outside the unsure band or agreed by the second model. */
  confirmed: boolean
  /** The probability that counts: the lower of the two where both answered. */
  probability: number
}

export function verdict(
  question: JudgeQuestion,
  first: Answers,
  second: Answers | null,
): QuestionVerdict {
  const p = first[question]
  const asked = SECOND_OPINION_QUESTIONS.includes(question) && unsure(p)
  if (!asked) {
    const unsafe = p > JUDGE_THRESHOLD
    return { unsafe, confirmed: unsafe, probability: p }
  }
  if (!second) {
    return { unsafe: p > JUDGE_THRESHOLD, confirmed: false, probability: p }
  }
  const s = second[question]
  const unsafe = p > JUDGE_THRESHOLD && s > JUDGE_THRESHOLD
  return { unsafe, confirmed: unsafe, probability: Math.min(p, s) }
}

/** One judged content as the facts loader reads it. */
export interface JudgedRow {
  exact: string
  answers: Answers
  secondAnswers: Answers | null
  truncated: boolean
  /** Its messages over the window, from the fingerprints. */
  messages: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** A workspace's judged content over the window, per question. */
export function summariseJudged(
  model: string,
  rows: readonly JudgedRow[],
  days: JudgedContent["days"],
): JudgedContent {
  const questions = {} as Record<JudgeQuestion, JudgedQuestion>
  for (const q of JUDGE_QUESTION_IDS) {
    const unsafe = rows
      .map((r) => ({ r, v: verdict(q, r.answers, r.secondAnswers) }))
      .filter(({ v }) => v.unsafe)
    const all = rows.map((r) => verdict(q, r.answers, r.secondAnswers).probability)
    questions[q] = {
      contents: unsafe.length,
      messages: unsafe.reduce((n, { r }) => n + r.messages, 0),
      unconfirmed: unsafe.filter(({ v }) => !v.confirmed).length,
      highest: all.length ? round2(Math.max(...all)) : null,
      exacts: unsafe.map(({ r }) => r.exact).sort(),
    }
  }
  return {
    model,
    judged: rows.length,
    messages: rows.reduce((n, r) => n + r.messages, 0),
    truncated: rows.filter((r) => r.truncated).length,
    days,
    questions,
  }
}
