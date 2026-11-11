import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { type Answers, type Judge, validateAnswers } from "../src/judge.js"
import { keywordJudge } from "../src/judges/keyword.js"
import { randomJudge } from "../src/judges/random.js"
import { rocAuc } from "../src/metrics.js"
import { buildReport, renderReport } from "../src/report.js"
import { answersPath, loadAnswers, runJudge, selectMails } from "../src/runner.js"
import { mail, withTempDir } from "./helpers.js"

function countingJudge(
  name = "counting-v1",
  fail: (i: number) => boolean = () => false,
) {
  const calls: string[] = []
  const judge: Judge = {
    name,
    judge(input) {
      calls.push(input.subject)
      if (fail(calls.length)) return Promise.reject(new Error("endpoint down"))
      return Promise.resolve({ phishing: 0.5 })
    },
  }
  return { judge, calls }
}

const mails = Array.from({ length: 8 }, (_, i) => mail({ subject: `m${i}` }))

describe("selectMails", () => {
  it("orders by a hash of the id so any prefix is a sample, and a bigger cap is a superset", () => {
    const small = selectMails(mails, 3).map((m) => m.id)
    const large = selectMails(mails, 5).map((m) => m.id)
    expect(large.slice(0, 3)).toEqual(small)
    expect(selectMails([...mails].reverse(), 3).map((m) => m.id)).toEqual(small)
    expect(selectMails(mails, undefined)).toHaveLength(8)
    expect(selectMails(mails, 0)).toHaveLength(0)
  })
})

describe("runJudge", () => {
  it("caps the run, resumes from the cache, and never asks twice", async () => {
    await withTempDir(async (root) => {
      const { judge, calls } = countingJudge()
      const first = await runJudge({
        judge,
        mails,
        cacheRoot: root,
        concurrency: 3,
        cap: 3,
      })
      expect(first.stats).toMatchObject({
        selected: 3,
        cached: 0,
        pending: 3,
        computed: 3,
        failed: 0,
      })
      expect(calls).toHaveLength(3)

      const again = await runJudge({
        judge,
        mails,
        cacheRoot: root,
        concurrency: 3,
        cap: 3,
      })
      expect(again.stats).toMatchObject({ cached: 3, pending: 0, computed: 0 })
      expect(calls).toHaveLength(3)

      const more = await runJudge({
        judge,
        mails,
        cacheRoot: root,
        concurrency: 3,
        cap: 5,
      })
      expect(more.stats).toMatchObject({ selected: 5, cached: 3, computed: 2 })
      expect(calls).toHaveLength(5)
      expect(more.answers.size).toBe(5)
    })
  })

  it("keeps one cache per judge name", async () => {
    await withTempDir(async (root) => {
      await runJudge({
        judge: countingJudge("a-v1").judge,
        mails,
        cacheRoot: root,
        concurrency: 2,
      })
      const b = countingJudge("b-v1")
      await runJudge({ judge: b.judge, mails, cacheRoot: root, concurrency: 2 })
      expect(b.calls).toHaveLength(8)
    })
  })

  it("dry run counts and writes nothing", async () => {
    await withTempDir(async (root) => {
      const { judge, calls } = countingJudge()
      const { stats } = await runJudge({
        judge,
        mails,
        cacheRoot: root,
        concurrency: 2,
        cap: 4,
        dryRun: true,
      })
      expect(stats).toMatchObject({ selected: 4, cached: 0, pending: 4, computed: 0 })
      expect(calls).toHaveLength(0)
      expect(existsSync(answersPath(root, judge.name))).toBe(false)
    })
  })

  it("does not cache a failure, so a rerun retries it", async () => {
    await withTempDir(async (root) => {
      const flaky = countingJudge("flaky-v1", (n) => n === 2)
      const first = await runJudge({
        judge: flaky.judge,
        mails: mails.slice(0, 4),
        cacheRoot: root,
        concurrency: 1,
      })
      expect(first.stats).toMatchObject({ computed: 3, failed: 1 })
      const second = await runJudge({
        judge: flaky.judge,
        mails: mails.slice(0, 4),
        cacheRoot: root,
        concurrency: 1,
      })
      expect(second.stats).toMatchObject({
        cached: 3,
        pending: 1,
        computed: 1,
        failed: 0,
      })
    })
  })

  it("stops after too many consecutive failures instead of burning the whole set", async () => {
    await withTempDir(async (root) => {
      const dead = countingJudge("dead-v1", () => true)
      await expect(
        runJudge({
          judge: dead.judge,
          mails,
          cacheRoot: root,
          concurrency: 1,
          maxConsecutiveFailures: 3,
        }),
      ).rejects.toThrow(/3 consecutive/)
      expect(dead.calls).toHaveLength(3)
    })
  })

  it("rejects an answer that is not a probability", async () => {
    await withTempDir(async (root) => {
      const bad: Judge = {
        name: "bad-v1",
        judge: () => Promise.resolve({ phishing: 1.5 } as Answers),
      }
      const { stats } = await runJudge({
        judge: bad,
        mails: mails.slice(0, 2),
        cacheRoot: root,
        concurrency: 1,
      })
      expect(stats).toMatchObject({ computed: 0, failed: 2 })
      expect(() => validateAnswers({ nonsense: 0.1 })).toThrow(/unknown question/)
      expect(() => validateAnswers({ spam: Number.NaN })).toThrow(/probability/)
    })
  })

  it("ignores a torn last line in the cache", async () => {
    await withTempDir(async (root) => {
      const path = answersPath(root, "torn-v1")
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        `${JSON.stringify({ id: "a", answers: { spam: 0.2 } })}\n{"id":"b","answ`,
      )
      expect([...(await loadAnswers(path)).keys()]).toEqual(["a"])
    })
  })

  it("refuses a judge name that could escape the cache directory", () => {
    expect(() => answersPath("/tmp/x", "../evil")).toThrow(/bad judge name/)
  })

  it("writes one JSON line per answer", async () => {
    await withTempDir(async (root) => {
      const { judge } = countingJudge()
      await runJudge({
        judge,
        mails: mails.slice(0, 2),
        cacheRoot: root,
        concurrency: 2,
      })
      const lines = (await readFile(answersPath(root, judge.name), "utf8"))
        .trim()
        .split("\n")
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0] ?? "")).toHaveProperty("answers.phishing", 0.5)
    })
  })
})

describe("built-in judges", () => {
  const phish = mail({
    label: "phishing",
    subject: "Security alert",
    text: "Urgent: verify your account password now at https://x.example or it will be suspended",
  })
  const ham = mail({
    label: "legit",
    subject: "Lunch",
    text: "Are we still on for lunch on thursday? Bring the notes from the meeting.",
  })

  it("keyword baseline ranks an obvious phish above plain mail and answers every question", async () => {
    const [p, h] = await Promise.all([
      keywordJudge.judge(phish),
      keywordJudge.judge(ham),
    ])
    expect(Object.keys(p).sort()).toEqual([
      "asks_for_credentials",
      "impersonates_brand",
      "is_marketing",
      "phishing",
      "spam",
    ])
    expect(p.phishing ?? 0).toBeGreaterThan(0.5)
    expect(h.phishing).toBe(0)
    expect(() => validateAnswers(p)).not.toThrow()
  })

  it("random judge is repeatable and no better than chance", async () => {
    expect(await randomJudge.judge(ham)).toEqual(await randomJudge.judge(ham))
    const scored = await Promise.all(
      Array.from({ length: 1500 }, async (_, i) => {
        const subject = `random ${i}`
        const answers = await randomJudge.judge({ subject, text: `body ${i * 7}` })
        return { score: answers.phishing ?? 0, truth: i % 3 === 0 }
      }),
    )
    const auc = rocAuc(scored) ?? 0
    expect(auc).toBeGreaterThan(0.45)
    expect(auc).toBeLessThan(0.55)
  })
})

describe("report", () => {
  it("renders the headline, confusion table, sweep, calibration and breakdowns", async () => {
    const rows = await Promise.all(
      [
        mail({
          label: "phishing",
          subject: "Verify",
          text: "Urgent verify your password at https://x.example now",
        }),
        mail({
          label: "phishing",
          subject: "Pay",
          text: "Your account is suspended, confirm your account within 24 hours",
        }),
        mail({
          label: "legit",
          subject: "Hi",
          text: "See you at the usual place tomorrow morning for coffee",
        }),
        mail({
          label: "spam",
          subject: "Win",
          text: "You are a winner, free bonus, click here now!!",
        }),
      ].map(async (m) => ({ mail: m, answers: await keywordJudge.judge(m) })),
    )
    const markdown = renderReport(
      buildReport({
        judge: "keyword-v1",
        split: "dev",
        splitSize: 10,
        inScope: 5,
        rows,
      }),
    )
    expect(markdown).toContain("# Risk eval: keyword-v1 on dev")
    expect(markdown).toContain(
      "in scope after the cap: 5; judged: 4; without an answer: 1",
    )
    expect(markdown).toContain(
      "False-positive rate on legitimate mail at the threshold that catches 90% of phishing",
    )
    expect(markdown).toContain("### Threshold sweep")
    expect(markdown).toContain("### Calibration")
    expect(markdown).toContain("### By language")
    expect(markdown).toContain("impersonates_brand, asks_for_credentials, is_marketing")
    expect(markdown).not.toContain(String.fromCharCode(0x2014))
  })
})
