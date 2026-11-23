/**
 * Deterministic randomness for the seed generator: one seed number gives the
 * same database every time (given the same anchor date).
 *
 * ⚠ NEVER `Math.random()` OR `crypto.randomUUID()` IN THE GENERATOR. Either one
 * makes two runs differ, and the determinism test exists to catch exactly that.
 */

/** sfc32: small, fast, and good enough for test data. Not for anything secret. */
export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(seed: number, stream = 0) {
    this.a = 0x9e3779b9 ^ seed
    this.b = 0x243f6a88 ^ stream
    this.c = 0xb7e15162
    this.d = 1
    for (let i = 0; i < 16; i++) this.next()
  }

  /** A uniform float in [0, 1). */
  next(): number {
    this.a |= 0
    this.b |= 0
    this.c |= 0
    this.d |= 0
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return (t >>> 0) / 4294967296
  }

  /** An integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!
  }

  /** Picks by weight: `[["sent", 90], ["failed", 3]]`. */
  weighted<T>(table: readonly (readonly [T, number])[]): T {
    let total = 0
    for (const [, w] of table) total += w
    let r = this.next() * total
    for (const [v, w] of table) {
      r -= w
      if (r < 0) return v
    }
    return table[table.length - 1]![0]
  }

  /** A child stream, so adding draws to one table never shifts another's rows. */
  fork(stream: number): Rng {
    return new Rng(Math.floor(this.next() * 2 ** 31), stream)
  }

  private hex(n: number): string {
    let s = ""
    for (let i = 0; i < n; i++) s += Math.floor(this.next() * 16).toString(16)
    return s
  }

  /** A version 4 shaped id, for tables whose default is `gen_random_uuid()`. */
  uuid4(): string {
    const h = this.hex(32)
    const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
  }

  /**
   * A version 7 shaped id for `at`, for tables whose default is `uuidv7()`, so
   * id order follows time order as it does in production (index correlation).
   */
  uuid7(at: Date): string {
    const ms = at.getTime().toString(16).padStart(12, "0")
    const h = this.hex(20)
    const variant = ((parseInt(h[3]!, 16) & 0x3) | 0x8).toString(16)
    return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${h.slice(0, 3)}-${variant}${h.slice(4, 7)}-${h.slice(7, 19)}`
  }

  /** A lowercase hex token of `bytes` bytes. */
  token(bytes: number): string {
    return this.hex(bytes * 2)
  }
}

/**
 * Zipf-like weights for `n` items: item 0 is the largest, then a long tail.
 * `s` near 1 is the classic shape (one huge tenant, most tiny).
 */
export function zipfWeights(n: number, s: number): number[] {
  const w = new Array<number>(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    w[i] = 1 / Math.pow(i + 1, s)
    total += w[i]!
  }
  for (let i = 0; i < n; i++) w[i] = w[i]! / total
  return w
}

/**
 * Splits `total` items across owners in proportion to `weights` (any scale), at
 * least `min` each, so the counts sum to `total` exactly when `total >= min * n`.
 * Deterministic: no randomness at all.
 */
export function apportion(
  total: number,
  weights: readonly number[],
  min = 0,
): number[] {
  const n = weights.length
  const floorTotal = Math.max(0, total - min * n)
  // Normalised here, so callers can pass flattened weights (`w ** 0.5`) as they are.
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const raw = weights.map((w) => (w / sum) * floorTotal)
  const out = raw.map((r) => Math.floor(r) + min)
  let rest = total - out.reduce((a, b) => a + b, 0)
  // Hand the remainder to the largest fractional parts, ties by index.
  const order = raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((x, y) => y[0] - x[0] || x[1] - y[1])
  for (let k = 0; rest > 0 && n > 0; k = (k + 1) % n, rest--) out[order[k]![1]]! += 1
  return out
}

/** A sampler over an alias table: O(1) draws from a fixed discrete distribution. */
export class Discrete {
  private readonly prob: Float64Array
  private readonly alias: Int32Array

  constructor(weights: readonly number[]) {
    const n = weights.length
    this.prob = new Float64Array(n)
    this.alias = new Int32Array(n)
    const total = weights.reduce((a, b) => a + b, 0)
    const scaled = weights.map((w) => (w * n) / total)
    const small: number[] = []
    const large: number[] = []
    scaled.forEach((p, i) => (p < 1 ? small : large).push(i))
    while (small.length && large.length) {
      const s = small.pop()!
      const l = large.pop()!
      this.prob[s] = scaled[s]!
      this.alias[s] = l
      scaled[l] = scaled[l]! + scaled[s]! - 1
      ;(scaled[l]! < 1 ? small : large).push(l)
    }
    for (const i of [...small, ...large]) this.prob[i] = 1
  }

  draw(rng: Rng): number {
    const i = Math.floor(rng.next() * this.prob.length)
    return rng.next() < this.prob[i]! ? i : this.alias[i]!
  }
}
