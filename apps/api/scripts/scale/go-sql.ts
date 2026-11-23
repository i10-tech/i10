/**
 * Reads authd's SQL out of its Go source, so the registry measures the exact
 * text authd sends rather than a copy that can drift from it.
 *
 * It understands only what that source uses: raw strings and constant names
 * joined by `+`, both in `const name = ...` declarations (a constant may be built
 * from other constants, like `accountColumns` from `domainRefused`) and as the
 * first argument of `p.pool.Query(ctx, ...)` / `QueryRow` / `Exec`. Anything else
 * throws, which the registry test turns into a failure instead of a silently
 * stale query.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const REPO = join(import.meta.dirname, "..", "..", "..", "..")

export function goSource(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8")
}

/**
 * Reads `raw + name + raw ...` starting at `i`, resolving each name through
 * `lookup`. Returns the text and the index just past the expression.
 */
function readConcat(
  src: string,
  i: number,
  lookup: (id: string) => string | undefined,
  where: string,
): [string, number] {
  let text = ""
  for (;;) {
    while (/\s/.test(src[i]!)) i++
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1)
      text += src.slice(i + 1, end)
      i = end + 1
    } else {
      const id = /^\w+/.exec(src.slice(i))?.[0]
      const value = id === undefined ? undefined : lookup(id)
      if (id === undefined || value === undefined)
        throw new Error(`${where}: cannot read the SQL at "${src.slice(i, i + 30)}"`)
      text += value
      i += id.length
    }
    // `+` may continue on the next line, after the newline.
    let j = i
    while (/\s/.test(src[j]!)) j++
    if (src[j] === "+") {
      i = j + 1
      continue
    }
    return [text, i]
  }
}

/** Every top-level `const name = <raw strings and names joined by +>`. */
function constants(src: string, rel: string): Map<string, string> {
  const starts = new Map<string, number>()
  for (const m of src.matchAll(/^const (\w+) = (?=`|\w)/gm))
    starts.set(m[1]!, m.index! + m[0].length)
  const done = new Map<string, string>()
  const resolving = new Set<string>()
  const resolve = (id: string): string | undefined => {
    if (done.has(id)) return done.get(id)
    const at = starts.get(id)
    if (at === undefined || resolving.has(id)) return undefined
    resolving.add(id)
    try {
      const [text] = readConcat(src, at, resolve, `${rel} const ${id}`)
      done.set(id, text)
      return text
    } catch {
      // A constant that is not SQL text (a number, a duration): not ours to read.
      return undefined
    } finally {
      resolving.delete(id)
    }
  }
  for (const id of starts.keys()) resolve(id)
  return done
}

/** Every SQL text the named method sends, in source order. */
export function goQueries(rel: string, method: string): string[] {
  const src = goSource(rel)
  const consts = constants(src, rel)
  const start = src.search(new RegExp(`^func \\([a-z]+ \\*?\\w+\\) ${method}\\(`, "m"))
  if (start < 0) throw new Error(`${rel}: no method ${method}`)
  const next = src.indexOf("\nfunc ", start + 1)
  const body = src.slice(start, next < 0 ? undefined : next)
  const out: string[] = []
  for (const call of body.matchAll(/\.pool\.(?:Query|QueryRow|Exec)\(ctx,\s*/g)) {
    const [text] = readConcat(
      body,
      call.index! + call[0].length,
      (id) => consts.get(id),
      `${rel} ${method}`,
    )
    out.push(text)
  }
  if (out.length === 0) throw new Error(`${rel} ${method}: no queries found`)
  return out
}

/** One `const name = ...` from a Go file, with the constants it joins resolved. */
export function goConst(rel: string, name: string): string {
  const v = constants(goSource(rel), rel).get(name)
  if (v === undefined) throw new Error(`${rel}: no const ${name}`)
  return v
}
