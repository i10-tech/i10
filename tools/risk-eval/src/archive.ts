import { existsSync } from "node:fs"
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES } from "./limits.js"

/**
 * Extraction of untrusted archives through the system `tar` (bsdtar reads
 * tar.bz2 and 7z; GNU tar reads tar.bz2 only).
 *
 * The listing is read and validated BEFORE anything is written: absolute paths,
 * `..` segments, links, devices, an absurd entry count or total size all refuse
 * the archive. After extraction the tree is walked once more and any symlink
 * fails it. Nothing extracted is ever executed.
 */

export interface ArchiveEntry {
  path: string
  size: number
  kind: "file" | "dir" | "other"
}

// bsdtar: -rw-r--r--  0 0      0       11398 Oct  1 23:01 2026/10/name.txt
const BSD_LINE =
  /^([-dlhbcps])\S{9}\+?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/
// GNU tar: -rw-r--r-- user/group 8318 2003-02-28 12:00 hard_ham/00001.abc
const GNU_LINE =
  /^([-dlhbcps])\S{9}\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/

export function parseListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue
    const m = BSD_LINE.exec(line) ?? GNU_LINE.exec(line)
    if (m === null)
      throw new Error(`unrecognised archive listing line: ${line.slice(0, 120)}`)
    const [, type, size, path] = m
    if (type === undefined || size === undefined || path === undefined) {
      throw new Error(`unrecognised archive listing line: ${line.slice(0, 120)}`)
    }
    // Links print as "name -> target" or "name link to target": refuse them
    // by name as well as by type, since the type column is easy to misread.
    const link = / -> | link to /.test(path)
    const kind = link ? "other" : type === "-" ? "file" : type === "d" ? "dir" : "other"
    entries.push({ path, size: Number(size), kind })
  }
  return entries
}

export function validateEntries(entries: ArchiveEntry[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `archive has ${entries.length} entries, over the limit ${MAX_ARCHIVE_ENTRIES}`,
    )
  }
  let total = 0
  for (const e of entries) {
    if (e.kind === "other")
      throw new Error(`archive holds a link or special file: ${e.path}`)
    if (
      e.path.startsWith("/") ||
      /^[a-z]:[\\/]/i.test(e.path) ||
      e.path.includes("\0")
    ) {
      throw new Error(`archive path is absolute or malformed: ${e.path}`)
    }
    if (e.path.split(/[\\/]/).includes("..")) {
      throw new Error(`archive path traverses upwards: ${e.path}`)
    }
    total += e.size
    if (total > MAX_ARCHIVE_BYTES) {
      throw new Error(`archive expands past ${MAX_ARCHIVE_BYTES} bytes`)
    }
  }
}

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new Error(`tar ${args[0]} failed (${code}): ${stderr.slice(0, 300)}`)
  return stdout
}

async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const rel = prefix === "" ? name : `${prefix}/${name}`
    const info = await lstat(join(root, rel))
    if (info.isSymbolicLink()) throw new Error(`extraction produced a symlink: ${rel}`)
    if (info.isDirectory()) out.push(...(await walkFiles(root, rel)))
    else if (info.isFile() && name !== EXTRACTED_MARKER) out.push(rel)
  }
  return out
}

const EXTRACTED_MARKER = ".extracted"

/**
 * Extracts `archive` into `dest` and returns its files, relative and sorted.
 * A completed extraction leaves a marker so a rerun reuses it.
 */
export async function extractArchive(archive: string, dest: string): Promise<string[]> {
  if (!existsSync(join(dest, EXTRACTED_MARKER))) {
    validateEntries(parseListing(await run(["-tvf", archive])))
    await rm(dest, { recursive: true, force: true })
    await mkdir(dest, { recursive: true })
    await run(["-xf", archive, "-C", dest, "--no-same-owner", "--no-same-permissions"])
    await walkFiles(dest)
    await writeFile(join(dest, EXTRACTED_MARKER), "")
  }
  return walkFiles(dest)
}
