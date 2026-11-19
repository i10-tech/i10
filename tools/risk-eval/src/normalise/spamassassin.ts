import { join } from "node:path"
import { extractArchive } from "../archive.js"
import type { Label } from "../schema.js"
import { type Normaliser, fieldsFromRaw, readMessageFile, toMail } from "./common.js"

/**
 * SpamAssassin public corpus: one message per file, in tar.bz2 archives named
 * `<date>_<kind>`. The kind is the only label the corpus carries, so it is kept
 * as `original_label`: easy_ham and hard_ham are both legit (hard_ham is the
 * non-spam that looks like spam), everything else is spam.
 */
export function spamAssassinLabel(archiveName: string): {
  label: Label
  original: string
} {
  const kind = archiveName.replace(/^\d{8}_/, "").replace(/\.tar\.bz2$/, "")
  return { label: kind.includes("ham") ? "legit" : "spam", original: kind }
}

/** Message files are `00001.<md5>`; the archive also holds a `cmds` script. */
const MESSAGE_FILE = /(?:^|\/)\d{4,}\.[0-9a-f]{20,}$/

export const normaliseSpamAssassin: Normaliser = async function* (ctx) {
  for (const file of ctx.dataset.files) {
    const dest = join(ctx.dir, "extracted", file.name)
    const files = await extractArchive(join(ctx.dir, file.name), dest)
    const { label, original } = spamAssassinLabel(file.name)
    for (const rel of files.filter((f) => MESSAGE_FILE.test(f))) {
      try {
        const fields = fieldsFromRaw(await readMessageFile(join(dest, rel)))
        yield toMail(ctx.dataset, `${file.name}/${rel}`, label, original, fields)
      } catch {
        ctx.stats.skipped++
      }
    }
  }
}
