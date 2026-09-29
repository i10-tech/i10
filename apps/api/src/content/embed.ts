import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

/**
 * Turning mail into vectors (#170), so similar mail sits close together in
 * pgvector and "is this like mail a confirmed abuser sent?" is a distance.
 *
 * ⚠ LOCAL, IN-PROCESS, AND WEBASSEMBLY. The model is all-MiniLM-L6-v2
 * (Apache-2.0, 384 dimensions, 23 MB quantised), run by onnxruntime-web's WASM
 * backend. Measured before choosing:
 *   - `@huggingface/transformers` in Node only offers NATIVE onnxruntime, whose
 *     binaries are glibc - and our runtime image is Alpine (musl). WASM runs
 *     anywhere Bun does, and was proven on oven/bun:1.4.2-alpine, amd64.
 *   - About 80 ms per 120-word email on one thread, ~310 MB resident, 0.2 s to
 *     load. That is the hourly job's budget, never the send path's.
 *   - Its tokenizer is BERT's WordPiece, implemented below; token ids were
 *     checked identical to the reference library's, embeddings at cosine 0.98+.
 *   - It separates meaning: two different phishing emails scored 0.63 against
 *     each other and 0.19 against a receipt.
 * Mail never leaves the process to be embedded - no third party sees it.
 *
 * ⚠ AND A ZERO-DEPENDENCY FALLBACK. `hash-v1` is feature hashing over words,
 * word pairs and character trigrams: it knows wording, not meaning, and runs
 * everywhere including tests. Vectors are tagged with the model that made
 * them and are only ever compared with vectors from the same model.
 */
export const DIMENSIONS = 384

export interface Embedder {
  /** Stored beside every vector; vectors of different models are never compared. */
  readonly model: string
  embed(texts: readonly string[]): Promise<number[][]>
}

// ─── hash-v1: wording, everywhere ────────────────────────────────────────────

function fnv(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function hashEmbedder(): Embedder {
  return {
    model: "hash-v1",
    async embed(texts) {
      return texts.map((text) => {
        const v = new Float64Array(DIMENSIONS)
        const words = text
          .toLowerCase()
          .normalize("NFKC")
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean)
        const add = (feature: string, weight: number) => {
          const h = fnv(feature, 0x811c9dc5)
          v[h % DIMENSIONS]! += (fnv(feature, 0x9e3779b9) & 1 ? 1 : -1) * weight
        }
        for (let i = 0; i < words.length; i++) {
          add(`w:${words[i]}`, 1)
          if (i + 1 < words.length) add(`b:${words[i]} ${words[i + 1]}`, 0.7)
          const w = ` ${words[i]} `
          for (let j = 0; j + 3 <= w.length; j++) add(`c:${w.slice(j, j + 3)}`, 0.3)
        }
        const norm = Math.hypot(...v) || 1
        return Array.from(v, (x) => x / norm)
      })
    },
  }
}

// ─── minilm: meaning, locally ────────────────────────────────────────────────

/** Pinned: Xenova/all-MiniLM-L6-v2 at this commit, checked by SHA-256. */
export const MINILM = {
  model: "minilm-l6-v2-q8",
  repo: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  files: {
    "model.onnx": {
      path: "onnx/model_quantized.onnx",
      sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    },
    "vocab.txt": {
      path: "vocab.txt",
      sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    },
  },
} as const

const MAX_TOKENS = 256

/**
 * BERT's uncased WordPiece, as all-MiniLM-L6-v2 was trained with it:
 * lowercase, strip accents, split on whitespace and punctuation, then greedy
 * longest-match against the vocabulary with `##` continuations.
 */
export function wordpieceTokenizer(vocabText: string) {
  const vocab = new Map(vocabText.split("\n").map((t, i) => [t, i] as const))
  const id = (t: string) => vocab.get(t)
  const unk = id("[UNK]")!
  const cls = id("[CLS]")!
  const sep = id("[SEP]")!
  const piece = (word: string): number[] => {
    if (word.length > 100) return [unk]
    const out: number[] = []
    let start = 0
    while (start < word.length) {
      let end = word.length
      let found: number | undefined
      while (start < end) {
        found = id((start > 0 ? "##" : "") + word.slice(start, end))
        if (found !== undefined) break
        end--
      }
      if (found === undefined) return [unk]
      out.push(found)
      start = end
    }
    return out
  }
  return (text: string): number[] => {
    const basic = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/\s+/)
      .flatMap((w) => w.split(/([\p{P}\p{S}])/u))
      .filter(Boolean)
    return [cls, ...basic.flatMap(piece).slice(0, MAX_TOKENS - 2), sep]
  }
}

/** Where the model files are: the image's, then a dev checkout's. */
export function modelDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.RISK_MODEL_DIR,
    join(here, "models", "minilm"),
    join(here, "..", "..", "models", "minilm"),
  ].filter(Boolean) as string[]
  return (
    candidates.find(
      (d) => existsSync(join(d, "model.onnx")) && existsSync(join(d, "vocab.txt")),
    ) ?? null
  )
}

export async function minilmEmbedder(dir: string): Promise<Embedder> {
  const ort = await import("onnxruntime-web")
  ort.env.wasm.numThreads = 1
  // ⚠ IN THE IMAGE THE WASM RUNTIME IS COPIED BESIDE THE BUNDLE (dist/ort),
  // because `bun build` does not carry it - the same trap as groupmq's Lua.
  // Unbundled (dev, tests) the package finds its own files.
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, "ort")
  if (existsSync(join(bundled, "ort-wasm-simd-threaded.wasm"))) {
    ort.env.wasm.wasmPaths = `${new URL(`file://${bundled}/`).href}`
  }
  const [model, vocab] = await Promise.all([
    readFile(join(dir, "model.onnx")),
    readFile(join(dir, "vocab.txt"), "utf8"),
  ])
  const digest = createHash("sha256").update(model).digest("hex")
  if (digest !== MINILM.files["model.onnx"].sha256) {
    throw new Error(`model.onnx in ${dir} is not the pinned file (sha256 ${digest})`)
  }
  const encode = wordpieceTokenizer(vocab)
  const session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ["wasm"],
  })
  return {
    model: MINILM.model,
    async embed(texts) {
      const out: number[][] = []
      for (const text of texts) {
        const ids = encode(text)
        const n = ids.length
        const feeds = {
          input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [
            1,
            n,
          ]),
          attention_mask: new ort.Tensor(
            "int64",
            BigInt64Array.from(ids.map(() => 1n)),
            [1, n],
          ),
          token_type_ids: new ort.Tensor("int64", new BigInt64Array(n), [1, n]),
        }
        const result = await session.run(feeds)
        const hidden = result.last_hidden_state!.data as Float32Array
        const v = new Float64Array(DIMENSIONS)
        for (let t = 0; t < n; t++) {
          for (let j = 0; j < DIMENSIONS; j++) v[j]! += hidden[t * DIMENSIONS + j]! / n
        }
        const norm = Math.hypot(...v) || 1
        out.push(Array.from(v, (x) => x / norm))
      }
      return out
    },
  }
}

/**
 * The embedder a process should use: `RISK_EMBEDDER` (`minilm` by default,
 * or `hash`), falling back to `hash` - loudly - when the model files are
 * missing, so a broken image degrades to wording similarity rather than to
 * none.
 */
export async function embedderFor(
  choice: string | undefined,
  log?: { warn?: (o: object, m: string) => void },
): Promise<Embedder> {
  if ((choice ?? "minilm") === "hash") return hashEmbedder()
  const dir = modelDir()
  if (!dir) {
    log?.warn?.(
      {},
      "MiniLM model files not found; content vectors fall back to hash-v1",
    )
    return hashEmbedder()
  }
  try {
    return await minilmEmbedder(dir)
  } catch (error) {
    log?.warn?.(
      { err: error },
      "MiniLM failed to load; content vectors fall back to hash-v1",
    )
    return hashEmbedder()
  }
}

export const cosine = (a: readonly number[], b: readonly number[]) =>
  a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)

/**
 * The model name vectors WOULD be tagged with, without loading anything.
 *
 * ⚠ FOR PROCESSES THAT ONLY QUERY. The API compares stored vectors (it needs
 * the name) but never embeds (it must not carry 300 MB of model); only the
 * hourly job loads the embedder itself.
 */
export function embedderModelName(choice: string | undefined): string {
  return (choice ?? "minilm") === "minilm" && modelDir() ? MINILM.model : "hash-v1"
}
