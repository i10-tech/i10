import type { Fetch } from "../intel.js"
import {
  JUDGE_QUESTION_IDS,
  JUDGE_QUESTIONS,
  judgeState,
  type JudgeEmail,
  type JudgeQuestion,
} from "./contract.js"

/**
 * The content judge's port, and the two services behind it (docs/decisions/
 * risk.md, "The content judge").
 *
 * A decision model takes a state and typed questions and answers each with a
 * probability; it writes no text. Both services speak System One:
 *
 *   workers-ai  Cloudflare's REST API, `POST /accounts/{id}/ai/run/{model}`,
 *               for `@cf/cloudflare/clef-flash` and `@cf/cloudflare/clef`. The
 *               body needs `model` (`clef-flash` or `clef`), and the answer is
 *               wrapped in `{ result, success, errors }`.
 *               developers.cloudflare.com/workers-ai/models/clef-flash/
 *   systemone   a self-hosted Laya, or TypeSafe's Jev, at `POST {url}/v1/systemone`,
 *               answering unwrapped. github.com/NandhaKishorM/laya
 *
 * A `noul` answer is `{ type: "noul", noul: <P(yes)> }`. An answer missing a
 * question, or not a probability, is the service failing, never a "no".
 */
export type JudgeProviderKind = "workers-ai" | "systemone"

export type Answers = Record<JudgeQuestion, number>

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface Judgement {
  answers: Answers
  /** Cut by us (`judgeState`) or, where it says so, by the service. */
  truncated: boolean
  usage: Usage | null
}

export interface JudgeProvider {
  kind: JudgeProviderKind
  /** What answered: stored with every judgement, and part of its key. */
  model: string
  judge(email: JudgeEmail): Promise<Judgement>
}

/** The service refused or failed; `status` is null when nothing answered. */
export class JudgeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = "JudgeError"
  }
}

const TIMEOUT_MS = 20_000

/** The request body both services share: the state and our questions, never mixed. */
export function systemOneBody(email: JudgeEmail, model: string) {
  const { email: state, truncated } = judgeState(email)
  return {
    body: { model, state: { email: state, truncated }, questions: JUDGE_QUESTIONS },
    truncated,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The answers and usage of a System One response, or a `JudgeError`. */
export function readAnswers(
  result: unknown,
  status: number,
): { answers: Answers; usage: Usage | null; truncated: boolean } {
  if (!isRecord(result) || !isRecord(result.answers))
    throw new JudgeError("the judge answered without answers", status)
  const answers = {} as Answers
  for (const id of JUDGE_QUESTION_IDS) {
    const a = result.answers[id]
    const p = isRecord(a) && a.type === "noul" ? a.noul : undefined
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
      throw new JudgeError(`the judge gave no probability for ${id}`, status)
    answers[id] = p
  }
  const u = isRecord(result.usage) ? result.usage : null
  const usage =
    u && Number.isInteger(u.input_tokens) && Number.isInteger(u.output_tokens)
      ? {
          inputTokens: u.input_tokens as number,
          outputTokens: u.output_tokens as number,
        }
      : null
  // Laya reports its own cut on `usage.truncated`; Cloudflare's docs say only
  // that long state is truncated, so our caps keep it from ever needing to.
  return { answers, usage, truncated: u?.truncated === true }
}

async function post(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new JudgeError(`the judge is unreachable: ${String(error)}`, null)
  }
  if (!res.ok) throw new JudgeError(`the judge answered ${res.status}`, res.status)
  try {
    return { status: res.status, json: await res.json() }
  } catch {
    throw new JudgeError(
      "the judge answered with something other than JSON",
      res.status,
    )
  }
}

export interface WorkersAiOptions {
  accountId: string
  token: string
  /** A Workers AI model id, `@cf/cloudflare/clef-flash` or `@cf/cloudflare/clef`. */
  model: string
  fetch?: Fetch
}

export function workersAiJudge(opts: WorkersAiOptions): JudgeProvider {
  // The body names the model by its last segment: `clef-flash`, `clef`.
  const selector = opts.model.slice(opts.model.lastIndexOf("/") + 1)
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/ai/run/${opts.model}`
  return {
    kind: "workers-ai",
    model: opts.model,
    async judge(email) {
      const { body, truncated } = systemOneBody(email, selector)
      const { status, json } = await post(
        opts.fetch ?? fetch,
        url,
        { authorization: `Bearer ${opts.token}` },
        body,
      )
      if (!isRecord(json) || json.success !== true)
        throw new JudgeError("Workers AI reported the run as unsuccessful", status)
      const read = readAnswers(json.result, status)
      return { ...read, truncated: truncated || read.truncated }
    },
  }
}

export interface SystemOneOptions {
  url: string
  apiKey?: string
  /** Sent as the body's `model`: a Laya checkpoint, or `jev-1` to let it choose. */
  model: string
  fetch?: Fetch
}

export function systemOneJudge(opts: SystemOneOptions): JudgeProvider {
  const url = `${opts.url.replace(/\/+$/, "")}/v1/systemone`
  return {
    kind: "systemone",
    model: opts.model,
    async judge(email) {
      const { body, truncated } = systemOneBody(email, opts.model)
      const { status, json } = await post(
        opts.fetch ?? fetch,
        url,
        opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
        body,
      )
      const read = readAnswers(json, status)
      return { ...read, truncated: truncated || read.truncated }
    },
  }
}
