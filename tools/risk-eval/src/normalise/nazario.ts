import { join } from "node:path"
import { splitMbox } from "../mbox.js"
import { type Normaliser, fieldsFromRaw, readBinary, toMail } from "./common.js"

/** The mail system's own bookkeeping record, present at the top of some mboxes. */
const FOLDER_INTERNAL = /^DON'T DELETE THIS MESSAGE -- FOLDER INTERNAL DATA$/i

/**
 * Nazario: mbox files of the maintainer's own inbox, hand classified, every
 * message phishing. `phishingN.mbox` are 2005-2007, `phishing-YYYY` are
 * 2015-2025. A message's year comes from its Date header.
 */
export const normaliseNazario: Normaliser = async function* (ctx) {
  for (const file of ctx.dataset.files) {
    const raw = await readBinary(join(ctx.dir, file.name))
    let index = 0
    for (const message of splitMbox(raw)) {
      const key = `${file.name}#${index++}`
      try {
        const fields = fieldsFromRaw(message)
        if (FOLDER_INTERNAL.test(fields.subject)) {
          ctx.stats.skipped++
          continue
        }
        yield toMail(ctx.dataset, key, "phishing", "phishing", fields)
      } catch {
        ctx.stats.skipped++
      }
    }
  }
}
