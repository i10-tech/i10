import type { Answers, Judge, JudgeInput } from "../judge.js"
import { JUDGE_QUESTION_IDS, JUDGE_QUESTIONS, judgeState } from "./contract.js"

/**
 * Cloudflare's Clef decision models, asked exactly what the API's content
 * judge asks (contract.ts is a byte-identical copy of the API's), through the
 * same REST endpoint:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
 *
 * The body carries `model` (`clef-flash` or `clef`), the state and the
 * questions; the answer is `{ result: { answers, usage }, success }`, each
 * answer `{ type: "noul", noul: P(yes) }`.
 * developers.cloudflare.com/workers-ai/models/clef-flash/
 *
 * ⚠ IT CALLS A PAID SERVICE. The account and token are read when a mail is
 * judged, never at load, so listing judges or a `--dry-run` needs neither; the
 * harness's cap, cache and consecutive-failure stop bound what a run spends.
 */
export const ACCOUNT_ENV = "I10_RISK_EVAL_CF_ACCOUNT_ID"
export const TOKEN_ENV = "I10_RISK_EVAL_CF_API_TOKEN"

type Fetch = typeof fetch

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Hosts linked from the mail, as the API's fingerprint code finds them. */
function linkHosts(input: JudgeInput): string[] {
  const hosts = new Set<string>()
  const source = `${input.html ?? ""}\n${input.text}`
  for (const m of source.matchAll(
    /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[:/?#"'\s<>]|$)/gi,
  )) {
    hosts.add(m[1]!.toLowerCase().replace(/\.$/, ""))
    if (hosts.size >= 50) break
  }
  return [...hosts]
}

export function workersAiJudge(
  model: "@cf/cloudflare/clef-flash" | "@cf/cloudflare/clef",
  opts: { fetch?: Fetch; env?: Record<string, string | undefined> } = {},
): Judge {
  const selector = model.slice(model.lastIndexOf("/") + 1)
  return {
    name: `cf-${selector}-v1`,
    async judge(input: JudgeInput): Promise<Answers> {
      const env = opts.env ?? process.env
      const account = env[ACCOUNT_ENV]
      const token = env[TOKEN_ENV]
      if (!account || !token) throw new Error(`set ${ACCOUNT_ENV} and ${TOKEN_ENV}`)
      const state = judgeState({
        subject: input.subject,
        text: input.text,
        senderName: null,
        senderDomain: input.fromDomain ?? null,
        replyToDomain: null,
        linkHosts: linkHosts(input),
      })
      const res = await (opts.fetch ?? fetch)(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${model}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: selector, state, questions: JUDGE_QUESTIONS }),
        },
      )
      if (!res.ok) throw new Error(`Workers AI answered ${res.status}`)
      const body: unknown = await res.json()
      if (!isRecord(body) || body.success !== true || !isRecord(body.result))
        throw new Error("Workers AI reported the run as unsuccessful")
      const given = body.result.answers
      const answers: Answers = {}
      for (const id of JUDGE_QUESTION_IDS) {
        const a = isRecord(given) ? given[id] : undefined
        const p = isRecord(a) && a.type === "noul" ? a.noul : undefined
        if (typeof p !== "number")
          throw new Error(`Workers AI gave no probability for ${id}`)
        answers[id] = p
      }
      return answers
    },
  }
}
