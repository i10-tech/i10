import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  cosine,
  DIMENSIONS,
  embedderFor,
  embedderModelName,
  hashEmbedder,
  minilmEmbedder,
  modelDir,
  wordpieceTokenizer,
} from "../src/content/embed.js"

/**
 * Turning mail into vectors (#170).
 *
 * ⚠ THE MINILM TESTS NEED THE MODEL FILES (`bun scripts/fetch-models.ts`) and
 * skip without them; the image build fetches them, so the image is where they
 * always run. The tokenizer test runs whenever the vocabulary is present,
 * against token ids produced by the reference library (@huggingface/
 * transformers) for the same strings.
 */
const dir = modelDir()
const withModel = dir ? describe : describe.skip

const EM_DASH = String.fromCharCode(0x2014)
const REFERENCE: [string, number[]][] = [
  [
    "Your account has been selected for a reward. Claim it today before it expires.",
    [
      101, 2115, 4070, 2038, 2042, 3479, 2005, 1037, 10377, 1012, 4366, 2009, 2651,
      2077, 2009, 4654, 20781, 2015, 1012, 102,
    ],
  ],
  [
    `Café naïve résumé: URGENT!!! verify-your-password @ http://x.y/z?a=1 ${EM_DASH} 24h`,
    [
      101, 7668, 15743, 13746, 1024, 13661, 999, 999, 999, 20410, 1011, 2115, 1011,
      20786, 1030, 8299, 1024, 1013, 1013, 1060, 1012, 1061, 1013, 1062, 1029, 1037,
      1027, 1015, 1517, 2484, 2232, 102,
    ],
  ],
  ["Thanks for your order.", [101, 4283, 2005, 2115, 2344, 1012, 102]],
]

describe("hash-v1", () => {
  it("makes unit vectors of the stored dimension", async () => {
    const [v] = await hashEmbedder().embed(["hello world, this is a test"])
    expect(v).toHaveLength(DIMENSIONS)
    expect(Math.abs(cosine(v!, v!) - 1)).toBeLessThan(1e-9)
  })

  it("puts the same template with different names close, and different mail far", async () => {
    const e = hashEmbedder()
    const [a, b, c] = await e.embed([
      "Hi Ann, your order 1001 has shipped and will arrive on Tuesday. Track it in your account.",
      "Hi Bob, your order 2002 has shipped and will arrive on Friday. Track it in your account.",
      "Our spring collection is here: jackets, shoes and bags with free shipping this weekend only.",
    ])
    expect(cosine(a!, b!)).toBeGreaterThan(0.75)
    expect(cosine(a!, c!)).toBeLessThan(0.4)
  })

  it("is deterministic", async () => {
    const e = hashEmbedder()
    expect(await e.embed(["same text"])).toEqual(await e.embed(["same text"]))
  })
})

describe("choosing an embedder", () => {
  it("honours hash, and names the model without loading it", async () => {
    expect((await embedderFor("hash")).model).toBe("hash-v1")
    expect(embedderModelName("hash")).toBe("hash-v1")
    expect(embedderModelName("minilm")).toBe(dir ? "minilm-l6-v2-q8" : "hash-v1")
  })

  it("falls back to hash, loudly, when the model cannot be found", async () => {
    const warnings: string[] = []
    const previous = process.env.RISK_MODEL_DIR
    if (!dir) {
      const e = await embedderFor("minilm", { warn: (_o, m) => void warnings.push(m) })
      expect(e.model).toBe("hash-v1")
      expect(warnings.join(" ")).toContain("fall back")
    }
    process.env.RISK_MODEL_DIR = previous
  })
})

withModel("all-MiniLM-L6-v2 on WebAssembly", () => {
  it("tokenises exactly like the reference library", () => {
    const encode = wordpieceTokenizer(readFileSync(join(dir!, "vocab.txt"), "utf8"))
    for (const [text, ids] of REFERENCE) expect(encode(text)).toEqual(ids)
  })

  it("refuses a model file that is not the pinned one", async () => {
    await expect(minilmEmbedder("/nonexistent")).rejects.toThrow()
  })

  it("separates meaning: phishing is close to phishing, far from a receipt", async () => {
    const e = await minilmEmbedder(dir!)
    const [p1, p2, receipt] = await e.embed([
      "Verify your password now or your mailbox will be closed within 24 hours.",
      "Your mailbox storage is full. Confirm your login details immediately to avoid suspension.",
      "Thanks for your order. Your receipt for the annual plan is attached.",
    ])
    expect(p1).toHaveLength(DIMENSIONS)
    expect(cosine(p1!, p2!)).toBeGreaterThan(cosine(p1!, receipt!) + 0.2)
  })
})
