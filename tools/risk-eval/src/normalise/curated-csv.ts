import { join } from "node:path"
import { parseCsvRecords } from "../csv.js"
import type { Label } from "../schema.js"
import { type Normaliser, readText, toMail } from "./common.js"

/**
 * The Champa et al. "Phishing Email Curated Datasets" CSVs (Zenodo 8339691,
 * Figshare 25432108, and the Kaggle "Phishing Email Dataset" which carries the
 * same files). Columns: `sender, receiver, date, subject, body, urls, label`,
 * label 1 or 0.
 *
 * ⚠ THEIR `1` IS NOT ONE THING. The authors merge phishing, fraud and plain
 * spam under it, so it is mapped by FILE, which is the only information there
 * is: Nazario and Nigerian-fraud files are phishing (advance-fee fraud is
 * closest to phishing among our three labels), every other file's 1 is spam,
 * and 0 is legit. `original_label` keeps `<file>:<cell>` so the coarse source
 * stays visible.
 */
export function curatedLabel(file: string, cell: string): Label | undefined {
  if (cell === "0") return "legit"
  if (cell !== "1") return undefined
  return /^(Nazario|Nigerian)/.test(file) ? "phishing" : "spam"
}

function yearOf(date: string): number | undefined {
  const year = Number(/\b(19[89]\d|20[0-3]\d)\b/.exec(date)?.[1])
  return Number.isFinite(year) ? year : undefined
}

export const normaliseCuratedCsv: Normaliser = async function* (ctx) {
  for (const file of ctx.dataset.files) {
    const text = await readText(join(ctx.dir, file.name))
    let index = 0
    for (const record of parseCsvRecords(text)) {
      const key = `${file.name}#${index++}`
      const label = curatedLabel(file.name, record.label ?? "")
      if (label === undefined) {
        ctx.stats.skipped++
        continue
      }
      yield toMail(ctx.dataset, key, label, `${file.name}:${record.label}`, {
        subject: record.subject ?? "",
        text: record.body ?? "",
        year: yearOf(record.date ?? ""),
      })
    }
  }
}
