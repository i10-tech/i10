import { join } from "node:path"
import { parseCsvRecords } from "../csv.js"
import { type Normaliser, readText, toMail } from "./common.js"

/**
 * Febriyansyah/phishing-emails-multilingual: 600 synthetic Indonesian and
 * English mails, columns `id,language,text,label` with label 0 benign and 1
 * phishing. The text starts with a `Subject:` line. The `language` column is
 * the generator's own and is kept instead of detecting it.
 */
export function splitSubject(text: string): { subject: string; body: string } {
  const m = /^Subject:[ \t]*(.*)\r?\n/.exec(text)
  if (m === null) return { subject: "", body: text }
  return { subject: (m[1] ?? "").trim(), body: text.slice(m[0].length).trim() }
}

export const normaliseHfMultilingual: Normaliser = async function* (ctx) {
  for (const file of ctx.dataset.files) {
    const text = await readText(join(ctx.dir, file.name))
    for (const record of parseCsvRecords(text)) {
      const { id, text: body, label, language } = record
      if (id === undefined || body === undefined || (label !== "0" && label !== "1")) {
        ctx.stats.skipped++
        continue
      }
      const { subject, body: rest } = splitSubject(body)
      const mail = toMail(
        ctx.dataset,
        `${file.name}#${id}`,
        label === "1" ? "phishing" : "legit",
        label,
        {
          subject,
          text: rest,
        },
      )
      if (language !== undefined && /^[a-z]{2}$/.test(language)) mail.lang = language
      yield mail
    }
  }
}
