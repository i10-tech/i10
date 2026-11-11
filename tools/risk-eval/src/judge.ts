/**
 * The contract between the harness and anything that judges mail.
 *
 * A judge answers typed questions about one email with probabilities. It may
 * answer a subset: a question it leaves out is not scored for that judge.
 */

export const QUESTIONS = [
  "phishing",
  "spam",
  "impersonates_brand",
  "asks_for_credentials",
  "is_marketing",
] as const

export type Question = (typeof QUESTIONS)[number]

/** A probability in [0, 1] per question. */
export type Answers = Partial<Record<Question, number>>

export interface JudgeInput {
  subject: string
  text: string
  html?: string
}

export interface Judge {
  /**
   * Names the judge in the cache and in reports. It is also the cache key, so
   * a judge whose behaviour changes must change its name (`keyword-v2`),
   * otherwise a rerun serves the old answers.
   */
  name: string
  judge(input: JudgeInput): Promise<Answers>
}

export const JUDGE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** Rejects an answer that is not a map of known questions to probabilities. */
export function validateAnswers(answers: unknown): Answers {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("a judge must return an object of question to probability")
  }
  const out: Answers = {}
  for (const [key, value] of Object.entries(answers)) {
    if (!(QUESTIONS as readonly string[]).includes(key))
      throw new Error(`unknown question: ${key}`)
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new Error(`${key} must be a probability in [0, 1], got ${String(value)}`)
    }
    out[key as Question] = value
  }
  return out
}
