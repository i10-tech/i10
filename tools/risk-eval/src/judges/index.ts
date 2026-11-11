import type { Judge } from "../judge.js"
import { keywordJudge } from "./keyword.js"
import { randomJudge } from "./random.js"

/** Judges that need no model and no network. A real judge is added here. */
export const BUILTIN_JUDGES: Judge[] = [keywordJudge, randomJudge]

export function findJudge(name: string): Judge {
  const judge = BUILTIN_JUDGES.find((j) => j.name === name)
  if (judge === undefined) {
    throw new Error(
      `unknown judge ${name}; built in: ${BUILTIN_JUDGES.map((j) => j.name).join(", ")}`,
    )
  }
  return judge
}
