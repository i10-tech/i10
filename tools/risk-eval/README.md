# risk-eval

An offline evaluation set and harness for email abuse classifiers. A "judge"
answers typed questions about one email (`phishing`, `spam`,
`impersonates_brand`, `asks_for_credentials`, `is_marketing`) with
probabilities; this tool builds a labelled set from public data and measures any
judge on it.

It is a Bun CLI in `tools/`, not a workspace package: it has no dependencies,
borrows `typescript`, `eslint` and `@types/bun` from the root install, and is
not part of `bun run lint` or `bun run test` at the repo root (see "Checks").

## Data stays out of the repo

The datasets are real phishing and spam. Downloads, extractions, normalised
mail, splits and judge answers live in `$I10_RISK_EVAL_CACHE`, default
`~/.cache/i10-risk-eval`, one directory per dataset. A cache path inside the
checkout is refused. Only code, `manifest.json` (pinned SHA-256 per downloaded
file), `counts.json` (counts only) and these documents are committed. Never open
or fetch a link found in the data, and never feed the mail to a live mail system.

## Pipeline

```sh
cd tools/risk-eval
bun src/cli.ts fetch                 # download datasets whose terms allow it, check pins
bun src/cli.ts normalise             # one JSONL schema, deduplicated across datasets; also generates the synthetic legit set
bun src/cli.ts split                 # dev and test, stratified, near-duplicate safe
bun src/cli.ts run --judge keyword-v1 --split dev --dry-run
bun src/cli.ts run --judge keyword-v1 --split dev --cap 500
bun src/cli.ts report --judge keyword-v1 --split dev --out report.md
```

- `fetch` records size and SHA-256 and compares them with `manifest.json`. A file
  that changed upstream is refused, nothing is kept, and `--update-manifest` is
  how a reviewed change is accepted. A first fetch also needs `--update-manifest`
  to create the pin. A dataset whose terms are unclear needs `--accept-unclear <id>`. A dataset
  behind an account (Kaggle) is downloaded by hand into its cache directory and
  hashed with `pin --dataset <id>`.
- `normalise` parses mbox, one-file-per-message archives (tar.bz2, 7z through
  the system `tar`) and CSV into `{ id, dataset, label, original_label, subject,
text, html?, lang, year?, from_domain?, has_attachments?, synthetic }`, drops
  exact and whitespace-normalised duplicates across datasets, and writes
  `normalised/all.jsonl`. Every parser is bounded (see `src/limits.ts`) and
  tolerates broken encodings; archives are validated before extraction.
- `normalise` also generates `synthetic-legit-modern`, 4,498 modern legitimate
  mails (receipts, password resets, sign-in codes, invitations, shipping notices,
  newsletters and more, in nine languages) from the authored templates in
  `src/generate/`. It needs no download and no manifest entry, and it is
  deterministic from a seed. See "Generated legitimate mail" below.
- `split` is deterministic (seeded, by hash), stratified by label, dataset and
  language, and moves whole near-duplicate clusters together. It writes
  `splits/dev.jsonl`, `splits/test.jsonl`, the per-stratum summary in the cache
  and `counts.json` in this directory.
- `run` covers the mails in hash order up to `--cap`, with bounded
  `--concurrency`, and appends every answer to
  `runs/<judge name>/answers.jsonl`, so a rerun asks only about mails with no
  answer. A bigger cap reuses everything a smaller one answered. A judge that
  fails 20 times in a row stops the run.
- `report` prints markdown from the cached answers.

## Generated legitimate mail

No public dataset of modern legitimate mail exists, and without it the real
legitimate mail is two decades old (see `DATASETS.md`). `src/generate/` writes
some: authored templates (`templates/`, one file per area or language), fictional
fill data (`fill.ts`, `packs.ts`), reserved-domain hosts only (`hosts.ts`), and a
renderer that turns the same blocks into plain text and HTML (`render.ts`).
`generateMails()` renders each template 24 times, drops exact duplicates, then
clusters with the split's own near-duplicate method and keeps at most 6 mails per
cluster. Every mail is `synthetic: true`, `label: "legit"`, `year: 2026`, has an
exact `lang`, a `mail_type` and a `style`, and the hard negatives (legitimate mail
that looks like phishing: urgent alerts, final payment notices, suspensions) also
carry `hard_negative: true`.

**This mail is synthetic and authored by the people building the judge.** It
tests false positives on plausible modern mail. It is not a substitute for real
customer mail, and a judge can still learn that generated mail looks generated
(for one, every link is on a reserved domain such as `.example`).

To add a wording, add a template next to the others and run `bun test`: the tests
check that every host is reserved, no placeholder is left unfilled, languages are
exact, and the output is deterministic. A template change changes the set, so clear
a judge's cached answers for this dataset before rerunning it (answers are cached
by mail id).

## Writing a judge

Implement `Judge` from `src/judge.ts` (a `name` and `judge({ subject, text,
html? })` returning probabilities for any subset of the questions) and add it to
`src/judges/index.ts`. The name is the cache key: change it when behaviour
changes (`my-judge-v2`). `keyword-v1` is a crude baseline and `random-v1` is
seeded noise that a correct harness must score at chance.

## What is scored

Only `phishing` and `spam` have ground truth. `phishing` is true for phishing
mail and false for the rest. `spam` is true for spam and false for legit; phishing
mail is left out of it. The other three questions are recorded but not scored,
since no dataset labels them. Per scored question the report gives confusion
counts, precision, recall and F1 at 0.5, a threshold sweep, ROC AUC, a ten-bin
calibration table with expected calibration error, and the same broken down by
dataset, language, year bucket and real or synthetic.

The report also breaks the results out by `slice`: `generated-legit` (the
modern legitimate mail above), `hard-negative` (the part of it built to look like
phishing) and `other`, with the headline's legitimate-mail table repeated per
slice, and by generated `mailType`.

The headline is the false-positive rate on legitimate mail at the threshold
that catches 90% of phishing. That threshold is chosen once on all phishing
mail and applied unchanged to each slice.

## Checks

```sh
cd tools/risk-eval
bun run check-types && bun run lint && bun test
cd ../.. && bun run format:check
```

CI's `turbo run lint|check-types|test` does not reach this directory because
`tools/*` is not in the root `workspaces`. Making it a workspace means a
`bun.lock` entry and a `COPY tools/risk-eval/package.json` line in each
Dockerfile that `check-images` lists, which is an infrastructure change left to
the reviewer.

See `DATASETS.md` for the datasets, their terms and the gaps.
