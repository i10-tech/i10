import { describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { normaliseCuratedCsv, curatedLabel } from "../src/normalise/curated-csv.js"
import {
  normaliseHfMultilingual,
  splitSubject,
} from "../src/normalise/hf-multilingual.js"
import { normaliseNazario } from "../src/normalise/nazario.js"
import {
  normaliseSpamAssassin,
  spamAssassinLabel,
} from "../src/normalise/spamassassin.js"
import { normaliseUntroubled } from "../src/normalise/untroubled.js"
import { collect, dataset, withTempDir } from "./helpers.js"

describe("nazario", () => {
  it("reads an mbox of phishing, dates the mails, and drops the folder-internal record", async () => {
    await withTempDir(async (dir) => {
      const mbox = [
        "From MAILER-DAEMON Wed Sep 27 09:57:25 2017",
        "From: Mail System Internal Data <MAILER-DAEMON@monkey.org>",
        "Subject: DON'T DELETE THIS MESSAGE -- FOLDER INTERNAL DATA",
        "",
        "This text is part of the internal format of your mail folder.",
        "",
        "From jose@monkey.org Wed Jan 12 14:09:38 2022 +0000",
        "From: Support <help@payp4l-secure.example>",
        "Subject: Your account is limited",
        "Date: Wed, 12 Jan 2022 14:09:37 +0000",
        "Content-Type: text/plain",
        "",
        "Please confirm your password within 24 hours or the account will be closed.",
        "",
      ].join("\n")
      await writeFile(join(dir, "phishing-2022"), mbox)
      const stats = { skipped: 0 }
      const mails = await collect(
        normaliseNazario({
          dataset: dataset("nazario", ["phishing-2022"]),
          dir,
          stats,
        }),
      )
      expect(mails).toHaveLength(1)
      expect(mails[0]).toMatchObject({
        dataset: "nazario",
        label: "phishing",
        original_label: "phishing",
        subject: "Your account is limited",
        year: 2022,
        from_domain: "payp4l-secure.example",
        lang: "en",
        synthetic: false,
      })
      expect(stats.skipped).toBe(1)
    })
  })
})

describe("spamassassin", () => {
  it("maps archive names to labels and keeps the coarse kind", () => {
    expect(spamAssassinLabel("20030228_easy_ham_2.tar.bz2")).toEqual({
      label: "legit",
      original: "easy_ham_2",
    })
    expect(spamAssassinLabel("20030228_hard_ham.tar.bz2")).toEqual({
      label: "legit",
      original: "hard_ham",
    })
    expect(spamAssassinLabel("20050311_spam_2.tar.bz2")).toEqual({
      label: "spam",
      original: "spam_2",
    })
  })

  it("extracts a tar.bz2 and reads one message per file, skipping the cmds script", async () => {
    await withTempDir(async (dir) => {
      const src = join(dir, "src", "hard_ham")
      await mkdir(src, { recursive: true })
      const hex = "0123456789abcdef0123456789abcdef"
      await writeFile(
        join(src, `00001.${hex}`),
        "From: Starflung NIC <nic@starflung.example>\nSubject: Automated renewal reminder\nDate: Mon, 27 May 2002 21:53:26 -0500\n\nYour domain renews soon. This is an automated notice for the account holder.\n",
      )
      await writeFile(join(src, "cmds"), "mv 00001 00002\n")
      const archive = join(dir, "20030228_hard_ham.tar.bz2")
      const tar = Bun.spawn([
        "tar",
        "-cjf",
        archive,
        "-C",
        join(dir, "src"),
        "hard_ham",
      ])
      expect(await tar.exited).toBe(0)

      const mails = await collect(
        normaliseSpamAssassin({
          dataset: dataset("spamassassin", ["20030228_hard_ham.tar.bz2"]),
          dir,
          stats: { skipped: 0 },
        }),
      )
      expect(mails).toHaveLength(1)
      expect(mails[0]).toMatchObject({
        label: "legit",
        original_label: "hard_ham",
        subject: "Automated renewal reminder",
        year: 2002,
        from_domain: "starflung.example",
      })
    })
  })
})

describe("untroubled", () => {
  it("labels everything spam, samples deterministically, and falls back to the archive year", async () => {
    await withTempDir(async (dir) => {
      // A finished extraction is reused (see extractArchive), so the fixture
      // plants the extracted tree instead of needing a 7z encoder.
      const dest = join(dir, "extracted", "2024.7z", "2024", "05")
      await mkdir(dest, { recursive: true })
      await writeFile(join(dir, "extracted", "2024.7z", ".extracted"), "")
      for (let i = 0; i < 10; i++) {
        await writeFile(
          join(dest, `${i}.txt`),
          `From: bait${i}@spam.example\nSubject: Greetings number ${i}\n\nI made money from crude oil and I want to share ${i} million dollars with you.\n`,
        )
      }
      const def = dataset("untroubled", ["2024.7z"], { sampleCap: 4 })
      const run = () =>
        collect(normaliseUntroubled({ dataset: def, dir, stats: { skipped: 0 } }))
      const first = await run()
      expect(first).toHaveLength(4)
      expect(first.every((m) => m.label === "spam" && m.year === 2024)).toBe(true)
      expect((await run()).map((m) => m.id)).toEqual(first.map((m) => m.id))
    })
  })
})

describe("hf-multilingual-synth", () => {
  it("splits the Subject line out and trusts the language column", async () => {
    expect(splitSubject("Subject: Hello\n\nBody here")).toEqual({
      subject: "Hello",
      body: "Body here",
    })
    expect(splitSubject("No subject line")).toEqual({
      subject: "",
      body: "No subject line",
    })
    await withTempDir(async (dir) => {
      const csv = [
        "id,language,text,label",
        '1,id,"Subject: Buletin Bulanan\n\nAgenda webinar investasi edisi April telah dijadwalkan.",0',
        '2,en,"Subject: Act now\n\nYour account will be SUSPENDED, send your card number.",1',
        "3,en,broken,2",
      ].join("\n")
      await writeFile(join(dir, "m.csv"), csv)
      const stats = { skipped: 0 }
      const mails = await collect(
        normaliseHfMultilingual({
          dataset: dataset("hf-multilingual-synth", ["m.csv"], { synthetic: true }),
          dir,
          stats,
        }),
      )
      expect(mails.map((m) => [m.label, m.lang, m.subject, m.synthetic])).toEqual([
        ["legit", "id", "Buletin Bulanan", true],
        ["phishing", "en", "Act now", true],
      ])
      expect(stats.skipped).toBe(1)
    })
  })
})

describe("zenodo-curated (and the Kaggle copy of the same CSVs)", () => {
  it("maps the merged 1 label by file", () => {
    expect(curatedLabel("Nazario.csv", "1")).toBe("phishing")
    expect(curatedLabel("Nigerian_Fraud.csv", "1")).toBe("phishing")
    expect(curatedLabel("CEAS_08.csv", "1")).toBe("spam")
    expect(curatedLabel("Enron.csv", "0")).toBe("legit")
    expect(curatedLabel("Enron.csv", "x")).toBeUndefined()
  })

  it("reads the documented columns and keeps the source label", async () => {
    await withTempDir(async (dir) => {
      const csv = [
        "sender,receiver,date,subject,body,urls,label",
        '"Bob <bob@x.example>",me@y.example,"Tue, 02 Aug 2005 10:00:00 -0000",Hello,"Cheap meds, buy now, big discount today",1,1',
        "a@b.example,c@d.example,,Meeting,See you at the usual place tomorrow morning,0,0",
      ].join("\n")
      await writeFile(join(dir, "CEAS_08.csv"), csv)
      const mails = await collect(
        normaliseCuratedCsv({
          dataset: dataset("zenodo-curated", ["CEAS_08.csv"]),
          dir,
          stats: { skipped: 0 },
        }),
      )
      expect(mails.map((m) => [m.label, m.original_label, m.year])).toEqual([
        ["spam", "CEAS_08.csv:1", 2005],
        ["legit", "CEAS_08.csv:0", undefined],
      ])
    })
  })
})
