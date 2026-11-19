import { join } from "node:path"
import { extractArchive } from "../archive.js"
import { sha256Hex } from "../text.js"
import { type Normaliser, fieldsFromRaw, readMessageFile, toMail } from "./common.js"

/**
 * Untroubled.org spam archive: 7z files (a year, or one month of the current
 * year), one message per `.txt`. Everything in it was caught by a bait address,
 * so every message is spam; it says nothing about phishing versus bulk spam.
 *
 * A year holds far more mail than the other datasets, so each archive is
 * sampled down to `sampleCap` messages. The sample is the messages whose
 * path hashes lowest: deterministic, and unbiased by file order.
 */
export const normaliseUntroubled: Normaliser = async function* (ctx) {
  const cap = ctx.dataset.sampleCap ?? Number.POSITIVE_INFINITY
  for (const file of ctx.dataset.files) {
    const dest = join(ctx.dir, "extracted", file.name)
    const all = await extractArchive(join(ctx.dir, file.name), dest)
    const archiveYear = Number(/^(\d{4})/.exec(file.name)?.[1])
    const chosen = all
      .filter((f) => f.endsWith(".txt"))
      .map((rel) => ({ rel, rank: sha256Hex(`${file.name}/${rel}`) }))
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .slice(0, cap)
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))
    for (const { rel } of chosen) {
      try {
        const fields = fieldsFromRaw(await readMessageFile(join(dest, rel)))
        yield toMail(ctx.dataset, `${file.name}/${rel}`, "spam", "spam", {
          ...fields,
          year: fields.year ?? (Number.isFinite(archiveYear) ? archiveYear : undefined),
        })
      } catch {
        ctx.stats.skipped++
      }
    }
  }
}
