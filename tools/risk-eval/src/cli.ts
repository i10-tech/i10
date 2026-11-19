import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  MANIFEST_PATH,
  fetchDatasets,
  pinLocalFiles,
  readManifest,
  selectDatasets,
  writeManifest,
} from "./fetch.js"
import { findJudge } from "./judges/index.js"
import { TOOL_DIR, cacheRoot } from "./paths.js"
import { normaliseAll, readSplit, splitAll } from "./pipeline.js"
import { buildReport, renderReport } from "./report.js"
import { answersPath, loadAnswers, runJudge, selectMails } from "./runner.js"
import type { EvalRow } from "./metrics.js"

const USAGE = `risk-eval: an offline evaluation set and harness for email abuse classifiers.

Usage: bun src/cli.ts <command> [options]

  fetch      [--dataset ID]... [--accept-unclear ID]... [--update-manifest]
  pin        --dataset ID [--accept-unclear ID]   (hash a dataset downloaded by hand)
  normalise  [--dataset ID]...
  split      [--seed S] [--dev-fraction F] [--counts-out PATH]
  run        --judge NAME --split dev|test [--cap N] [--concurrency N] [--dry-run]
  report     --judge NAME --split dev|test [--cap N] [--out FILE]

The cache (downloads, normalised mail, splits, judge answers) lives in
$I10_RISK_EVAL_CACHE, default ~/.cache/i10-risk-eval, and never inside the repo.`

function requireSplit(value: string | undefined): string {
  if (value !== "dev" && value !== "test")
    throw new Error("--split must be dev or test")
  return value
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      dataset: { type: "string", multiple: true },
      "accept-unclear": { type: "string", multiple: true },
      "update-manifest": { type: "boolean" },
      seed: { type: "string" },
      "dev-fraction": { type: "string" },
      "counts-out": { type: "string" },
      judge: { type: "string" },
      split: { type: "string" },
      cap: { type: "string" },
      concurrency: { type: "string" },
      "dry-run": { type: "boolean" },
      out: { type: "string" },
    },
  })
  const log = (line: string) => console.log(line)

  switch (command) {
    case "fetch": {
      const root = cacheRoot()
      const datasets = selectDatasets(
        values.dataset ?? [],
        values["accept-unclear"] ?? [],
      )
      const manifest = await readManifest()
      const next = await fetchDatasets({
        root,
        datasets,
        manifest,
        updateManifest: values["update-manifest"] === true,
        onFile: (r) =>
          log(
            `${r.status.padEnd(10)} ${r.dataset}/${r.file}  ${r.bytes} bytes  ${r.sha256}`,
          ),
      })
      await writeManifest(next)
      log(`manifest: ${MANIFEST_PATH}`)
      return
    }
    case "pin": {
      // For a dataset downloaded by hand: hash the files already in the cache.
      const root = cacheRoot()
      let manifest = await readManifest()
      for (const dataset of selectDatasets(
        values.dataset ?? [],
        values["accept-unclear"] ?? [],
      )) {
        manifest = await pinLocalFiles(root, dataset, manifest)
        log(`pinned ${dataset.id}`)
      }
      await writeManifest(manifest)
      return
    }
    case "normalise": {
      await normaliseAll({
        root: cacheRoot(),
        manifest: await readManifest(),
        only: values.dataset ?? [],
        log,
      })
      return
    }
    case "split": {
      const counts = await splitAll({
        root: cacheRoot(),
        seed: values.seed ?? "i10-risk-eval-1",
        devFraction: Number(values["dev-fraction"] ?? "0.15"),
      })
      const out = values["counts-out"] ?? join(TOOL_DIR, "counts.json")
      await writeFile(out, `${JSON.stringify(counts, null, 2)}\n`)
      log(
        `dev ${counts.split.mails.dev}, test ${counts.split.mails.test}; counts written to ${out}`,
      )
      return
    }
    case "run": {
      const judge = findJudge(values.judge ?? "")
      const root = cacheRoot()
      const mails = await readSplit(root, requireSplit(values.split))
      const { stats } = await runJudge({
        judge,
        mails,
        cacheRoot: root,
        concurrency: Number(values.concurrency ?? "8"),
        ...(values.cap !== undefined ? { cap: Number(values.cap) } : {}),
        dryRun: values["dry-run"] === true,
      })
      log(
        `${values["dry-run"] === true ? "dry run: " : ""}${stats.selected} in scope, ${stats.cached} cached, ` +
          `${stats.pending} to judge, ${stats.computed} judged, ${stats.failed} failed`,
      )
      return
    }
    case "report": {
      const judge = findJudge(values.judge ?? "")
      const root = cacheRoot()
      const split = requireSplit(values.split)
      const mails = await readSplit(root, split)
      const inScope = selectMails(
        mails,
        values.cap !== undefined ? Number(values.cap) : undefined,
      )
      const cached = await loadAnswers(answersPath(root, judge.name))
      const rows: EvalRow[] = []
      for (const mail of inScope) {
        const answers = cached.get(mail.id)
        if (answers !== undefined) rows.push({ mail, answers })
      }
      const markdown = renderReport(
        buildReport({
          judge: judge.name,
          split,
          splitSize: mails.length,
          inScope: inScope.length,
          rows,
        }),
      )
      if (values.out === undefined) {
        process.stdout.write(markdown)
      } else {
        await mkdir(join(values.out, ".."), { recursive: true })
        await writeFile(values.out, markdown)
        log(`report written to ${values.out}`)
      }
      return
    }
    default:
      console.log(USAGE)
      if (command !== undefined && command !== "help") process.exitCode = 1
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
