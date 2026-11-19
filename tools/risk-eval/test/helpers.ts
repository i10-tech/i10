import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Hex } from "../src/text.js"
import type { DatasetDef } from "../src/registry.js"
import type { Label, Mail } from "../src/schema.js"

/** A scratch directory under the OS temp dir, never inside the repository. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "risk-eval-test-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function dataset(
  id: string,
  files: string[],
  extra: Partial<DatasetDef> = {},
): DatasetDef {
  return {
    id,
    title: id,
    synthetic: false,
    terms: {
      verdict: "internal-eval",
      source: "test",
      quote: "test",
      checked: "2026-01-01",
    },
    files: files.map((name) => ({ name, url: `https://example.invalid/${name}` })),
    ...extra,
  }
}

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) out.push(item)
  return out
}

let counter = 0

export function mail(overrides: Partial<Mail> = {}): Mail {
  const n = counter++
  return {
    id: `t:${String(n).padStart(6, "0")}`,
    dataset: "t",
    label: "legit" as Label,
    subject: `subject ${n}`,
    text: `plain body number ${n} with enough words to count as a real message`,
    lang: "en",
    synthetic: false,
    ...overrides,
  }
}

/** Pseudo-random words, so two mails built from different seeds share no shingles. */
export function distinctText(seed: string, words = 40): string {
  const out: string[] = []
  for (let i = 0; out.length < words; i++) {
    out.push(
      ...sha256Hex(`${seed}:${i}`)
        .match(/.{1,5}/g)!
        .slice(0, 6),
    )
  }
  return out.slice(0, words).join(" ")
}
