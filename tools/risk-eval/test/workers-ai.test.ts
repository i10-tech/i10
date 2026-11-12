import { describe, expect, it } from "bun:test"
import { QUESTIONS, validateAnswers } from "../src/judge.js"
import { findJudge } from "../src/judges/index.js"
import { JUDGE_QUESTION_IDS, JUDGE_QUESTIONS } from "../src/judges/contract.js"
import { ACCOUNT_ENV, TOKEN_ENV, workersAiJudge } from "../src/judges/workers-ai.js"

/**
 * The Workers AI judge against a fake fetch. The response follows Cloudflare's
 * REST envelope (developers.cloudflare.com/workers-ai/get-started/rest-api/)
 * around the Clef output schema
 * (developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json).
 */
const ENV = { [ACCOUNT_ENV]: "acct-1", [TOKEN_ENV]: "tok-1" }

const documented = (p: number) => ({
  result: {
    model: "clef-flash",
    answers: Object.fromEntries(QUESTIONS.map((q) => [q, { type: "noul", noul: p }])),
    usage: { input_tokens: 812, output_tokens: 5 },
  },
  success: true,
  errors: [],
  messages: [],
})

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe("the Workers AI judge", () => {
  it("asks the API's questions about the mail and reads every noul answer", async () => {
    const { f, calls } = fakeFetch(documented(0.81))
    const judge = workersAiJudge("@cf/cloudflare/clef-flash", { fetch: f, env: ENV })
    const answers = validateAnswers(
      await judge.judge({
        subject: "Verify your account",
        text: "Sign in at https://paypa1.example/login now",
        fromDomain: "paypa1.example",
      }),
    )
    expect(answers).toEqual(Object.fromEntries(QUESTIONS.map((q) => [q, 0.81])))
    expect(calls[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef-flash",
    )
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok-1",
    )
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(sent.model).toBe("clef-flash")
    expect(sent.questions).toEqual(JSON.parse(JSON.stringify(JUDGE_QUESTIONS)))
    expect(sent.state).toMatchObject({
      email: { sender_domain: "paypa1.example", link_hosts: ["paypa1.example"] },
      truncated: false,
    })
  })

  it("fails, never answers no, when a question is missing or the run failed", async () => {
    const partial = documented(0.2)
    delete (partial.result.answers as Record<string, unknown>).spam
    const env = { fetch: fakeFetch(partial).f, env: ENV }
    await expect(
      workersAiJudge("@cf/cloudflare/clef", env).judge({ subject: "s", text: "t" }),
    ).rejects.toThrow("no probability for spam")
    const refused = {
      fetch: fakeFetch({ success: false, errors: [{ message: "x" }] }, 200).f,
      env: ENV,
    }
    await expect(
      workersAiJudge("@cf/cloudflare/clef", refused).judge({ subject: "s", text: "t" }),
    ).rejects.toThrow("unsuccessful")
    const limited = { fetch: fakeFetch({}, 429).f, env: ENV }
    await expect(
      workersAiJudge("@cf/cloudflare/clef", limited).judge({ subject: "s", text: "t" }),
    ).rejects.toThrow("429")
  })

  it("needs the account and token only when it judges", async () => {
    const { f, calls } = fakeFetch(documented(0.5))
    const judge = workersAiJudge("@cf/cloudflare/clef-flash", { fetch: f, env: {} })
    await expect(judge.judge({ subject: "s", text: "t" })).rejects.toThrow(ACCOUNT_ENV)
    expect(calls).toHaveLength(0)
    expect(findJudge("cf-clef-flash-v1").name).toBe("cf-clef-flash-v1")
    expect(findJudge("cf-clef-v1").name).toBe("cf-clef-v1")
  })

  it("keeps the harness's questions in step with the judge contract", () => {
    expect([...QUESTIONS]).toEqual([...JUDGE_QUESTION_IDS])
  })
})
