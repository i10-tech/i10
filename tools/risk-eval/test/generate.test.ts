import { describe, expect, it } from "bun:test"
import { clusterNearDuplicates } from "../src/cluster.js"
import { dedupe } from "../src/dedup.js"
import { GENERATION_YEAR, generateMails } from "../src/generate/index.js"
import { hostsIn, isReservedHost } from "../src/generate/hosts.js"
import { renderTemplate } from "../src/generate/render.js"
import { TEMPLATES } from "../src/generate/templates/index.js"
import {
  HARD_NEGATIVE_TYPES,
  LANGS,
  ORDINARY_TYPES,
  STYLES,
  type Template,
} from "../src/generate/types.js"
import { keywordJudge } from "../src/judges/keyword.js"
import type { EvalRow } from "../src/metrics.js"
import { normaliseSyntheticLegit } from "../src/normalise/synthetic-legit.js"
import { toJsonl } from "../src/pipeline.js"
import { findDataset } from "../src/registry.js"
import { buildReport, renderReport } from "../src/report.js"
import { type Mail, parseMails } from "../src/schema.js"
import { countMails } from "../src/split.js"
import { collect, mail } from "./helpers.js"

const generated = generateMails()
const strings = (m: { subject: string; text: string; html: string }) =>
  [m.subject, m.text, m.html].join("\n")

describe("generateMails", () => {
  it("is deterministic from the seed", () => {
    expect(generateMails().mails).toEqual(generated.mails)
    const other = generateMails({ seed: "another-seed" })
    expect(other.mails.map((m) => m.text)).not.toEqual(
      generated.mails.map((m) => m.text),
    )
  })

  it("renders a template the same way whatever else is in the set", () => {
    const [first] = TEMPLATES
    if (first === undefined) throw new Error("no templates")
    const alone = generateMails({ perTemplate: 3 }, [first])
    const among = generateMails({ perTemplate: 3 }, TEMPLATES)
    expect(alone.mails).toEqual(among.mails.filter((m) => m.templateId === first.id))
  })

  it("only ever names reserved or fictional hosts", () => {
    let checked = 0
    for (const m of generated.mails) {
      const hosts = [...hostsIn(strings(m)), m.fromDomain]
      for (const host of hosts) {
        expect(isReservedHost(host), `${m.key}: ${host}`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(generated.mails.length * 2)
  })

  it("recognises reserved hosts and rejects look-alikes", () => {
    for (const host of [
      "example.com",
      "mail.example.org",
      "a.b.example.net",
      "shop.example",
      "x.test",
      "y.invalid",
      "Example.COM.",
    ]) {
      expect(isReservedHost(host), host).toBe(true)
    }
    for (const host of [
      "paypal.com",
      "notexample.com",
      "example.com.evil.net",
      "example-shop.com",
      "test.com",
      "localhost",
      "",
    ]) {
      expect(isReservedHost(host), host).toBe(false)
    }
  })

  it("leaves no placeholder or choice marker unfilled", () => {
    for (const m of generated.mails) {
      expect(/[{}]|\[\[|\]\]/.test(m.subject), m.key).toBe(false)
      expect(/[{}]|\[\[|\]\]/.test(m.text), m.key).toBe(false)
      // The HTML shell has braces nowhere either: its styles are inline.
      expect(/[{}]|\[\[|\]\]/.test(m.html), m.key).toBe(false)
    }
  })

  it("fails loudly on an unknown placeholder", () => {
    const broken: Template = {
      id: "en.test.broken.1",
      type: "welcome",
      style: "dev-terse",
      lang: "en",
      subject: ["Hello"],
      body: ["Hi {nobody_defines_this}"],
    }
    expect(() => renderTemplate(broken, { seed: "s", index: 0, year: 2026 })).toThrow(
      "unknown placeholder",
    )
  })

  it("tags each mail with exactly its template's language and the generation year", () => {
    const scripts: Partial<Record<(typeof LANGS)[number], RegExp>> = {
      ar: /\p{Script=Arabic}/u,
      ja: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
      zh: /\p{Script=Han}/u,
    }
    for (const m of generated.mails) {
      expect(m.templateId.startsWith(`${m.lang}.`), m.key).toBe(true)
      expect(m.html.includes(`<html lang="${m.lang}"`), m.key).toBe(true)
      const script = scripts[m.lang]
      if (script !== undefined) expect(script.test(m.text), m.key).toBe(true)
      if (m.lang === "zh")
        expect(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(m.text)).toBe(false)
      if (m.lang === "ar") expect(m.html.includes('dir="rtl"'), m.key).toBe(true)
    }
    expect(new Set(generated.mails.map((m) => m.lang))).toEqual(new Set(LANGS))
  })

  it("keeps the text and HTML bodies saying the same thing", () => {
    for (const m of generated.mails.slice(0, 400)) {
      const textLinks = (m.text.match(/https:\/\/\S+/g) ?? []).sort()
      const htmlLinks = [...m.html.matchAll(/href="([^"]+)"/g)]
        .map((x) => x[1] ?? "")
        .sort()
      // Links in the text that are on a line of their own as plain URLs are
      // repeated for the plain reading; every button target is in both.
      for (const link of htmlLinks) expect(textLinks, m.key).toContain(link)
    }
  })

  it("caps near-identical variants of one template", () => {
    const nearlyConstant: Template = {
      id: "en.test.constant.1",
      type: "otp-code",
      style: "dev-terse",
      lang: "en",
      subject: ["Your sign-in code"],
      body: [
        "Use the code below to finish signing in to the dashboard of your account today. We send a code whenever a sign-in comes from a browser or a device that we have not seen before, which keeps your account safe even if someone else learns your password.",
        { code: "{code}" },
        "The code expires soon and works only once. If you did not ask for it you can safely ignore this email and carry on with your day, because nobody can sign in to your account without the code, and nothing about your account has changed. There is nothing else you need to do, and you do not need to reply to this message in any way at all.",
      ],
    }
    const uncapped = generateMails({ perTemplate: 12, maxPerCluster: 99 }, [
      nearlyConstant,
    ])
    expect(uncapped.mails.length).toBe(12)
    expect(uncapped.stats.largestClusterBeforeCap).toBe(12)

    const capped = generateMails({ perTemplate: 12, maxPerCluster: 3 }, [
      nearlyConstant,
    ])
    expect(capped.mails.length).toBe(3)
    expect(capped.stats).toMatchObject({ capped: 9, kept: 3, clusters: 1 })
  })

  it("keeps every cluster of the default set within the cap", () => {
    // Cluster the uncapped set, then count what the capped set kept per cluster.
    const uncapped = generateMails({ maxPerCluster: 1e9 })
    const clusters = clusterNearDuplicates(
      uncapped.mails.map((m) => ({ id: m.key, subject: m.subject, text: m.text })),
    )
    const kept = new Map<string, number>()
    for (const m of generated.mails) {
      const cluster = clusters.get(m.key) ?? m.key
      kept.set(cluster, (kept.get(cluster) ?? 0) + 1)
    }
    expect(Math.max(...kept.values())).toBeLessThanOrEqual(6)
    expect(generated.stats.kept).toBe(generated.mails.length)
  })

  it("covers every mail type, house style and language, with the right ones marked hard", () => {
    const types = new Set(generated.mails.map((m) => m.type))
    for (const type of [...ORDINARY_TYPES, ...HARD_NEGATIVE_TYPES]) {
      expect(types.has(type), type).toBe(true)
    }
    expect(new Set(generated.mails.map((m) => m.style))).toEqual(new Set(STYLES))
    const hard = new Set<string>(HARD_NEGATIVE_TYPES)
    for (const m of generated.mails) expect(m.hardNegative).toBe(hard.has(m.type))

    // Every language has the security, receipt, invitation and welcome mail.
    const required = [
      "password-reset",
      "email-verification",
      "otp-code",
      "magic-link",
      "new-device-alert",
      "password-changed",
      "receipt",
      "team-invitation",
      "welcome",
    ]
    for (const lang of LANGS) {
      const present = new Set(
        generated.mails.filter((m) => m.lang === lang).map((m) => m.type),
      )
      for (const type of required)
        expect(present.has(type as never), `${lang} ${type}`).toBe(true)
    }
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length)
  })

  it("names no real company, and writes no real person's address", () => {
    const real =
      /\b(paypal|amazon|microsoft|apple|google|netflix|stripe|github|dropbox|slack|facebook|instagram|twitter|linkedin|dhl|fedex|usps|docusign|zoom|shopify|spotify|uber|hsbc|barclays|wells fargo|chase)\b/i
    for (const m of generated.mails) {
      // Subject and text only: the HTML shell's font stack names `-apple-system`.
      expect(real.test(`${m.subject}\n${m.text}`), m.key).toBe(false)
    }
  })
})

describe("the synthetic-legit-modern dataset", () => {
  const dataset = findDataset("synthetic-legit-modern")

  it("is registered as authored for i10, synthetic, with nothing to download", () => {
    expect(dataset.synthetic).toBe(true)
    expect(dataset.files).toEqual([])
    expect(dataset.terms.quote).toContain("no third-party content")
  })

  it("normalises to labelled legit mail that survives dedup and a JSONL round trip", async () => {
    const mails = await collect(
      normaliseSyntheticLegit({ dataset, dir: "unused", stats: { skipped: 0 } }),
    )
    expect(mails.length).toBe(generated.mails.length)
    expect(new Set(mails.map((m) => m.id)).size).toBe(mails.length)
    for (const m of mails) {
      expect(m.label).toBe("legit")
      expect(m.synthetic).toBe(true)
      expect(m.year).toBe(GENERATION_YEAR)
      expect(m.html).toBeDefined()
      expect(m.mail_type).toBeDefined()
    }
    const source = new Map(generated.mails.map((g) => [g.key, g.lang]))
    expect(mails.every((m) => LANGS.includes(m.lang as never))).toBe(true)
    expect(mails.filter((m) => m.lang === "ja").length).toBe(
      [...source.values()].filter((l) => l === "ja").length,
    )
    const { kept } = dedupe(mails)
    expect(kept.length).toBe(mails.length)
    expect(parseMails(toJsonl(mails))).toEqual(mails)
  })
})

describe("reports and counts for the generated slices", () => {
  const sample: Mail[] = [
    ...generated.mails
      .filter((m) => m.type === "receipt" || m.hardNegative)
      .slice(0, 60)
      .map((g) =>
        mail({
          label: "legit",
          subject: g.subject,
          text: g.text,
          lang: g.lang,
          year: GENERATION_YEAR,
          synthetic: true,
          dataset: "synthetic-legit-modern",
          mail_type: g.type,
          style: g.style,
          ...(g.hardNegative ? { hard_negative: true } : {}),
        }),
      ),
    mail({
      label: "phishing",
      subject: "Urgent: verify your account",
      text: "Your account is suspended, confirm your account password within 24 hours at https://x.example/login now",
    }),
    mail({
      label: "legit",
      subject: "Lunch",
      text: "See you for lunch tomorrow at noon, usual place.",
    }),
  ]

  it("shows the generated legit slice and the hard-negative slice", async () => {
    const rows: EvalRow[] = await Promise.all(
      sample.map(async (m) => ({ mail: m, answers: await keywordJudge.judge(m) })),
    )
    const markdown = renderReport(
      buildReport({
        judge: "keyword-v1",
        split: "dev",
        splitSize: rows.length,
        inScope: rows.length,
        rows,
      }),
    )
    expect(markdown).toContain("### Legitimate mail by slice, at the same threshold")
    expect(markdown).toContain("generated-legit")
    expect(markdown).toContain("hard-negative")
    expect(markdown).toContain("other (not generated)")
    expect(markdown).toContain("### By slice")
    expect(markdown).toContain("### By generated mail type")
    expect(markdown).toContain("receipt")
    expect(markdown).not.toContain(String.fromCharCode(0x2014))
  })

  it("counts the generated mail by type, language, style and hard negative", () => {
    const table = countMails(sample)
    expect(table.generated.total).toBe(
      sample.filter((m) => m.mail_type !== undefined).length,
    )
    expect(table.generated.hardNegatives).toBe(
      sample.filter((m) => m.hard_negative).length,
    )
    expect(table.generated.hardNegatives).toBeGreaterThan(0)
    expect(Object.values(table.generated.byMailType).reduce((a, b) => a + b, 0)).toBe(
      table.generated.total,
    )
    expect(Object.keys(table.generated.byStyle).length).toBeGreaterThan(0)
  })
})
