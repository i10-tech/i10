/** The one record shape every dataset is normalised into. */

export const LABELS = ["phishing", "spam", "legit"] as const
export type Label = (typeof LABELS)[number]

export interface Mail {
  /** `<dataset>:<16 hex of sha256(source key)>`; stable across re-parses. */
  id: string
  dataset: string
  label: Label
  /** The source's own label when it is coarser than ours, e.g. "easy_ham". */
  original_label?: string
  subject: string
  text: string
  html?: string
  /** ISO 639-1 code, or "und" when undecided. See lang.ts for the method. */
  lang: string
  year?: number
  from_domain?: string
  has_attachments?: boolean
  /** True when a model or a script wrote the mail rather than a mailbox. */
  synthetic: boolean
}

export const YEAR_BUCKETS = [
  "unknown",
  "<2010",
  "2010-2019",
  "2020-2022",
  "2023+",
] as const
export type YearBucket = (typeof YEAR_BUCKETS)[number]

export function yearBucket(year: number | undefined): YearBucket {
  if (year === undefined) return "unknown"
  if (year < 2010) return "<2010"
  if (year < 2020) return "2010-2019"
  if (year < 2023) return "2020-2022"
  return "2023+"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parses one JSONL line, failing loudly on anything that is not a Mail. */
export function parseMail(line: string): Mail {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value)) throw new Error("mail line is not an object")
  const { id, dataset, label, subject, text, lang, synthetic } = value
  if (typeof id !== "string" || typeof dataset !== "string") {
    throw new Error("mail line lacks id or dataset")
  }
  if (typeof label !== "string" || !(LABELS as readonly string[]).includes(label)) {
    throw new Error(`mail ${id} has an unknown label`)
  }
  if (typeof subject !== "string" || typeof text !== "string") {
    throw new Error(`mail ${id} lacks subject or text`)
  }
  if (typeof lang !== "string" || typeof synthetic !== "boolean") {
    throw new Error(`mail ${id} lacks lang or synthetic`)
  }
  return value as unknown as Mail
}

export function parseMails(jsonl: string): Mail[] {
  const mails: Mail[] = []
  for (const line of jsonl.split("\n")) {
    if (line.trim() !== "") mails.push(parseMail(line))
  }
  return mails
}
