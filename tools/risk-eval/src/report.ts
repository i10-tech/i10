import { QUESTIONS, type Question } from "./judge.js"
import {
  BREAKDOWNS,
  type Breakdown,
  type EvalRow,
  type QuestionReport,
  type SliceMetrics,
  SCORED_QUESTIONS,
  evaluateQuestion,
} from "./metrics.js"

export interface ReportData {
  judge: string
  split: string
  /** Mails in the split before the cap. */
  splitSize: number
  /** Mails the cap puts in scope. */
  inScope: number
  /** In scope but without a cached answer. */
  missing: number
  labels: Record<string, number>
  questions: QuestionReport[]
  /** Questions the judge answered that the labels cannot score. */
  unscored: Question[]
}

export function buildReport(input: {
  judge: string
  split: string
  splitSize: number
  inScope: number
  rows: EvalRow[]
}): ReportData {
  const labels: Record<string, number> = {}
  for (const { mail } of input.rows) labels[mail.label] = (labels[mail.label] ?? 0) + 1
  const questions: QuestionReport[] = []
  for (const q of SCORED_QUESTIONS) {
    const report = evaluateQuestion(q, input.rows)
    if (report !== null) questions.push(report)
  }
  const answered = QUESTIONS.filter((q) =>
    input.rows.some((r) => r.answers[q] !== undefined),
  )
  return {
    judge: input.judge,
    split: input.split,
    splitSize: input.splitSize,
    inScope: input.inScope,
    missing: input.inScope - input.rows.length,
    labels,
    questions,
    unscored: answered.filter((q) => !SCORED_QUESTIONS.includes(q)),
  }
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? "-" : value.toFixed(digits)
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n")
}

const BREAKDOWN_TITLES: Record<Breakdown, string> = {
  dataset: "By dataset",
  lang: "By language",
  yearBucket: "By year",
  origin: "Real or synthetic",
}

function sliceRow(name: string, m: SliceMetrics): string[] {
  const h = m.headline
  return [
    name,
    String(m.n),
    String(m.positives),
    fmt(m.atHalf.precision),
    fmt(m.atHalf.recall),
    fmt(m.atHalf.f1),
    fmt(m.auc),
    fmt(m.ece),
    ...(h === null ? [] : [String(h.legit), fmt(h.falsePositiveRate)]),
  ]
}

function renderQuestion(report: QuestionReport): string {
  const { overall: o } = report
  const out: string[] = [`## ${report.question}`]
  out.push(
    table(
      ["TP", "FP", "TN", "FN", "precision", "recall", "F1", "AUC", "ECE"],
      [
        [
          String(o.atHalf.tp),
          String(o.atHalf.fp),
          String(o.atHalf.tn),
          String(o.atHalf.fn),
          fmt(o.atHalf.precision),
          fmt(o.atHalf.recall),
          fmt(o.atHalf.f1),
          fmt(o.auc),
          fmt(o.ece),
        ],
      ],
    ),
    "Confusion counts and rates at threshold 0.5.",
    "### Threshold sweep",
    table(
      ["threshold", "TP", "FP", "TN", "FN", "precision", "recall", "F1", "FPR"],
      report.sweep.map((r) => [
        r.threshold.toFixed(2),
        String(r.tp),
        String(r.fp),
        String(r.tn),
        String(r.fn),
        fmt(r.precision),
        fmt(r.recall),
        fmt(r.f1),
        fmt(r.fpr),
      ]),
    ),
    `### Calibration (expected calibration error ${fmt(report.calibration.ece)}, ten bins)`,
    table(
      ["bin", "n", "mean score", "positive rate"],
      report.calibration.bins.map((b) => [
        `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`,
        String(b.n),
        fmt(b.meanScore),
        fmt(b.positiveRate),
      ]),
    ),
  )
  const withHeadline = o.headline !== null
  for (const breakdown of BREAKDOWNS) {
    out.push(
      `### ${BREAKDOWN_TITLES[breakdown]}`,
      table(
        [
          "slice",
          "n",
          "positives",
          "precision",
          "recall",
          "F1",
          "AUC",
          "ECE",
          ...(withHeadline ? ["legit", "FPR on legit at headline threshold"] : []),
        ],
        Object.entries(report.breakdowns[breakdown]).map(([name, m]) =>
          sliceRow(name, m),
        ),
      ),
    )
  }
  return out.join("\n\n")
}

export function renderReport(data: ReportData): string {
  const out: string[] = [`# Risk eval: ${data.judge} on ${data.split}`]
  out.push(
    [
      `- Mails in the split: ${data.splitSize}; in scope after the cap: ${data.inScope}; judged: ${data.inScope - data.missing}; without an answer: ${data.missing}.`,
      `- Judged mails by label: ${
        Object.entries(data.labels)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([l, n]) => `${l} ${n}`)
          .join(", ") || "none"
      }.`,
      "- Ground truth: `phishing` is true for phishing mails; `spam` is true for spam and false for legit, and phishing mails are left out of it.",
      data.unscored.length > 0
        ? `- Answered but not scored, since no dataset labels them: ${data.unscored.join(", ")}.`
        : "- Every question the judge answered is scored.",
    ].join("\n"),
  )

  const phishing = data.questions.find((q) => q.question === "phishing")
  const h = phishing?.overall.headline
  out.push("## Headline")
  if (h === null || h === undefined || h.threshold === null) {
    out.push(
      "No headline: the judged mails hold no phishing, or the judge did not answer `phishing`.",
    )
  } else {
    out.push(
      `**False-positive rate on legitimate mail at the threshold that catches ${(h.recallTarget * 100).toFixed(0)}% of phishing: ${fmt(h.falsePositiveRate)}** ` +
        `(${h.falsePositives} of ${h.legit} legit mails flagged at threshold ${fmt(h.threshold)}, phishing recall there ${fmt(h.recallAchieved)}).`,
    )
    if (h.threshold <= 0) {
      out.push(
        "Threshold 0 means the judge gives some phishing mail the lowest possible score, so reaching the recall target " +
          "meant flagging every mail. Read the headline as 'this judge cannot reach the target at a useful threshold'; " +
          "the sweep below shows the recall it can reach.",
      )
    }
  }
  for (const q of data.questions) out.push(renderQuestion(q))
  return `${out.join("\n\n")}\n`
}
