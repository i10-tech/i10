import {
  closureOf,
  normalizePath,
  pick,
  readFileSet,
  type FileSet,
} from "@repo/templates"
import { MAX_SOURCE_BYTES, transpile } from "./sandbox.js"

/**
 * One `/compile` request, checked and transpiled, before any sandbox exists.
 *
 * Two forms:
 *
 *   { source }          one file, as #160 shipped it
 *   { entry, files }    a template and the files it imports (#234)
 *
 * ⚠ ONLY THE ENTRY'S CLOSURE IS KEPT. Files the entry never reaches are
 * dropped here, so they are not transpiled, not loaded into the isolate, and
 * not part of its cache id - an upload of twenty templates sharing a folder is
 * twenty small sandboxes, not twenty copies of the folder.
 */
export type Prepared =
  | {
      ok: true
      entry: string
      /** The closure's files, as sent. */
      files: FileSet
      /** The same files, transpiled. */
      code: Record<string, string>
      links: Record<string, Record<string, string>>
    }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 422; problems: string[] }

export function prepare(body: unknown): Prepared {
  const input = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >

  let entry: string
  let files: FileSet
  if (input.source !== undefined) {
    if (typeof input.source !== "string" || input.source.length === 0) {
      return { ok: false, status: 400, error: "`source` is required" }
    }
    if (new TextEncoder().encode(input.source).byteLength > MAX_SOURCE_BYTES) {
      return {
        ok: false,
        status: 422,
        problems: [`A template may be at most ${MAX_SOURCE_BYTES / 1024} KiB.`],
      }
    }
    entry = "template.tsx"
    files = { [entry]: input.source }
  } else {
    if (typeof input.entry !== "string" || input.files === undefined) {
      return {
        ok: false,
        status: 400,
        error: "`source`, or `entry` and `files`, is required",
      }
    }
    const read = readFileSet(input.files)
    if (!read.ok) return { ok: false, status: 422, problems: read.problems }
    const normalized = normalizePath(input.entry)
    if (normalized === null) {
      return { ok: false, status: 422, problems: [`\`${input.entry}\` is not a path.`] }
    }
    entry = normalized
    files = read.files
  }

  const closure = closureOf(entry, files)
  if (closure.problems.length > 0) {
    return { ok: false, status: 422, problems: closure.problems }
  }

  const code: Record<string, string> = {}
  for (const path of closure.paths) {
    const transpiled = transpile(files[path]!, path)
    if (!transpiled.ok) return { ok: false, status: 422, problems: [transpiled.error] }
    code[path] = transpiled.code
  }
  return {
    ok: true,
    entry,
    files: pick(files, closure.paths),
    code,
    links: closure.links,
  }
}
