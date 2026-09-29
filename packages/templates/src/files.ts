/**
 * Templates as sets of files (#234).
 *
 * ⚠ A TEMPLATE IS AN ENTRY FILE AND EVERYTHING IT IMPORTS BY RELATIVE PATH.
 * Real template folders share a layout, a footer, a button; a renderer that
 * takes one file makes every author paste those into every template. So an
 * upload, and a connected repository (#235), is a set of files, and each
 * template in it is its entry plus the closure of its relative imports. That
 * closure is what is rendered, what is stored on the version, and what is
 * hashed to tell whether anything changed.
 *
 * ⚠ PURE, LIKE THE REST OF THIS PACKAGE. The API uses it to find templates and
 * snapshot their files; the sandbox Worker uses it to wire the files together.
 * Neither may disagree about what `./layout` means, so both call this.
 *
 * ⚠ THE IMPORT SCAN IS LEXICAL, NOT A PARSER. It strips comments, then matches
 * `import … from`, `export … from`, `import(…)` and `require(…)` with string
 * literal specifiers. What it gets wrong fails closed: a specifier it misses
 * is not in the sandbox's link table, and the sandbox refuses it by name.
 */

/** A set of files: a path relative to the set's root, to the file's text. */
export type FileSet = Record<string, string>

/** Files that are code, in the order an extensionless import tries them. */
export const CODE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const

/** The file that may list a set's templates explicitly. */
export const MANIFEST = "i10.json"

/** Per template: its entry and everything it imports. */
export const MAX_TEMPLATE_FILES = 64
export const MAX_TEMPLATE_BYTES = 512 * 1024

/** Per upload, or per repository directory. */
export const MAX_SET_FILES = 500
export const MAX_SET_BYTES = 4 * 1024 * 1024

/**
 * A path in canonical form, or null when it is not one we accept.
 *
 * ⚠ `..` THAT LEAVES THE ROOT IS REFUSED, NOT CLAMPED. Nothing reads the file
 * system with these paths, but the set's root is the only place an import may
 * resolve, and a path naming somewhere outside it is a mistake worth saying.
 */
export function normalizePath(path: string): string | null {
  if (path.length === 0 || path.length > 512 || path.includes("\0")) return null
  const out: string[] = []
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0) return null
      out.pop()
    } else out.push(part)
  }
  return out.length > 0 ? out.join("/") : null
}

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext))
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/**
 * The source with its comments blanked.
 *
 * ⚠ STRINGS ARE WALKED SO THAT `"//"` IN ONE IS NOT A COMMENT. Regular
 * expression literals are not recognised; a `//` inside one blanks the rest of
 * its line, which can only hide an import on that same line.
 */
export function stripComments(source: string): string {
  let out = ""
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      const stop = end === -1 ? source.length : end + 2
      // Newlines kept, so a match's position still means something.
      out += source.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") j++
        else if (c !== "`" && source[j] === "\n") break
        j++
      }
      out += source.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

const IMPORT_PATTERNS = [
  // import x from "y", import { a } from 'y', import type X from "y", import "y"
  /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g,
  // export * from "y", export { a } from "y", export * as n from "y"
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g,
  // import("y"), require("y")
  /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
]

/** Every module specifier the source names statically, deduplicated, in order. */
export function importsOf(source: string): string[] {
  const code = stripComments(source)
  const found: { at: number; spec: string }[] = []
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of code.matchAll(pattern)) found.push({ at: m.index, spec: m[1]! })
  }
  found.sort((a, b) => a.at - b.at)
  return [...new Set(found.map((f) => f.spec))]
}

export function isRelative(spec: string): boolean {
  return (
    spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === ".."
  )
}

/**
 * The file a relative specifier names from `from`, or null.
 *
 * Tried in order: the path as written when it is a code file, the path with
 * each code extension, then `index` with each. A `.js` specifier also tries
 * `.tsx`/`.ts`, which is how TypeScript's NodeNext imports are written.
 */
export function resolveImport(
  from: string,
  spec: string,
  files: FileSet,
): string | null {
  const joined = normalizePath(`${dirname(from)}/${spec}`)
  if (joined === null) return null
  const candidates: string[] = []
  if (isCodeFile(joined)) {
    candidates.push(joined)
    if (joined.endsWith(".js") || joined.endsWith(".jsx")) {
      const stem = joined.slice(0, joined.lastIndexOf("."))
      candidates.push(`${stem}.tsx`, `${stem}.ts`)
    }
  }
  for (const ext of CODE_EXTENSIONS) candidates.push(`${joined}${ext}`)
  for (const ext of CODE_EXTENSIONS) candidates.push(`${joined}/index${ext}`)
  return candidates.find((c) => Object.hasOwn(files, c)) ?? null
}

export interface Closure {
  /** The entry first, then every file it reaches, sorted. */
  paths: string[]
  /** For each file in the closure: relative specifier to the path it names. */
  links: Record<string, Record<string, string>>
  /** Each a sentence for the author. */
  problems: string[]
}

/** The entry and every file it imports by relative path, transitively. */
export function closureOf(entry: string, files: FileSet): Closure {
  const problems: string[] = []
  const links: Record<string, Record<string, string>> = {}
  if (!Object.hasOwn(files, entry)) {
    return { paths: [], links, problems: [`\`${entry}\` is not in the files.`] }
  }
  const seen = new Set<string>([entry])
  const queue = [entry]
  let bytes = 0
  while (queue.length > 0) {
    const path = queue.shift()!
    const source = files[path]!
    bytes += utf8Length(source)
    const own: Record<string, string> = {}
    for (const spec of importsOf(source)) {
      if (!isRelative(spec)) continue
      const target = resolveImport(path, spec, files)
      if (target === null) {
        problems.push(`\`${spec}\`, imported by \`${path}\`, is not in the files.`)
        continue
      }
      own[spec] = target
      if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
    links[path] = own
  }
  if (seen.size > MAX_TEMPLATE_FILES) {
    problems.push(
      `A template may use at most ${MAX_TEMPLATE_FILES} files; \`${entry}\` uses ${seen.size}.`,
    )
  }
  if (bytes > MAX_TEMPLATE_BYTES) {
    problems.push(
      `A template and the files it imports may be at most ${MAX_TEMPLATE_BYTES / 1024} KiB.`,
    )
  }
  const rest = [...seen].filter((p) => p !== entry).sort()
  return { paths: [entry, ...rest], links, problems }
}

/** The subset of `files` named by `paths`. */
export function pick(files: FileSet, paths: readonly string[]): FileSet {
  const out: FileSet = {}
  for (const p of paths) if (Object.hasOwn(files, p)) out[p] = files[p]!
  return out
}

/**
 * One string that is the same for the same template and different otherwise.
 * Callers hash it with whatever their runtime has; this package has no crypto.
 *
 * ⚠ THE ENTRY IS PART OF IT. The same two files with the other one as the
 * entry are a different template.
 */
export function canonicalFileSet(entry: string, files: FileSet): string {
  const pairs = Object.keys(files)
    .sort()
    .map((p) => [p, files[p]!])
  return JSON.stringify([entry, pairs])
}

export interface Discovered {
  /** The entry's path. */
  path: string
  /** The file's stem: what a send names it by. */
  name: string
  /** Its directory under the set's root, or null at the root. */
  folder: string | null
}

export interface Discovery {
  templates: Discovered[]
  /** About the set as a whole: the manifest, clashing names. */
  problems: string[]
}

/**
 * The templates in a set of files.
 *
 * With an `i10.json` at the root, exactly the paths its `templates` lists.
 * Otherwise every `.tsx`/`.jsx` file that has a default export and sets
 * `PreviewProps`, outside folders named `node_modules` or starting with `_` or
 * `.`: React Email's own convention, so a folder that works with `email dev`
 * works here.
 *
 * ⚠ TWO TEMPLATES WITH ONE NAME ARE BOTH REFUSED. A send names a template by
 * its stem, so `auth/welcome.tsx` and `marketing/welcome.tsx` would be one
 * name for two emails, and picking either would be a guess.
 */
export function discoverTemplates(files: FileSet): Discovery {
  const problems: string[] = []
  let paths: string[]

  if (Object.hasOwn(files, MANIFEST)) {
    const listed = manifestTemplates(files[MANIFEST]!)
    if (!listed.ok) return { templates: [], problems: [listed.error] }
    paths = []
    for (const raw of listed.templates) {
      const p = normalizePath(raw)
      if (p === null || !Object.hasOwn(files, p)) {
        problems.push(`\`${raw}\`, listed in ${MANIFEST}, is not in the files.`)
      } else if (!isCodeFile(p)) {
        problems.push(`\`${raw}\`, listed in ${MANIFEST}, is not a .tsx or .jsx file.`)
      } else paths.push(p)
    }
  } else {
    paths = Object.keys(files).filter(
      (p) =>
        (p.endsWith(".tsx") || p.endsWith(".jsx")) &&
        !p
          .split("/")
          .slice(0, -1)
          .some(
            (d) => d === "node_modules" || d.startsWith("_") || d.startsWith("."),
          ) &&
        looksLikeTemplate(files[p]!),
    )
  }

  const byName = new Map<string, Discovered[]>()
  for (const path of [...new Set(paths)].sort()) {
    const file = basename(path)
    const name = file.slice(0, file.lastIndexOf("."))
    const dir = dirname(path)
    const found = { path, name, folder: dir === "" ? null : dir }
    byName.set(name, [...(byName.get(name) ?? []), found])
  }

  const templates: Discovered[] = []
  for (const [name, found] of byName) {
    if (found.length === 1) templates.push(found[0]!)
    else {
      problems.push(
        `${found.map((f) => `\`${f.path}\``).join(" and ")} would both be named ` +
          `\`${name}\`. Rename one: a send names a template by its file name.`,
      )
    }
  }
  return { templates, problems }
}

function looksLikeTemplate(source: string): boolean {
  const code = stripComments(source)
  return /\bexport\s+default\b/.test(code) && /\.PreviewProps\s*=/.test(code)
}

function manifestTemplates(
  text: string,
): { ok: true; templates: string[] } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: `${MANIFEST} is not valid JSON.` }
  }
  const list =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { templates?: unknown }).templates
      : undefined
  if (!Array.isArray(list) || !list.every((t) => typeof t === "string")) {
    return {
      ok: false,
      error: `${MANIFEST} must be an object whose \`templates\` is a list of paths.`,
    }
  }
  return { ok: true, templates: list }
}

/**
 * A set as it arrives from outside, checked and put in canonical form: paths
 * normalized, only code files and the manifest kept, and the set's limits
 * applied. Anything else in the input is ignored, so a whole folder can be
 * dropped in with its images and README.
 */
export function readFileSet(
  input: unknown,
): { ok: true; files: FileSet } | { ok: false; problems: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, problems: ["`files` must be an object of path to file text."] }
  }
  const files: FileSet = {}
  const problems: string[] = []
  let count = 0
  let bytes = 0
  for (const [raw, content] of Object.entries(input)) {
    if (typeof content !== "string") {
      problems.push(`\`${raw}\` must be text.`)
      continue
    }
    const path = normalizePath(raw)
    if (path === null) {
      if (isCodeFile(raw)) problems.push(`\`${raw}\` is not a path inside the upload.`)
      continue
    }
    if (!isCodeFile(path) && path !== MANIFEST) continue
    count++
    bytes += utf8Length(content)
    files[path] = content
  }
  if (count > MAX_SET_FILES) {
    problems.push(`At most ${MAX_SET_FILES} code files at once; this has ${count}.`)
  }
  if (bytes > MAX_SET_BYTES) {
    problems.push(`At most ${MAX_SET_BYTES / 1024 / 1024} MiB of code at once.`)
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files }
}

/** UTF-8 byte length without `TextEncoder`, which this package cannot name. */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
