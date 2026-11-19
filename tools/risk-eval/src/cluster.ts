import { dedupText } from "./text.js"

/**
 * Near-duplicate clustering with MinHash and LSH banding.
 *
 * Exact duplicates are removed before this runs; what is left is the mail that
 * differs by a name, a number, a link or a signature. Those have to share one
 * side of the split, so they are clustered here and the split assigns whole
 * clusters.
 *
 * Each mail becomes a set of shingles (word 4-grams with digits and links
 * flattened; character 5-grams for text with too few words, such as CJK), a
 * 64-slot MinHash signature, and 16 bands of 4 slots. Two mails sharing a band
 * are compared by signature agreement, which estimates Jaccard similarity; at
 * 0.7 or more they are joined. Union-find makes the relation transitive.
 */

const SLOTS = 64
const BANDS = 16
const ROWS = SLOTS / BANDS
const JOIN_AT = 0.7
const MAX_SHINGLE_SOURCE_CHARS = 20_000

export interface ClusterInput {
  id: string
  subject: string
  text: string
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const COEFFICIENTS: { a: number; b: number }[] = (() => {
  let x = 0x9e3779b9
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0)
  return Array.from({ length: SLOTS }, () => ({ a: next() | 1, b: next() }))
})()

export function shingles(subject: string, text: string): Set<number> {
  const normalised = dedupText(subject, text)
    .slice(0, MAX_SHINGLE_SOURCE_CHARS)
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/\d+/g, "0")
  const words = normalised.match(/[\p{L}\p{N}]+/gu) ?? []
  const out = new Set<number>()
  if (words.length >= 8) {
    for (let i = 0; i + 4 <= words.length; i++)
      out.add(fnv1a(words.slice(i, i + 4).join(" ")))
  } else {
    const compact = normalised.replace(/\s+/g, " ")
    for (let i = 0; i + 5 <= compact.length; i++)
      out.add(fnv1a(compact.slice(i, i + 5)))
  }
  return out
}

export function minhash(set: Set<number>): Uint32Array {
  const signature = new Uint32Array(SLOTS).fill(0xffffffff)
  for (const h of set) {
    for (let i = 0; i < SLOTS; i++) {
      const c = COEFFICIENTS[i]
      if (c === undefined) continue
      const v = (Math.imul(c.a, h) + c.b) >>> 0
      if (v < (signature[i] ?? 0xffffffff)) signature[i] = v
    }
  }
  return signature
}

function agreement(a: Uint32Array, b: Uint32Array): number {
  let same = 0
  for (let i = 0; i < SLOTS; i++) if (a[i] === b[i]) same++
  return same / SLOTS
}

/**
 * Returns, for every input id, the id of its cluster: the smallest id among the
 * cluster's members.
 *
 * ⚠ INPUT IS SORTED BY ID FIRST. Which representative a bucket remembers
 * depends on the order mails are visited, so without the sort the same set of
 * mails could cluster differently depending on how the file happened to be
 * ordered, and the split built on it would not be reproducible.
 */
export function clusterNearDuplicates(input: ClusterInput[]): Map<string, string> {
  const mails = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const parent = mails.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root] ?? root
    while (parent[i] !== root) {
      const next = parent[i] ?? root
      parent[i] = root
      i = next
    }
    return root
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  const signatures = mails.map((m) => {
    const set = shingles(m.subject, m.text)
    return set.size === 0 ? undefined : minhash(set)
  })

  // band key -> one representative mail index per cluster seen in that bucket
  const buckets = new Map<string, number[]>()
  signatures.forEach((signature, index) => {
    if (signature === undefined) return
    for (let band = 0; band < BANDS; band++) {
      const key = `${band}:${Array.from(signature.subarray(band * ROWS, (band + 1) * ROWS)).join(",")}`
      const members = buckets.get(key) ?? []
      const roots = [...new Set(members.map(find))]
      for (const root of roots) {
        const other = signatures[root]
        if (
          other !== undefined &&
          find(root) !== find(index) &&
          agreement(signature, other) >= JOIN_AT
        ) {
          union(root, index)
        }
      }
      buckets.set(key, [...new Set([...roots, find(index)].map(find))])
    }
  })

  const smallest = new Map<number, string>()
  mails.forEach((m, i) => {
    const root = find(i)
    const current = smallest.get(root)
    if (current === undefined || m.id < current) smallest.set(root, m.id)
  })
  return new Map(mails.map((m, i) => [m.id, smallest.get(find(i)) ?? m.id]))
}
