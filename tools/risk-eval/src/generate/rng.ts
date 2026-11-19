import { sha256Hex } from "../text.js"

/** A small seeded generator (mulberry32). Same seed, same sequence, everywhere. */
export interface Rng {
  /** A float in [0, 1). */
  next(): number
  /** An integer in [0, n). */
  int(n: number): number
  chance(p: number): boolean
}

export function makeRng(seed: string): Rng {
  let state = Number.parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
  }
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[rng.int(items.length)]
  if (item === undefined) throw new Error("pick from an empty list")
  return item
}

/** `count` distinct items, in a seeded order. */
export function pickMany<T>(rng: Rng, items: readonly T[], count: number): T[] {
  const pool = [...items]
  const out: T[] = []
  while (out.length < count && pool.length > 0) {
    const [taken] = pool.splice(rng.int(pool.length), 1)
    if (taken !== undefined) out.push(taken)
  }
  return out
}

/** Random characters from `alphabet`. */
export function randomString(rng: Rng, alphabet: string, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet.charAt(rng.int(alphabet.length))
  return out
}
