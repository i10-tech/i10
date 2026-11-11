import { clusterNearDuplicates } from "../cluster.js"
import { dedupText } from "../text.js"
import { renderTemplate } from "./render.js"
import { TEMPLATES } from "./templates/index.js"
import type { GeneratedMail, Template } from "./types.js"

/**
 * The generator behind the `synthetic-legit-modern` dataset: authored
 * templates, filled with fictional data, rendered to plain text and HTML.
 *
 * It is deterministic. The same seed and options give the same mails on any
 * machine, so the set is reproducible and `counts.json` can be committed.
 * Changing the seed, a template or a fill pool changes the set on purpose.
 */

export const GENERATOR_SEED = "i10-risk-eval-legit-1"

/** The year recorded on every generated mail. */
export const GENERATION_YEAR = 2026

export interface GenerateOptions {
  seed: string
  year: number
  /** Mails rendered from each template before duplicates are removed. */
  perTemplate: number
  /**
   * The most mails kept from one near-duplicate cluster. The split moves a whole
   * cluster to one side, and without this cap one template could fill a side.
   */
  maxPerCluster: number
}

export const DEFAULT_OPTIONS: GenerateOptions = {
  seed: GENERATOR_SEED,
  year: GENERATION_YEAR,
  perTemplate: 24,
  maxPerCluster: 6,
}

export interface GenerateStats {
  templates: number
  rendered: number
  /** Dropped as equal to an earlier mail after case and whitespace folding. */
  duplicates: number
  /** Dropped because their near-duplicate cluster was already full. */
  capped: number
  kept: number
  /** Clusters among the kept mails. */
  clusters: number
  /** The largest cluster before the cap. */
  largestClusterBeforeCap: number
}

export function generateMails(
  overrides: Partial<GenerateOptions> = {},
  templates: Template[] = TEMPLATES,
): { mails: GeneratedMail[]; stats: GenerateStats } {
  const opts = { ...DEFAULT_OPTIONS, ...overrides }
  const ordered = [...templates].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )

  const seen = new Set<string>()
  const unique: GeneratedMail[] = []
  let rendered = 0
  for (const template of ordered) {
    for (let index = 0; index < opts.perTemplate; index++) {
      const mail = renderTemplate(template, { seed: opts.seed, index, year: opts.year })
      rendered++
      const key = dedupText(mail.subject, mail.text)
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(mail)
    }
  }

  const clusterOf = clusterNearDuplicates(
    unique.map((m) => ({ id: m.key, subject: m.subject, text: m.text })),
  )
  const sizes = new Map<string, number>()
  for (const cluster of clusterOf.values())
    sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1)

  const taken = new Map<string, number>()
  const mails: GeneratedMail[] = []
  for (const mail of unique) {
    const cluster = clusterOf.get(mail.key) ?? mail.key
    const count = taken.get(cluster) ?? 0
    if (count >= opts.maxPerCluster) continue
    taken.set(cluster, count + 1)
    mails.push(mail)
  }

  return {
    mails,
    stats: {
      templates: ordered.length,
      rendered,
      duplicates: rendered - unique.length,
      capped: unique.length - mails.length,
      kept: mails.length,
      clusters: taken.size,
      largestClusterBeforeCap: Math.max(0, ...sizes.values()),
    },
  }
}
