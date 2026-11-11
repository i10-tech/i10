import { describe, expect, it } from "bun:test"
import { clusterNearDuplicates } from "../src/cluster.js"
import { dedupe } from "../src/dedup.js"
import type { Mail } from "../src/schema.js"
import { countMails, splitMails } from "../src/split.js"
import { distinctText, mail } from "./helpers.js"

describe("dedupe", () => {
  it("drops exact and whitespace-normalised copies across datasets, first copy winning", () => {
    const text = "Dear customer, your parcel is waiting for you at the depot today."
    const a = mail({ dataset: "first", subject: "Parcel", text })
    const exact = mail({ dataset: "second", subject: "Parcel", text })
    const spaced = mail({
      dataset: "second",
      subject: "PARCEL",
      text: `  ${text.replace(/ /g, "  ")}\n`,
    })
    const other = mail({
      dataset: "second",
      subject: "Different",
      text: "Something else entirely, long enough.",
    })
    const { kept, stats } = dedupe([a, exact, spaced, other])
    expect(kept.map((m) => m.id)).toEqual([a.id, other.id])
    expect(stats).toMatchObject({
      input: 4,
      kept: 2,
      exact: 1,
      whitespaceNormalised: 1,
      tooShort: 0,
    })
    expect(stats.perDataset).toEqual({
      first: { input: 1, kept: 1 },
      second: { input: 3, kept: 1 },
    })
  })

  it("counts a duplicate that disagrees on the label, and drops tiny mails", () => {
    const text = "Congratulations, you have been selected to receive a free gift card."
    const a = mail({ label: "spam", subject: "Gift", text })
    const b = mail({ label: "phishing", subject: "Gift", text })
    const tiny = mail({ subject: "", text: "hi" })
    const { kept, stats } = dedupe([a, b, tiny])
    expect(kept).toEqual([a])
    expect(stats.labelConflicts).toBe(1)
    expect(stats.tooShort).toBe(1)
  })
})

const BASE =
  "Dear valued customer we noticed unusual activity on your account number 4455 and your access has been " +
  "limited until you confirm your identity please follow the secure link below within twenty four hours " +
  "to restore full access to your funds and to avoid permanent closure of the account thank you for your " +
  "cooperation and patience while we keep your money safe from fraud"

describe("clusterNearDuplicates", () => {
  it("joins variants that differ by digits or one word, and leaves unrelated mail alone", () => {
    const variants = [4455, 9120, 7731, 1002].map((n) =>
      mail({ subject: "Account", text: BASE.replace("4455", String(n)) }),
    )
    const edited = mail({
      subject: "Account",
      text: BASE.replace("cooperation", "assistance"),
    })
    const unrelated = mail({
      subject: "Lunch",
      text: "Are we still meeting at the new place near the station on thursday for lunch with the whole team",
    })
    const clusters = clusterNearDuplicates([...variants, edited, unrelated])
    const ids = new Set([...variants, edited].map((m) => clusters.get(m.id)))
    expect(ids.size).toBe(1)
    expect(clusters.get(unrelated.id)).toBe(unrelated.id)
  })

  it("does not depend on input order", () => {
    const mails = [1, 2, 3, 4, 5].map((n) =>
      mail({ text: BASE.replace("4455", String(n * 1111)) }),
    )
    const forward = clusterNearDuplicates(mails)
    const backward = clusterNearDuplicates([...mails].reverse())
    expect([...forward].sort()).toEqual([...backward].sort())
  })
})

function corpus(): Mail[] {
  const mails: Mail[] = []
  for (const [label, dataset, lang, n] of [
    ["phishing", "nazario", "en", 60],
    ["spam", "untroubled", "en", 80],
    ["legit", "spamassassin", "en", 40],
    ["spam", "untroubled", "ja", 10],
    ["legit", "synthetic", "id", 3],
  ] as const) {
    for (let i = 0; i < n; i++) {
      mails.push(
        mail({
          label,
          dataset,
          lang,
          subject: `${dataset} ${label} ${i}`,
          text: distinctText(`${dataset}-${label}-${lang}-${i}`),
        }),
      )
    }
  }
  return mails
}

describe("splitMails", () => {
  const opts = { seed: "seed-1", devFraction: 0.2 }

  it("is deterministic and independent of input order", () => {
    const mails = corpus()
    const a = splitMails(mails, opts)
    const b = splitMails([...mails].reverse(), opts)
    expect([...a.assignment].sort()).toEqual([...b.assignment].sort())
    expect(a.summary).toEqual(b.summary)
  })

  it("changes with the seed", () => {
    const mails = corpus()
    const a = splitMails(mails, opts).assignment
    const b = splitMails(mails, { ...opts, seed: "seed-2" }).assignment
    expect([...a].some(([id, side]) => b.get(id) !== side)).toBe(true)
  })

  it("stratifies by label, dataset and language, with small strata wholly in test", () => {
    const { assignment, summary } = splitMails(corpus(), opts)
    const find = (label: string, dataset: string, lang: string) =>
      summary.strata.find(
        (s) => s.label === label && s.dataset === dataset && s.lang === lang,
      )
    expect(find("phishing", "nazario", "en")).toMatchObject({ dev: 12, test: 48 })
    expect(find("spam", "untroubled", "en")).toMatchObject({ dev: 16, test: 64 })
    expect(find("legit", "spamassassin", "en")).toMatchObject({ dev: 8, test: 32 })
    expect(find("spam", "untroubled", "ja")).toMatchObject({ dev: 2, test: 8 })
    expect(find("legit", "synthetic", "id")).toMatchObject({ dev: 1, test: 2 })
    expect(summary.mails.dev + summary.mails.test).toBe(assignment.size)
  })

  it("never puts near-duplicates on both sides", () => {
    const families: Mail[][] = []
    for (let f = 0; f < 30; f++) {
      const stem = distinctText(`family-${f}`, 60)
      // Variants differ only by a reference number, which the shingles flatten.
      families.push(
        [1111, 2222, 3333, 4444].map((n) =>
          mail({
            label: "phishing",
            dataset: "nazario",
            text: `${stem} reference ${n}`,
          }),
        ),
      )
    }
    const all = families.flat()
    const { assignment } = splitMails(all, { seed: "s", devFraction: 0.3 })
    for (const family of families) {
      expect(new Set(family.map((m) => assignment.get(m.id))).size).toBe(1)
    }
    const sides = new Set(all.map((m) => assignment.get(m.id)))
    expect(sides.size).toBe(2)
  })
})

describe("countMails", () => {
  it("counts by label, language, year bucket and dataset", () => {
    const table = countMails([
      mail({ label: "phishing", lang: "ar", year: 2024, dataset: "x" }),
      mail({ label: "legit", lang: "en", year: 2003, dataset: "y", synthetic: true }),
      mail({ label: "legit", lang: "en", dataset: "y" }),
    ])
    expect(table).toMatchObject({
      total: 3,
      synthetic: 1,
      byLabel: { legit: 2, phishing: 1 },
      byLang: { ar: 1, en: 2 },
      byYearBucket: { "2023+": 1, "<2010": 1, unknown: 1 },
      byDataset: { x: 1, y: 2 },
    })
  })
})
