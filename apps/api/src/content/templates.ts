/**
 * Discovering templates in a workspace's own mail, and storing bodies as a
 * template plus values (#167, #169, #171).
 *
 * ⚠ ONE CORE, TWO USES. The same skeleton that lets us store a 20 KB receipt
 * once instead of ten thousand times is how the risk engine knows what a
 * workspace's NORMAL mail looks like (#170): a template seen for weeks with
 * clean outcomes is earned trust, and mail matching nothing it has ever sent,
 * arriving in bulk, is a change worth noticing.
 *
 * ⚠ BYTE-EXACT BY CONSTRUCTION, AND CHECKED ANYWAY. A template is a list of
 * static segments; a message is the values that fill the holes between them.
 * Rendering is plain concatenation, so any split of a string into segments and
 * values reconstructs it exactly - and `compactable` still renders and
 * compares before a single byte of the original is released. What we show in
 * logs, what a resend sends and what the customer exported must be what was
 * sent, not something close to it.
 *
 * ⚠ PURE. Nothing here touches a database; content/job.ts does, off the send
 * path, on messages that are already finished.
 */
import { createHash } from "node:crypto"

export interface Template {
  /** Static text, in order. Holes sit between consecutive segments. */
  segments: string[]
}

/** A body as one string: HTML and text joined by a separator neither contains. */
export interface BodyParts {
  html: string | null
  text: string | null
}

const SEP = "\u0001"

export function joinBody({ html, text }: BodyParts): string | null {
  if ((html ?? "").includes(SEP) || (text ?? "").includes(SEP)) return null
  return `${html === null ? "\u0002" : html}${SEP}${text === null ? "\u0002" : text}`
}

export function splitBody(joined: string): BodyParts {
  const i = joined.indexOf(SEP)
  const html = joined.slice(0, i)
  const text = joined.slice(i + 1)
  return {
    html: html === "\u0002" ? null : html,
    text: text === "\u0002" ? null : text,
  }
}

/**
 * Tokens that concatenate back to the input exactly: tags, whitespace runs,
 * words, and single other characters.
 */
export function tokenize(s: string): string[] {
  return s.match(/<[^>]*>|\s+|[\p{L}\p{N}_]+|[^\s<\p{L}\p{N}_]|</gu) ?? []
}

export function render(template: Template, values: readonly string[]): string {
  let out = template.segments[0] ?? ""
  for (let i = 1; i < template.segments.length; i++)
    out += (values[i - 1] ?? "") + template.segments[i]
  return out
}

export const skeletonHash = (t: Template) =>
  createHash("sha256").update(JSON.stringify(t.segments)).digest("hex").slice(0, 32)

export const staticBytes = (t: Template) => t.segments.reduce((n, s) => n + s.length, 0)

/**
 * Fits a message to a template: the values that fill its holes, or null.
 *
 * ⚠ GREEDY AND LEFTMOST, AND THAT IS SAFE. A static segment that also appears
 * inside a value can be matched early, which gives a worse split - never a
 * wrong one, because rendering is concatenation. The result is still checked.
 */
export function match(template: Template, s: string): string[] | null {
  const segs = template.segments
  const first = segs[0] ?? ""
  if (!s.startsWith(first)) return null
  if (segs.length === 1) return s === first ? [] : null
  const values: string[] = []
  let pos = first.length
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!
    const last = i === segs.length - 1
    const at = last ? s.length - seg.length : s.indexOf(seg, pos)
    if (at < pos || (last && !s.endsWith(seg))) return null
    values.push(s.slice(pos, at))
    pos = at + seg.length
  }
  return render(template, values) === s ? values : null
}

/** Segments shorter than this are folded into the holes around them. */
const MIN_SEGMENT = 8
/** Past this many edits two bodies are not one template, and diffing stops. */
const MAX_EDITS = 400
const MAX_HOLES = 64

/**
 * The template two bodies share, from a token-level diff (Myers, O((N+M)D)).
 *
 * ⚠ NULL WHEN THEY ARE NOT ONE TEMPLATE: too many edits, too many holes, or
 * too little in common. A template that is mostly holes stores nothing and
 * explains nothing.
 */
export function derive(a: string, b: string, minStaticShare = 0.6): Template | null {
  if (a === b) return { segments: [a] }
  const x = tokenize(a)
  const y = tokenize(b)
  const common = lcsRuns(x, y)
  if (!common) return null

  // Common runs become segments; everything between them is a hole. A gap
  // before a run (on either side) closes the current segment and opens a hole.
  const segments: string[] = []
  let current = ""
  let atX = 0
  let atY = 0
  for (const run of common) {
    const text = x.slice(run.x, run.x + run.len).join("")
    if (run.x > atX || run.y > atY) {
      segments.push(current)
      current = text
    } else {
      current += text
    }
    atX = run.x + run.len
    atY = run.y + run.len
  }
  if (atX < x.length || atY < y.length) {
    segments.push(current)
    current = ""
  }
  segments.push(current)

  const folded = fold(segments)
  const template = { segments: folded }
  if (folded.length - 1 > MAX_HOLES) return null
  if (staticBytes(template) < Math.max(a.length, b.length) * minStaticShare) return null
  if (!match(template, a) || !match(template, b)) return null
  return template
}

/** Merges tiny static segments into the holes on either side. */
function fold(segments: string[]): string[] {
  if (segments.length <= 2) return segments
  const out = [segments[0]!]
  for (let i = 1; i < segments.length - 1; i++) {
    if (segments[i]!.length < MIN_SEGMENT) continue
    out.push(segments[i]!)
  }
  out.push(segments[segments.length - 1]!)
  return out
}

interface Run {
  x: number
  y: number
  len: number
}

/** The longest common subsequence of two token lists, as runs, or null past MAX_EDITS. */
function lcsRuns(a: string[], b: string[]): Run[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let xx =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let yy = xx - k
      while (xx < n && yy < m && a[xx] === b[yy]) {
        xx++
        yy++
      }
      v[offset + k] = xx
      if (xx >= n && yy >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null

  // Walk the trace back to collect the diagonal (common) stretches.
  const runs: Run[] = []
  let xx = n
  let yy = m
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!
    const k = xx - yy
    const prevK =
      k === -d || (k !== d && vv[offset + k - 1]! < vv[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = vv[offset + prevK]!
    const prevY = prevX - prevK
    const startX = prevK === k + 1 ? prevX : prevX + 1
    const startY = startX - k
    if (xx > startX) runs.push({ x: startX, y: startY, len: xx - startX })
    xx = prevX
    yy = prevY
  }
  if (xx > 0) runs.push({ x: 0, y: 0, len: xx })
  return runs.reverse()
}

/**
 * Whether a body can be stored as this template, and with which values.
 *
 * ⚠ THE LAST GATE BEFORE THE ORIGINAL IS RELEASED. It renders the candidate
 * and compares it with the original, byte for byte, and says no to anything
 * that is not identical. `content/job.ts` never nulls a body without a yes.
 */
export function compactable(template: Template, parts: BodyParts): string[] | null {
  const joined = joinBody(parts)
  if (joined === null) return null
  const values = match(template, joined)
  if (!values) return null
  const back = splitBody(render(template, values))
  return back.html === parts.html && back.text === parts.text ? values : null
}

/** A body rebuilt from a template and its values. */
export function restore(template: Template, values: readonly string[]): BodyParts {
  return splitBody(render(template, values))
}
