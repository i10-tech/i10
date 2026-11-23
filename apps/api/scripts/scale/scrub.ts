/**
 * Scrubs a `pg_dump --statistics-only` dump so it carries no real value.
 *
 * Planner statistics hold real data: `most_common_vals` and `histogram_bounds`
 * of `authd.accounts.email` are email addresses, of `core.domains.name` customer
 * domains. This replaces every such value with a generated one and keeps what the
 * planner reads: the number of entries, every frequency, `null_frac`,
 * `n_distinct`, `avg_width`, `correlation`, the sort order of histograms, and
 * each value's byte length.
 *
 * ⚠ ONE MAPPING FOR THE WHOLE DUMP, BY RANK. All original values of a kind
 * (text-like, uuid) are collected from every column, sorted, and value i of N
 * becomes generated value i of N. So a histogram stays sorted, and the same
 * tenant id in `core.messages` and in `core.api_keys` stays the same (scrubbed)
 * id, which keeps join estimates honest. The mapping lives in memory only; the
 * round trip uses it to translate its query parameters and then drops it.
 *
 * What is kept as it is: numbers, timestamps, booleans, intervals and enum
 * labels (labels are schema, not data). What is dropped instead of generated
 * (the planner falls back to its defaults for that column): any value list of
 * another type, such as jsonb, inet, bytea, ranges or pgvector, because a
 * generated value of those types would have to be valid and ordered and there is
 * no need yet.
 */

export type Kind = "keep" | "text" | "uuid" | "drop"

/** How to treat each column's values, from the source database's catalog. */
export type ColumnKinds = ReadonlyMap<string, { kind: Kind; array: boolean }>

export const columnKey = (schema: string, rel: string, att: string) =>
  `${schema}.${rel}.${att}`

const VALUE_KEYS = [
  "most_common_vals",
  "histogram_bounds",
  "most_common_elems",
  "range_bounds_histogram",
] as const

// --- SQL literals and array literals -------------------------------------------

interface Arg {
  key: string
  value: string
  cast: string | null
}

/** Reads `'key', 'value'::type, ...` up to the closing parenthesis. */
function parseArgs(src: string, start: number): { args: Arg[]; end: number } {
  let i = start
  const literal = (): string => {
    while (/\s/.test(src[i]!)) i++
    if (src[i] !== "'")
      throw new Error(`expected a string literal at ${i}: ${src.slice(i, i + 40)}`)
    let out = ""
    for (i++; ; i++) {
      if (src[i] === "'") {
        if (src[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        i++
        return out
      }
      out += src[i]
    }
  }
  const args: Arg[] = []
  for (;;) {
    while (/\s/.test(src[i]!)) i++
    if (src[i] === ")") return { args, end: i + 1 }
    const key = literal()
    while (/\s/.test(src[i]!)) i++
    if (src[i] !== ",") throw new Error(`expected a comma after '${key}'`)
    i++
    const value = literal()
    let cast: string | null = null
    if (src.startsWith("::", i)) {
      const m = /^::([\w." [\]]+?)(?=\s*[,)])/.exec(src.slice(i))
      if (!m) throw new Error(`cannot read the cast after '${key}'`)
      cast = m[1]!
      i += m[0].length
    }
    args.push({ key, value, cast })
    while (/\s/.test(src[i]!)) i++
    if (src[i] === ",") i++
  }
}

const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Parses a one-dimensional Postgres array literal: `{a,"b c",NULL}`. */
export function parseArray(text: string): (string | null)[] {
  if (!text.startsWith("{") || !text.endsWith("}"))
    throw new Error(`not an array literal: ${text.slice(0, 40)}`)
  const out: (string | null)[] = []
  let i = 1
  if (text[i] === "}") return out
  for (;;) {
    let v = ""
    let quoted = false
    if (text[i] === '"') {
      quoted = true
      for (i++; text[i] !== '"'; i++) {
        if (text[i] === "\\") i++
        v += text[i]
      }
      i++
    } else {
      for (; text[i] !== "," && text[i] !== "}"; i++) v += text[i]
    }
    out.push(!quoted && v === "NULL" ? null : v)
    if (text[i] === "}") return out
    i++
  }
}

export function formatArray(items: readonly (string | null)[]): string {
  return `{${items
    .map((v) =>
      v === null
        ? "NULL"
        : v === "" || /[{},"\\\s]/.test(v) || v.toUpperCase() === "NULL"
          ? `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`
          : v,
    )
    .join(",")}}`
}

// --- the mapping ----------------------------------------------------------------

const bytes = (s: string) => Buffer.byteLength(s, "utf8")
const compareBytes = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))

/** Rank i of n as a fixed-width lowercase prefix, so byte order follows rank. */
function rankPrefix(i: number, width: number): string {
  let s = ""
  for (let k = 0; k < width; k++) {
    s = String.fromCharCode(97 + (i % 26)) + s
    i = Math.floor(i / 26)
  }
  return s
}

export interface Mapping {
  text: Map<string, string>
  uuid: Map<string, string>
}

function buildMapping(text: Set<string>, uuid: Set<string>): Mapping {
  const texts = [...text].sort(compareBytes)
  const width = Math.max(1, Math.ceil(Math.log(texts.length + 1) / Math.log(26)))
  const t = new Map<string, string>()
  texts.forEach((v, i) => {
    const prefix = rankPrefix(i, width)
    // Same byte length as the original wherever the rank fits in it.
    t.set(v, prefix + "x".repeat(Math.max(0, bytes(v) - prefix.length)))
  })
  const uuids = [...uuid].sort()
  const u = new Map<string, string>()
  uuids.forEach((v, i) => {
    // Spread evenly over the id space, in the original order.
    const hi = BigInt(Math.floor(((i + 0.5) / uuids.length) * 2 ** 52)) << 12n
    const hex = (hi | BigInt(i & 0xfff)).toString(16).padStart(16, "0")
    const lo = i.toString(16).padStart(16, "0")
    u.set(
      v,
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${lo.slice(0, 4)}-${lo.slice(4, 16)}`,
    )
  })
  return { text: t, uuid: u }
}

// --- the scrub ------------------------------------------------------------------

interface Call {
  start: number
  end: number
  args: Arg[]
  column: string | null
}

const CALL = "pg_catalog.pg_restore_attribute_stats("

function calls(
  dump: string,
  attnames: (schema: string, rel: string, attnum: number) => string | undefined,
): Call[] {
  const out: Call[] = []
  for (let at = dump.indexOf(CALL); at >= 0; at = dump.indexOf(CALL, at + 1)) {
    const { args, end } = parseArgs(dump, at + CALL.length)
    const get = (k: string) => args.find((a) => a.key === k)?.value
    const schema = get("schemaname")!
    const rel = get("relname")!
    const att =
      get("attname") ??
      (get("attnum") ? attnames(schema, rel, Number(get("attnum"))) : undefined)
    out.push({ start: at, end, args, column: att ? columnKey(schema, rel, att) : null })
  }
  return out
}

export interface ScrubResult {
  sql: string
  mapping: Mapping
  /** Columns whose value lists were dropped, with their kind. */
  dropped: string[]
  scrubbed: string[]
  /** Every original value that was replaced, for the leak test. */
  originals: string[]
}

export function scrub(
  dump: string,
  kinds: ColumnKinds,
  attnames: (schema: string, rel: string, attnum: number) => string | undefined = () =>
    undefined,
): ScrubResult {
  const found = calls(dump, attnames)
  const text = new Set<string>()
  const uuid = new Set<string>()
  const kindOf = (c: Call) =>
    (c.column ? kinds.get(c.column) : undefined) ?? {
      kind: "drop" as Kind,
      array: false,
    }
  for (const c of found) {
    const k = kindOf(c)
    if (k.kind !== "text" && k.kind !== "uuid") continue
    for (const a of c.args) {
      if (!VALUE_KEYS.includes(a.key as (typeof VALUE_KEYS)[number])) continue
      for (const v of parseArray(a.value))
        if (v !== null) (k.kind === "text" ? text : uuid).add(v)
    }
  }
  const mapping = buildMapping(text, uuid)
  const dropped = new Set<string>()
  const scrubbed = new Set<string>()
  let sql = ""
  let last = 0
  for (const c of found) {
    const k = kindOf(c)
    const hasValues = c.args.some((a) =>
      VALUE_KEYS.includes(a.key as (typeof VALUE_KEYS)[number]),
    )
    if (k.kind === "keep" || !hasValues) continue
    const args: Arg[] = []
    for (const a of c.args) {
      const isValue = VALUE_KEYS.includes(a.key as (typeof VALUE_KEYS)[number])
      if (!isValue) {
        // A value list dropped takes its frequencies with it: they describe it.
        if (
          k.kind === "drop" &&
          [
            "most_common_freqs",
            "most_common_elem_freqs",
            "elem_count_histogram",
            "range_length_histogram",
            "range_empty_frac",
          ].includes(a.key)
        )
          continue
        args.push(a)
        continue
      }
      if (k.kind === "drop") continue
      const map = k.kind === "text" ? mapping.text : mapping.uuid
      args.push({
        ...a,
        value: formatArray(
          parseArray(a.value).map((v) => (v === null ? null : map.get(v)!)),
        ),
      })
    }
    ;(k.kind === "drop" ? dropped : scrubbed).add(c.column ?? "(unknown column)")
    sql +=
      dump.slice(last, c.start) +
      CALL +
      "\n" +
      args
        .map(
          (a) =>
            `\t${quoteLiteral(a.key)}, ${quoteLiteral(a.value)}${a.cast ? `::${a.cast}` : ""}`,
        )
        .join(",\n") +
      "\n)"
    last = c.end
  }
  sql += dump.slice(last)
  return {
    sql,
    mapping,
    dropped: [...dropped].sort(),
    scrubbed: [...scrubbed].sort(),
    originals: [...text, ...uuid],
  }
}

/**
 * The originals that survive in any value list of the scrubbed SQL, whole or as
 * a substring of a longer value; empty means nothing leaked. Value lists only:
 * an original `active` must not count as a leak because a column is named that.
 */
export function leaks(
  result: ScrubResult,
  kinds: ColumnKinds,
  minSubstring = 6,
): string[] {
  const originals = new Set(result.originals)
  const long = result.originals.filter((v) => v.length >= minSubstring)
  const out = new Set<string>()
  for (const c of calls(result.sql, () => undefined)) {
    const k = c.column ? kinds.get(c.column) : undefined
    if (k?.kind === "keep") continue
    for (const a of c.args) {
      if (!VALUE_KEYS.includes(a.key as (typeof VALUE_KEYS)[number])) continue
      for (const v of parseArray(a.value)) {
        if (v === null) continue
        if (originals.has(v)) out.add(v)
        for (const o of long) if (v.includes(o)) out.add(o)
      }
    }
  }
  return [...out]
}

/** Postgres type facts to `Kind`: what the scrubber may keep, must generate, or drops. */
export function kindFor(
  category: string,
  typname: string,
  elemCategory: string | null,
  elemName: string | null,
): { kind: Kind; array: boolean } {
  const base = (cat: string, name: string): Kind => {
    if (["N", "D", "B", "E", "T"].includes(cat) && name !== "money") return "keep"
    if (cat === "S") return "text"
    if (name === "uuid") return "uuid"
    return "drop"
  }
  if (category === "A" && elemCategory && elemName)
    return { kind: base(elemCategory, elemName), array: true }
  return { kind: base(category, typname), array: false }
}
