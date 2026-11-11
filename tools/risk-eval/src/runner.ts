import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { type Answers, JUDGE_NAME, type Judge, validateAnswers } from "./judge.js"
import type { Mail } from "./schema.js"
import { sha256Hex } from "./text.js"

export interface RunOptions {
  judge: Judge
  mails: Mail[]
  /** The cache root; answers live in `<root>/runs/<judge name>/answers.jsonl`. */
  cacheRoot: string
  concurrency: number
  /** Evaluate at most this many mails (see `selectMails`). */
  cap?: number
  /** Count what would run and write nothing. */
  dryRun?: boolean
  /** Stop after this many failures in a row, so a dead endpoint cannot burn a budget. */
  maxConsecutiveFailures?: number
}

export interface RunStats {
  /** Mails in scope after the cap. */
  selected: number
  /** Of those, answered by an earlier run. */
  cached: number
  /** Of those, still to be asked. */
  pending: number
  computed: number
  failed: number
}

export function answersPath(cacheRoot: string, judgeName: string): string {
  if (!JUDGE_NAME.test(judgeName)) throw new Error(`bad judge name: ${judgeName}`)
  return join(cacheRoot, "runs", judgeName, "answers.jsonl")
}

/**
 * The mails a run covers: ordered by a hash of the id, then cut at `cap`.
 *
 * ⚠ A HASH ORDER, NOT FILE ORDER. The split files are written label by label
 * and dataset by dataset, so "the first 500" would be 500 phishing mails from
 * one corpus. Ordering by hash makes every prefix a random sample, and makes a
 * larger cap a superset of a smaller one, so a rerun with a bigger cap reuses
 * every answer already paid for.
 */
export function selectMails(mails: Mail[], cap: number | undefined): Mail[] {
  const ordered = mails
    .map((mail) => ({ mail, rank: sha256Hex(mail.id) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((x) => x.mail)
  return cap === undefined ? ordered : ordered.slice(0, Math.max(0, cap))
}

/** Reads the cache; a torn last line (a crash mid-write) is ignored. */
export async function loadAnswers(path: string): Promise<Map<string, Answers>> {
  const cache = new Map<string, Answers>()
  if (!existsSync(path)) return cache
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (line.trim() === "") continue
    try {
      const row = JSON.parse(line) as { id?: unknown; answers?: unknown }
      if (typeof row.id === "string") cache.set(row.id, validateAnswers(row.answers))
    } catch {
      // torn or hand-edited line: treat that mail as unanswered
    }
  }
  return cache
}

/**
 * Runs a judge over mails, resumably. Every answer is appended to the cache as
 * soon as it exists, so an interrupted run loses nothing and a rerun asks only
 * about mails with no answer yet.
 */
export async function runJudge(
  opts: RunOptions,
): Promise<{ answers: Map<string, Answers>; stats: RunStats }> {
  const path = answersPath(opts.cacheRoot, opts.judge.name)
  const selected = selectMails(opts.mails, opts.cap)
  const cache = await loadAnswers(path)
  const answers = new Map<string, Answers>()
  const pending: Mail[] = []
  for (const mail of selected) {
    const hit = cache.get(mail.id)
    if (hit === undefined) pending.push(mail)
    else answers.set(mail.id, hit)
  }
  const stats: RunStats = {
    selected: selected.length,
    cached: answers.size,
    pending: pending.length,
    computed: 0,
    failed: 0,
  }
  if (opts.dryRun === true || pending.length === 0) return { answers, stats }

  await mkdir(join(opts.cacheRoot, "runs", opts.judge.name), { recursive: true })
  const limit = opts.maxConsecutiveFailures ?? 20
  let consecutive = 0
  let next = 0
  let lastError: unknown

  const worker = async (): Promise<void> => {
    while (consecutive < limit) {
      const mail = pending[next++]
      if (mail === undefined) return
      try {
        const input = {
          subject: mail.subject,
          text: mail.text,
          ...(mail.html !== undefined ? { html: mail.html } : {}),
        }
        const result = validateAnswers(await opts.judge.judge(input))
        await appendFile(path, `${JSON.stringify({ id: mail.id, answers: result })}\n`)
        answers.set(mail.id, result)
        stats.computed++
        consecutive = 0
      } catch (error) {
        stats.failed++
        consecutive++
        lastError = error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker))

  if (consecutive >= limit) {
    throw new Error(
      `stopped after ${limit} consecutive judge failures; last: ${String(lastError)}`,
    )
  }
  return { answers, stats }
}
