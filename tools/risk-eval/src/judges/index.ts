import type { Judge } from "../judge.js"
import { keywordJudge } from "./keyword.js"
import { randomJudge } from "./random.js"
import { workersAiJudge } from "./workers-ai.js"

/**
 * The offline baselines, and Cloudflare's two Clef models through the API's
 * own question text (workers-ai.ts; they call a paid service).
 */
export const BUILTIN_JUDGES: Judge[] = [
  keywordJudge,
  randomJudge,
  workersAiJudge("@cf/cloudflare/clef-flash"),
  workersAiJudge("@cf/cloudflare/clef"),
]

export function findJudge(name: string): Judge {
  const judge = BUILTIN_JUDGES.find((j) => j.name === name)
  if (judge === undefined) {
    throw new Error(
      `unknown judge ${name}; built in: ${BUILTIN_JUDGES.map((j) => j.name).join(", ")}`,
    )
  }
  return judge
}
