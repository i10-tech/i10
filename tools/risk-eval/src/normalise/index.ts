import type { Normaliser } from "./common.js"
import { normaliseCuratedCsv } from "./curated-csv.js"
import { normaliseHfMultilingual } from "./hf-multilingual.js"
import { normaliseNazario } from "./nazario.js"
import { normaliseSpamAssassin } from "./spamassassin.js"
import { normaliseUntroubled } from "./untroubled.js"

/** One normaliser per dataset id in the registry. */
export const NORMALISERS: Record<string, Normaliser> = {
  nazario: normaliseNazario,
  spamassassin: normaliseSpamAssassin,
  untroubled: normaliseUntroubled,
  "hf-multilingual-synth": normaliseHfMultilingual,
  "zenodo-curated": normaliseCuratedCsv,
}
