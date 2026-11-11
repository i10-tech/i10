import { type Answers, type Judge, type JudgeInput, QUESTIONS } from "../judge.js"
import { sha256Hex } from "../text.js"

/**
 * Uniform noise, seeded from the mail's own text so a rerun is identical.
 * Every metric of a working harness must read "no better than chance" on it:
 * AUC near 0.5, and a false-positive rate on legit mail near its recall on
 * phishing. If it ever scores well, the harness is leaking labels.
 */
export const randomJudge: Judge = {
  name: "random-v1",
  judge(input: JudgeInput): Promise<Answers> {
    const digest = sha256Hex(`random-v1\0${input.subject}\0${input.text}`)
    const answers: Answers = {}
    QUESTIONS.forEach((question, i) => {
      // 8 hex digits per question: 32 bits, uniform in [0, 1).
      answers[question] =
        Number.parseInt(digest.slice(i * 8, i * 8 + 8), 16) / 0x1_0000_0000
    })
    return Promise.resolve(answers)
  },
}
