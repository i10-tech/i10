import { assertDatasetId } from "./paths.js"

/**
 * The datasets the pipeline can fetch and normalise, in DEDUPLICATION PRIORITY
 * order: when two datasets hold the same mail, the earlier one keeps it.
 *
 * Terms are recorded here because `fetch` enforces them. The quotes are copied
 * from the primary source on the date in `checked`; DATASETS.md carries the
 * longer write-up and the datasets that cannot be scripted at all.
 */

export type TermsVerdict = "internal-eval" | "train-ok" | "unclear" | "not-usable"

export interface Terms {
  verdict: TermsVerdict
  source: string
  quote: string
  checked: string
}

export interface RemoteFile {
  /** File name in the dataset directory. */
  name: string
  url: string
}

export interface DatasetDef {
  id: string
  title: string
  terms: Terms
  synthetic: boolean
  files: RemoteFile[]
  /** Mails kept per archive or file when it is far larger than the others. */
  sampleCap?: number
}

const CHECKED = "2026-11-11"

const NAZARIO_BASE = "https://monkey.org/~jose/phishing/"
const SPAMASSASSIN_BASE = "https://spamassassin.apache.org/old/publiccorpus/"
const UNTROUBLED_BASE = "https://untroubled.org/spam/"

const nazarioFiles = [
  "phishing0.mbox",
  "phishing1.mbox",
  "phishing2.mbox",
  "phishing3.mbox",
  ...Array.from({ length: 11 }, (_, i) => `phishing-${2015 + i}`),
]

const untroubledArchives = [
  ...[2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y) => `${y}.7z`),
  ...Array.from({ length: 10 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}.7z`),
]

const ZENODO_CURATED = [
  "CEAS_08.csv",
  "Enron.csv",
  "Nazario.csv",
  "Nazario_5.csv",
  "Nigerian_5.csv",
  "Nigerian_Fraud.csv",
  "SpamAssasin.csv",
  "TREC_05.csv",
  "TREC_06.csv",
  "TREC_07.csv",
  "Ling.csv",
]

export const DATASETS: DatasetDef[] = [
  {
    id: "nazario",
    title: "Nazario phishing corpus, 2005-2025",
    synthetic: false,
    terms: {
      verdict: "train-ok",
      source: `${NAZARIO_BASE}README.txt`,
      quote:
        "The license for these files is CC-BY-4.0, enabling derivative works and commercial use but does require attribution.",
      checked: CHECKED,
    },
    files: nazarioFiles.map((name) => ({ name, url: `${NAZARIO_BASE}${name}` })),
  },
  {
    id: "spamassassin",
    title: "Apache SpamAssassin public corpus",
    synthetic: false,
    terms: {
      verdict: "internal-eval",
      source: `${SPAMASSASSIN_BASE}readme.html`,
      quote:
        "This is a selection of mail messages, suitable for use in testing spam filtering systems. ... Copyright for the text in the messages remains with the original senders.",
      checked: CHECKED,
    },
    files: [
      "20030228_easy_ham.tar.bz2",
      "20030228_easy_ham_2.tar.bz2",
      "20030228_hard_ham.tar.bz2",
      "20030228_spam.tar.bz2",
      "20050311_spam_2.tar.bz2",
    ].map((name) => ({ name, url: `${SPAMASSASSIN_BASE}${name}` })),
  },
  {
    id: "untroubled",
    title: "Untroubled.org spam archive, 2019-2026",
    synthetic: false,
    sampleCap: 600,
    terms: {
      verdict: "train-ok",
      source: UNTROUBLED_BASE,
      quote: "Permission is hereby granted to use this archive without restriction.",
      checked: CHECKED,
    },
    files: untroubledArchives.map((name) => ({
      name,
      url: `${UNTROUBLED_BASE}${name}`,
    })),
  },
  {
    id: "hf-multilingual-synth",
    title: "Phishing Emails Multilingual (ID/EN), synthetic",
    synthetic: true,
    terms: {
      verdict: "train-ok",
      source:
        "https://huggingface.co/datasets/Febriyansyah/phishing-emails-multilingual",
      quote: "Lisensi: MIT.",
      checked: CHECKED,
    },
    files: [
      {
        name: "phishing_email_multilingual.csv",
        url: "https://huggingface.co/datasets/Febriyansyah/phishing-emails-multilingual/resolve/81de6750a6658efaa1c0ae5a58acfe2b183d968c/phishing_email_multilingual.csv",
      },
    ],
  },
  {
    id: "zenodo-curated",
    title: "Phishing Email Curated Datasets (Champa et al.), 1995-2022",
    synthetic: false,
    terms: {
      verdict: "unclear",
      source: "https://zenodo.org/records/8339691",
      quote:
        "License: CC-BY-4.0 for the compilation (Zenodo record metadata). The underlying Enron, TREC, CEAS and Ling corpora keep their own terms.",
      checked: CHECKED,
    },
    files: ZENODO_CURATED.map((name) => ({
      name,
      url: `https://zenodo.org/api/records/8339691/files/${name}/content`,
    })),
  },
]

for (const d of DATASETS) assertDatasetId(d.id)

export function findDataset(id: string): DatasetDef {
  const found = DATASETS.find((d) => d.id === id)
  if (found === undefined) throw new Error(`unknown dataset: ${id}`)
  return found
}

/** Verdicts that need no extra flag to fetch. */
export function fetchableByDefault(d: DatasetDef): boolean {
  return d.terms.verdict === "internal-eval" || d.terms.verdict === "train-ok"
}
