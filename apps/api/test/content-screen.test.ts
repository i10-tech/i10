import { describe, expect, it } from "bun:test"
import {
  screenBatch,
  untrusted,
  type ScreenDeps,
  type ScreenMessage,
  type Standing,
} from "../src/content/screen.js"
import { parseSubmission } from "../src/content/trust.js"
import { render, splitBody } from "../src/content/templates.js"
import type { ContentItem } from "../src/risk/content.js"
import type { JudgeEmail } from "../src/risk/judge/contract.js"
import type {
  ContentJudge,
  JudgeOutcome,
  StoredJudgement,
} from "../src/risk/judge/judge.js"
import type { JudgementStore } from "../src/risk/judge/store.js"
import { answers } from "./risk-fixtures.js"

/**
 * Judging before the first send (content/screen.ts): who is screened, what
 * counts as one content, and that every way it can fail still sends.
 */

const NOW = new Date("2026-11-17T12:00:00Z")
const DAY = 86_400_000
const TENANT = "00000000-0000-7000-8000-0000000000aa"

const standing = (over: Partial<Standing> = {}): Standing => ({
  createdAt: new Date(NOW.getTime() - 3 * DAY),
  band: "low",
  pausedUntil: null,
  ...over,
})

const letter = (name: string) =>
  `<p>Dear ${name},</p><p>Your mailbox storage is full and incoming mail is being held. ` +
  `Sign in within 24 hours at https://mail-verify.example/restore to release your messages, ` +
  `or the account will be closed and every message in it deleted. Thank you, the mail team.</p>`

const UNRELATED = [
  "<p>Our spring collection is here: linen shirts, light jackets and canvas shoes, all made in small batches by the same workshop.</p>",
  "<p>Notes from the allotment society: compost turning on Saturday, seed swap the week after, and the shed key moves to plot nine.</p>",
  "<p>The quarterly report is attached. Revenue grew in every region, churn fell, and the board meets on Thursday to review it.</p>",
  "<p>Your flight to Lisbon departs from gate twelve. Boarding closes forty minutes before departure, so please arrive early.</p>",
  "<p>The choir rehearses the winter programme on Tuesdays; bring the new scores, a pencil and something warm to drink.</p>",
]

let n = 0
const message = (html: string, subject = "Mailbox notice"): ScreenMessage => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  createdAt: new Date(NOW.getTime() - 1000),
  subject,
  from: "Mail Team <team@new-sender.example>",
  replyTo: [],
  to: ["someone@example.com"],
  html,
  text: null,
})

const judgement = (key: string): StoredJudgement => ({
  model: key,
  answers: answers(0.03),
  truncated: false,
  usage: null,
  second: {
    status: "not_needed",
    model: null,
    answers: null,
    truncated: null,
    usage: null,
  },
})

/** A judge that answers `outcome` (judged by default) and records what it was asked. */
function fakeJudge(
  outcome?: (email: JudgeEmail) => JudgeOutcome | Promise<JudgeOutcome>,
) {
  const asked: JudgeEmail[] = []
  const judge: ContentJudge = {
    model: "test/judge",
    key: "test/judge#1",
    secondModel: null,
    async judge(_tenantId, email) {
      asked.push(email)
      return outcome
        ? outcome(email)
        : { status: "judged", judgement: judgement("test/judge#1") }
    },
  }
  return { judge, asked }
}

/** Judgements kept in memory, with bands, as the definers keep them. */
function memoryJudgements() {
  const rows: { exact: string; model: string; bands: string[] | null; at: Date }[] = []
  const store: JudgementStore = {
    async judged(_t, model, exacts) {
      return new Set(
        rows
          .filter((r) => r.model === model && exacts.includes(r.exact))
          .map((r) => r.exact),
      )
    },
    async near(_t, model, bands, since) {
      return rows
        .filter(
          (r) =>
            r.model === model &&
            r.at >= since &&
            r.bands?.some((b) => bands.includes(b)),
        )
        .map((r) => ({ exact: r.exact, bands: r.bands! }))
    },
    async save(_t, exact, j, at, bands) {
      if (rows.some((r) => r.exact === exact && r.model === j.model)) return false
      rows.push({ exact, model: j.model, bands: bands ? [...bands] : null, at })
      return true
    },
    async addDay() {},
    async facts() {
      throw new Error("not used")
    },
    async list() {
      return []
    },
    async purge() {
      return 0
    },
  }
  return { store, rows }
}

function deps(over: Partial<ScreenDeps> = {}) {
  const judgements = memoryJudgements()
  const judge = fakeJudge()
  const stamped: string[] = []
  const recorded: ContentItem[] = []
  const rescored: string[] = []
  const d: ScreenDeps = {
    judge: judge.judge,
    judgements: judgements.store,
    settings: { enabled: true, untrustedDays: 30, maxGroups: 3, deadlineMs: 20_000 },
    riskEnabled: true,
    standing: async () => standing(),
    stamp: async (_t, bodies) => {
      stamped.push(...bodies.map((b) => b.messageId))
    },
    record: async (_t, items) => {
      recorded.push(...items)
    },
    rescore: async (tenantId) => {
      rescored.push(tenantId)
      return true
    },
    now: () => NOW,
    ...over,
  }
  return { deps: d, judge, judgements, stamped, recorded, rescored }
}

describe("who is screened", () => {
  it("is a workspace younger than the setting, or elevated or worse, unless staff cleared it", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * DAY)
    expect(untrusted(standing({ createdAt: at(3) }), NOW, 30)).toBe(true)
    expect(untrusted(standing({ createdAt: at(31) }), NOW, 30)).toBe(false)
    expect(untrusted(standing({ createdAt: at(31) }), NOW, 60)).toBe(true)
    expect(untrusted(standing({ createdAt: at(400), band: "elevated" }), NOW, 30)).toBe(
      true,
    )
    expect(untrusted(standing({ createdAt: at(400), band: "critical" }), NOW, 30)).toBe(
      true,
    )
    expect(untrusted(standing({ createdAt: at(400), band: null }), NOW, 30)).toBe(false)
    // A release or pin still in force clears it; one that ran out does not.
    const cleared = { band: "high" as const, createdAt: at(2) }
    expect(
      untrusted(
        standing({ ...cleared, pausedUntil: new Date(NOW.getTime() + DAY) }),
        NOW,
        30,
      ),
    ).toBe(false)
    expect(
      untrusted(
        standing({ ...cleared, pausedUntil: new Date(NOW.getTime() - 1) }),
        NOW,
        30,
      ),
    ).toBe(true)
  })

  it("skips without looking when the judge is off, the switch is off, or the workspace is ours", async () => {
    const noJudge = { ...deps().deps, judge: undefined }
    expect(await screenBatch(TENANT, [message(letter("Ann"))], noJudge)).toEqual({
      kind: "skipped",
      why: "judge_off",
    })
    const off = deps()
    off.deps.settings = { ...off.deps.settings, enabled: false }
    expect(await screenBatch(TENANT, [message(letter("Ann"))], off.deps)).toEqual({
      kind: "skipped",
      why: "switch_off",
    })
    const riskOff = deps({ riskEnabled: false })
    expect(
      (await screenBatch(TENANT, [message(letter("Ann"))], riskOff.deps)).kind,
    ).toBe("skipped")
    const ours = deps({ exempt: new Set([TENANT]) })
    expect(await screenBatch(TENANT, [message(letter("Ann"))], ours.deps)).toEqual({
      kind: "skipped",
      why: "exempt",
    })
    for (const d of [off, riskOff, ours]) expect(d.judge.asked).toHaveLength(0)
  })

  it("leaves a trusted workspace's mail alone, stamping nothing", async () => {
    const t = deps({
      standing: async () =>
        standing({ createdAt: new Date(NOW.getTime() - 400 * DAY) }),
    })
    expect(await screenBatch(TENANT, [message(letter("Ann"))], t.deps)).toEqual({
      kind: "skipped",
      why: "trusted_workspace",
    })
    expect(t.judge.asked).toHaveLength(0)
    expect(t.stamped).toHaveLength(0)
  })
})

describe("one content, one call", () => {
  it("judges personalised copies of one mail once, and stamps only the copy it judged", async () => {
    const t = deps()
    const batch = ["Anna", "Ben", "Chidi", "Dagny", "Emeka"].map((name) =>
      message(letter(name)),
    )
    const outcome = await screenBatch(TENANT, batch, t.deps)
    expect(outcome).toEqual({ kind: "judged", groups: 1, left: 0, rescored: true })
    expect(t.judge.asked).toHaveLength(1)
    expect(t.judge.asked[0]).toMatchObject({
      subject: "Mailbox notice",
      senderName: "Mail Team",
      senderDomain: "new-sender.example",
      recipientDomain: "example.com",
    })
    expect(t.stamped).toEqual([batch[0]!.id])
    expect(t.judgements.rows[0]!.bands).toHaveLength(8)
  })

  it("judges different mail as different contents, at most the cap per batch, and leaves the rest unstamped", async () => {
    const t = deps()
    const batch = UNRELATED.map((html, i) => message(html, `Subject ${i}`))
    const outcome = await screenBatch(TENANT, batch, t.deps)
    expect(outcome).toEqual({ kind: "judged", groups: 3, left: 2, rescored: true })
    expect(t.judge.asked).toHaveLength(3)
    expect(t.stamped.sort()).toEqual(
      batch
        .slice(0, 3)
        .map((m) => m.id)
        .sort(),
    )
  })

  it("does not judge what this workspace already has a judgement for, exactly or as a near-duplicate from an earlier batch", async () => {
    const t = deps()
    await screenBatch(TENANT, [message(letter("Anna"))], t.deps)
    expect(t.judge.asked).toHaveLength(1)

    const again = [message(letter("Anna")), message(letter("Zebulon"))]
    expect(await screenBatch(TENANT, again, t.deps)).toEqual({
      kind: "skipped",
      why: "nothing_new",
    })
    expect(t.judge.asked).toHaveLength(1)
    expect(t.stamped).toContain(again[0]!.id)
    expect(t.stamped).not.toContain(again[1]!.id)
    expect(t.rescored).toHaveLength(1)
  })

  it("forgets a near-duplicate's judgement after the window, but never an exact one", async () => {
    const t = deps()
    await t.judgements.store.save(
      TENANT,
      "not-this-exact",
      judgement("test/judge#1"),
      new Date(NOW.getTime() - 8 * DAY),
      (await import("../src/risk/fingerprint.js")).fingerprint(
        "Mailbox notice",
        letter("Anna"),
        null,
      )!.bands,
    )
    expect((await screenBatch(TENANT, [message(letter("Ben"))], t.deps)).kind).toBe(
      "judged",
    )
  })

  it("never judges trusted content or mail too short to fingerprint, and stamps it", async () => {
    const skeleton = parseSubmission({
      html: "<html><body><h1>Reset your password</h1><p>Hi {{name}},</p><p>Someone asked to reset the password for your Acme account. If it was you, use the code in the app within the next hour.</p><p>If you did not ask, ignore this email and nothing changes.</p></body></html>",
      text: null,
      holes: { name: 40 },
    })
    if ("error" in skeleton) throw new Error(skeleton.error)
    const t = deps({
      trust: {
        forTenant: async () => ({
          entries: [
            {
              kind: "template",
              id: "t1",
              name: "Password reset",
              template: skeleton.template,
              limits: skeleton.holes.map((h) => h.max),
            },
          ],
          ctx: { verifiedParents: new Set(["acme.com"]), verdict: async () => "clean" },
        }),
      },
    })
    const reset = splitBody(render(skeleton.template, ["Ada"]))
    const batch = [
      message(reset.html!, "Reset your password"),
      message("<p>hi</p>", "hey"),
    ]
    expect(await screenBatch(TENANT, batch, t.deps)).toEqual({
      kind: "skipped",
      why: "nothing_new",
    })
    expect(t.judge.asked).toHaveLength(0)
    expect(t.stamped.sort()).toEqual(batch.map((m) => m.id).sort())
  })
})

describe("re-scoring", () => {
  it("records the batch's fingerprints before re-scoring, and re-scores only when something was judged", async () => {
    const order: string[] = []
    const t = deps({
      record: async () => {
        order.push("record")
      },
      rescore: async () => {
        order.push("rescore")
        return true
      },
    })
    await screenBatch(TENANT, [message(letter("Anna"))], t.deps)
    expect(order).toEqual(["record", "rescore"])
    await screenBatch(TENANT, [message(letter("Ben"))], t.deps)
    expect(order).toEqual(["record", "rescore"])
  })
})

describe("failing open", () => {
  const one = () => [message(letter("Anna")), message(UNRELATED[0]!, "Spring")]

  for (const [label, outcome, why] of [
    ["a spent workspace budget", { status: "capped" }, "budget"],
    ["a spent global budget", { status: "deferred", reason: "budget" }, "budget"],
    ["no Redis to count with", { status: "deferred", reason: "no_redis" }, "budget"],
    ["a parked model", { status: "deferred", reason: "down" }, "provider_down"],
    ["a failed call", { status: "deferred", reason: "failed" }, "provider_down"],
  ] as const) {
    it(`sends unjudged and unstamped on ${label}`, async () => {
      const judge = fakeJudge(() => outcome)
      const t = deps({ judge: judge.judge })
      expect(await screenBatch(TENANT, one(), t.deps)).toEqual({
        kind: "unscreened",
        why,
        judged: 0,
        rescored: false,
      })
      // One call, not one per group: the next would say the same.
      expect(judge.asked).toHaveLength(1)
      expect(t.stamped).toHaveLength(0)
      expect(t.rescored).toHaveLength(0)
    })
  }

  it("stops at the deadline, re-scores what it did judge, and keeps a late answer for the hourly pass", async () => {
    let calls = 0
    let answerLate: (o: JudgeOutcome) => void = () => {}
    const judge = fakeJudge(() => {
      calls++
      if (calls === 1) return { status: "judged", judgement: judgement("test/judge#1") }
      return new Promise((resolve) => {
        answerLate = resolve
      })
    })
    const t = deps({ judge: judge.judge })
    t.deps.settings = { ...t.deps.settings, deadlineMs: 50 }
    const batch = one()
    const outcome = await screenBatch(TENANT, batch, t.deps)
    expect(outcome).toMatchObject({ kind: "unscreened", why: "deadline", judged: 1 })
    expect(t.stamped).toEqual([batch[0]!.id])
    expect(t.judgements.rows).toHaveLength(1)
    answerLate({ status: "judged", judgement: judgement("test/judge#1") })
    await new Promise((r) => setTimeout(r, 10))
    expect(t.judgements.rows).toHaveLength(2)
  })

  it("does not wait past the deadline for a slow re-score", async () => {
    const t = deps({ rescore: () => new Promise<boolean>(() => {}) })
    t.deps.settings = { ...t.deps.settings, deadlineMs: 50 }
    const started = Date.now()
    expect(await screenBatch(TENANT, [message(letter("Anna"))], t.deps)).toEqual({
      kind: "unscreened",
      why: "deadline",
      judged: 1,
      rescored: false,
    })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("reports an error from the re-score with what it had judged", async () => {
    const t = deps({
      rescore: async () => {
        throw new Error("lock lost")
      },
    })
    expect(await screenBatch(TENANT, [message(letter("Anna"))], t.deps)).toEqual({
      kind: "unscreened",
      why: "error",
      judged: 1,
      rescored: false,
    })
    // The content was judged; it stays judged.
    expect(t.stamped).toHaveLength(1)
  })
})
