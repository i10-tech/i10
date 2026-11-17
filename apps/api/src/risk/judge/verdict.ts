import type { JudgedContent, JudgeSignal } from "../types.js"
import type { JudgeQuestion } from "./contract.js"
import type { Answers } from "./providers.js"

/**
 * How two models' answers become a signal, and how a workspace's judged
 * content becomes facts (docs/decisions/risk.md, "The content judge").
 *
 * ⚠ THESE THRESHOLDS WERE MEASURED ON 2026-11-17 (test split, 600 mails):
 * identity or phishing caught 92.5% of phishing and flagged 0% of real
 * legitimate mail, 3.3% of generated legitimate mail and 5.8% of hard
 * legitimate notices; identity alone caught 38% with no legitimate mail
 * flagged. Change one only with a new measurement.
 *
 * ⚠ ONLY THE SECOND MODEL DECIDES. The first model screens: its confident
 * answers flagged 26 to 82% of honest notices, so it can send a content on and
 * can never set a signal by itself. A screened content the second model did
 * not answer (not configured, unavailable, over budget) has no signal and is
 * counted as undecided.
 */
interface Test {
  question: JudgeQuestion
  /** The answer must be above this probability. */
  above: number
}

/** A content goes to the second model when any of these holds for the first. */
export const SCREEN: readonly Test[] = [
  { question: "phish_short", above: 0.9 },
  { question: "imp_short", above: 0.5 },
]

/**
 * What the second model's answers can say, strongest first: a content has at
 * most one signal, so phishing is reported only where identity is not.
 */
export const SIGNALS: readonly (readonly [JudgeSignal, readonly Test[]])[] = [
  [
    "identity",
    [
      { question: "imp_short", above: 0.8 },
      { question: "mailbox", above: 0.8 },
    ],
  ],
  ["phishing", [{ question: "phish_short", above: 0.9 }]],
]

export const JUDGE_SIGNALS: readonly JudgeSignal[] = SIGNALS.map(([s]) => s)

const holds = (tests: readonly Test[], a: Answers) =>
  tests.some((t) => a[t.question] > t.above)

export type SecondStatus =
  "not_needed" | "answered" | "unavailable" | "over_budget" | "not_configured"

export const needsSecondOpinion = (first: Answers): boolean => holds(SCREEN, first)

/** The signal the second model's answers set, if any. */
export const signalOf = (second: Answers): JudgeSignal | null =>
  SIGNALS.find(([, tests]) => holds(tests, second))?.[0] ?? null

/** One judged content as the facts loader reads it. */
export interface JudgedRow {
  exact: string
  answers: Answers
  secondAnswers: Answers | null
  truncated: boolean
  /** Its messages over the window, from the fingerprints. */
  messages: number
}

/** A workspace's judged content over the window, per signal. */
export function summariseJudged(
  model: string,
  rows: readonly JudgedRow[],
  days: JudgedContent["days"],
): JudgedContent {
  const signals = Object.fromEntries(
    JUDGE_SIGNALS.map((s) => [s, { contents: 0, messages: 0, exacts: [] as string[] }]),
  ) as JudgedContent["signals"]
  let screened = 0
  let undecided = 0
  for (const r of rows) {
    if (!needsSecondOpinion(r.answers)) continue
    screened++
    if (!r.secondAnswers) {
      undecided++
      continue
    }
    const signal = signalOf(r.secondAnswers)
    if (!signal) continue
    signals[signal].contents++
    signals[signal].messages += r.messages
    signals[signal].exacts.push(r.exact)
  }
  for (const s of JUDGE_SIGNALS) signals[s].exacts.sort()
  return {
    model,
    judged: rows.length,
    messages: rows.reduce((n, r) => n + r.messages, 0),
    truncated: rows.filter((r) => r.truncated).length,
    days,
    screened,
    undecided,
    signals,
  }
}
