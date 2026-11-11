import { MIN_NORMALISED_CHARS } from "./limits.js"
import type { Mail } from "./schema.js"
import { dedupText, sha256Hex } from "./text.js"

export interface DatasetDedupStats {
  input: number
  kept: number
}

export interface DedupStats {
  input: number
  kept: number
  /** Dropped for having under MIN_NORMALISED_CHARS of subject plus text. */
  tooShort: number
  /** Dropped for byte-identical subject and text. */
  exact: number
  /** Dropped for equal text after lower-casing and collapsing whitespace. */
  whitespaceNormalised: number
  /** Duplicates whose label differed from the copy that was kept. */
  labelConflicts: number
  perDataset: Record<string, DatasetDedupStats>
}

/**
 * Removes duplicates across datasets. The combined sets (Enron, SpamAssassin,
 * Nazario...) overlap heavily, so the same mail arrives from several sources.
 *
 * ⚠ FIRST COPY WINS, SO INPUT ORDER IS THE PRIORITY. The caller feeds datasets
 * in registry order, which puts primary sources ahead of compilations. A
 * duplicate that carries a different label is still dropped and counted in
 * `labelConflicts`; it is the number to look at when two sources disagree.
 */
export function dedupe(mails: Iterable<Mail>): { kept: Mail[]; stats: DedupStats } {
  const stats: DedupStats = {
    input: 0,
    kept: 0,
    tooShort: 0,
    exact: 0,
    whitespaceNormalised: 0,
    labelConflicts: 0,
    perDataset: {},
  }
  const exactSeen = new Map<string, Mail["label"]>()
  const normalisedSeen = new Map<string, Mail["label"]>()
  const kept: Mail[] = []

  for (const mail of mails) {
    stats.input++
    const per = (stats.perDataset[mail.dataset] ??= { input: 0, kept: 0 })
    per.input++

    const normalised = dedupText(mail.subject, mail.text)
    if (normalised.length < MIN_NORMALISED_CHARS) {
      stats.tooShort++
      continue
    }
    const exactKey = sha256Hex(`${mail.subject}\0${mail.text}`)
    const seenExact = exactSeen.get(exactKey)
    if (seenExact !== undefined) {
      stats.exact++
      if (seenExact !== mail.label) stats.labelConflicts++
      continue
    }
    const normalisedKey = sha256Hex(normalised)
    const seenNormalised = normalisedSeen.get(normalisedKey)
    if (seenNormalised !== undefined) {
      stats.whitespaceNormalised++
      if (seenNormalised !== mail.label) stats.labelConflicts++
      continue
    }
    exactSeen.set(exactKey, mail.label)
    normalisedSeen.set(normalisedKey, mail.label)
    kept.push(mail)
    per.kept++
    stats.kept++
  }
  return { kept, stats }
}
