import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type DedupStats, dedupe } from "./dedup.js"
import { type Manifest, verifyDataset } from "./fetch.js"
import { NORMALISERS } from "./normalise/index.js"
import { type Mail, parseMails } from "./schema.js"
import { DATASETS, type DatasetDef, fetchableByDefault } from "./registry.js"
import { datasetDir } from "./paths.js"
import { type CountTable, type SplitSummary, countMails, splitMails } from "./split.js"

/** Layout under the cache root, apart from the one directory per dataset. */
export const normalisedPath = (root: string, name: string) =>
  join(root, "normalised", `${name}.jsonl`)
export const splitPath = (root: string, side: string) =>
  join(root, "splits", `${side}.jsonl`)

export function toJsonl(mails: Mail[]): string {
  return mails.map((m) => JSON.stringify(m)).join("\n") + (mails.length > 0 ? "\n" : "")
}

export interface NormaliseSummary {
  datasets: Record<string, { parsed: number; skipped: number }>
  dedup: DedupStats
}

/**
 * Normalises datasets into `<cache>/normalised/<id>.jsonl`, then deduplicates
 * ALL normalised datasets together, in registry order, into `all.jsonl`.
 *
 * Each dataset's files are checked against the manifest first. With no ids,
 * the datasets whose terms allow evaluation are used; an unclear one has to be
 * named, mirroring `fetch`.
 */
export async function normaliseAll(opts: {
  root: string
  manifest: Manifest
  only: string[]
  log: (line: string) => void
}): Promise<NormaliseSummary> {
  await mkdir(join(opts.root, "normalised"), { recursive: true })
  const chosen: DatasetDef[] =
    opts.only.length === 0
      ? DATASETS.filter(fetchableByDefault)
      : DATASETS.filter((d) => opts.only.includes(d.id))
  const unknown = opts.only.filter((id) => !DATASETS.some((d) => d.id === id))
  if (unknown.length > 0) throw new Error(`unknown dataset: ${unknown.join(", ")}`)

  // Keep the counts of datasets normalised by earlier runs.
  const summaryPath = join(opts.root, "normalised", "summary.json")
  const previous: NormaliseSummary | undefined = existsSync(summaryPath)
    ? (JSON.parse(await readFile(summaryPath, "utf8")) as NormaliseSummary)
    : undefined
  const perDataset: NormaliseSummary["datasets"] = { ...previous?.datasets }
  for (const dataset of chosen) {
    await verifyDataset(opts.root, dataset, opts.manifest)
    const normaliser = NORMALISERS[dataset.id]
    if (normaliser === undefined) throw new Error(`no normaliser for ${dataset.id}`)
    const stats = { skipped: 0 }
    const mails: Mail[] = []
    for await (const mail of normaliser({
      dataset,
      dir: datasetDir(opts.root, dataset.id),
      stats,
    })) {
      mails.push(mail)
    }
    await writeFile(normalisedPath(opts.root, dataset.id), toJsonl(mails))
    perDataset[dataset.id] = { parsed: mails.length, skipped: stats.skipped }
    opts.log(`${dataset.id}: ${mails.length} mails, ${stats.skipped} skipped`)
  }

  // Dedup runs over every normalised dataset on disk, not just this run's,
  // so normalising one dataset again never produces a partial `all.jsonl`.
  const everything: Mail[] = []
  for (const dataset of DATASETS) {
    const path = normalisedPath(opts.root, dataset.id)
    if (existsSync(path)) everything.push(...parseMails(await readFile(path, "utf8")))
  }
  const { kept, stats } = dedupe(everything)
  const summary: NormaliseSummary = { datasets: perDataset, dedup: stats }
  await writeFile(normalisedPath(opts.root, "all"), toJsonl(kept))
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  opts.log(
    `dedup: ${stats.input} in, ${stats.kept} kept (${stats.exact} exact, ${stats.whitespaceNormalised} whitespace, ` +
      `${stats.tooShort} too short, ${stats.labelConflicts} label conflicts)`,
  )
  return summary
}

export interface CountsFile {
  normalise: NormaliseSummary | null
  deduplicated: CountTable
  split: SplitSummary & { devCounts: CountTable; testCounts: CountTable }
}

/** Splits `all.jsonl` into dev and test and returns the committed count summary. */
export async function splitAll(opts: {
  root: string
  seed: string
  devFraction: number
}): Promise<CountsFile> {
  const all = parseMails(await readFile(normalisedPath(opts.root, "all"), "utf8"))
  const ordered = [...all].sort((a, b) => (a.id < b.id ? -1 : 1))
  const { assignment, summary } = splitMails(ordered, {
    seed: opts.seed,
    devFraction: opts.devFraction,
  })
  const dev = ordered.filter((m) => assignment.get(m.id) === "dev")
  const test = ordered.filter((m) => assignment.get(m.id) === "test")
  await mkdir(join(opts.root, "splits"), { recursive: true })
  await writeFile(splitPath(opts.root, "dev"), toJsonl(dev))
  await writeFile(splitPath(opts.root, "test"), toJsonl(test))

  const summaryPath = join(opts.root, "normalised", "summary.json")
  const normalise: NormaliseSummary | null = existsSync(summaryPath)
    ? (JSON.parse(await readFile(summaryPath, "utf8")) as NormaliseSummary)
    : null
  const counts: CountsFile = {
    normalise,
    deduplicated: countMails(all),
    split: { ...summary, devCounts: countMails(dev), testCounts: countMails(test) },
  }
  await writeFile(
    join(opts.root, "splits", "summary.json"),
    `${JSON.stringify(counts, null, 2)}\n`,
  )
  return counts
}

export async function readSplit(root: string, side: string): Promise<Mail[]> {
  return parseMails(await readFile(splitPath(root, side), "utf8"))
}
