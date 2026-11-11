import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { MAX_FILE_BYTES } from "./limits.js"
import { TOOL_DIR, datasetDir } from "./paths.js"
import {
  DATASETS,
  type DatasetDef,
  fetchableByDefault,
  findDataset,
} from "./registry.js"

export interface ManifestEntry {
  bytes: number
  sha256: string
}

/** The committed pin: what each downloaded file must hash to. */
export interface Manifest {
  version: 1
  datasets: Record<string, Record<string, ManifestEntry>>
}

export const MANIFEST_PATH = join(TOOL_DIR, "manifest.json")

export async function readManifest(path = MANIFEST_PATH): Promise<Manifest> {
  if (!existsSync(path)) return { version: 1, datasets: {} }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  const m = parsed as Partial<Manifest>
  if (m.version !== 1 || typeof m.datasets !== "object" || m.datasets === null) {
    throw new Error(`${path} is not a version 1 manifest`)
  }
  return { version: 1, datasets: m.datasets }
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}

export async function writeManifest(
  manifest: Manifest,
  path = MANIFEST_PATH,
): Promise<void> {
  const datasets: Manifest["datasets"] = {}
  for (const [id, files] of Object.entries(sortedRecord(manifest.datasets))) {
    datasets[id] = sortedRecord(files)
  }
  await writeFile(path, `${JSON.stringify({ version: 1, datasets }, null, 2)}\n`)
}

/**
 * Which datasets a fetch may touch.
 *
 * ⚠ TERMS ARE ENFORCED HERE, NOT JUST DOCUMENTED. With no ids given, only
 * datasets whose terms allow evaluation are fetched. A dataset whose terms are
 * unclear needs its id in `accepted` (a human decision, per run); one whose
 * terms forbid our use cannot be fetched at all.
 */
export function selectDatasets(requested: string[], accepted: string[]): DatasetDef[] {
  const chosen =
    requested.length === 0
      ? DATASETS.filter(fetchableByDefault)
      : requested.map(findDataset)
  for (const d of chosen) {
    if (d.terms.verdict === "not-usable")
      throw new Error(`${d.id}: terms do not allow our use`)
    if (d.terms.verdict === "unclear" && !accepted.includes(d.id)) {
      throw new Error(
        `${d.id}: terms are unclear; pass --accept-unclear ${d.id} to fetch it anyway`,
      )
    }
  }
  return chosen
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export interface FetchFileOptions {
  url: string
  dest: string
  expected: ManifestEntry | undefined
  /** Accept (and report) a file whose hash differs from the pin, or has none. */
  updateManifest: boolean
  fetchImpl?: FetchImpl
  maxBytes?: number
}

export type FetchStatus = "cached" | "downloaded" | "pinned" | "repinned"

/** Downloads one file with a size cap and checks it against the pin. */
export async function fetchFile(
  opts: FetchFileOptions,
): Promise<{ status: FetchStatus; entry: ManifestEntry }> {
  const { url, dest, expected, updateManifest } = opts
  const fetchImpl = opts.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init))
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES
  if (!url.startsWith("https://")) throw new Error(`refusing a non-https url: ${url}`)

  if (existsSync(dest) && expected !== undefined) {
    const sha256 = await sha256OfFile(dest)
    if (sha256 === expected.sha256) return { status: "cached", entry: expected }
  }
  if (expected === undefined && !updateManifest) {
    throw new Error(
      `${dest} is not pinned in the manifest; review it, then rerun with --update-manifest`,
    )
  }

  const res = await fetchImpl(url, {
    headers: { "user-agent": "i10-risk-eval/0.1" },
    redirect: "follow",
  })
  if (!res.ok || res.body === null) throw new Error(`${url}: HTTP ${res.status}`)
  if (res.url !== "" && !res.url.startsWith("https://"))
    throw new Error(`${url}: redirected to a non-https url`)
  const declared = Number(res.headers.get("content-length") ?? 0)
  if (declared > maxBytes)
    throw new Error(`${url}: ${declared} bytes is over the ${maxBytes} byte limit`)

  await mkdir(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  const hash = createHash("sha256")
  let bytes = 0
  const handle = await open(partial, "w")
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length
      if (bytes > maxBytes) throw new Error(`${url}: over the ${maxBytes} byte limit`)
      hash.update(chunk)
      await handle.write(chunk)
    }
  } catch (error) {
    await handle.close()
    await rm(partial, { force: true })
    throw error
  }
  await handle.close()

  const entry: ManifestEntry = { bytes, sha256: hash.digest("hex") }
  const changed = expected !== undefined && expected.sha256 !== entry.sha256
  if (changed && !updateManifest) {
    await rm(partial, { force: true })
    throw new Error(
      `${url} changed upstream: pinned ${expected.sha256}, got ${entry.sha256}. ` +
        "Nothing was kept. Review the change, then rerun with --update-manifest to accept it.",
    )
  }
  await rename(partial, dest)
  return {
    status: expected === undefined ? "pinned" : changed ? "repinned" : "downloaded",
    entry,
  }
}

/**
 * Checks every file of a dataset against the committed pin before it is parsed,
 * so a file replaced or corrupted in the cache is noticed instead of silently
 * becoming evaluation data.
 */
export async function verifyDataset(
  root: string,
  dataset: DatasetDef,
  manifest: Manifest,
): Promise<void> {
  const pins = manifest.datasets[dataset.id]
  for (const file of dataset.files) {
    const path = join(datasetDir(root, dataset.id), file.name)
    const pin = pins?.[file.name]
    if (pin === undefined)
      throw new Error(`${dataset.id}/${file.name} is not pinned in the manifest`)
    if (!existsSync(path)) throw new Error(`${path} is missing; run fetch first`)
    const sha256 = await sha256OfFile(path)
    if (sha256 !== pin.sha256) {
      throw new Error(
        `${path} does not match the manifest (got ${sha256}, pinned ${pin.sha256})`,
      )
    }
  }
}

/**
 * Pins files that were put in the cache by hand, for a dataset that sits behind
 * an account (Kaggle). It hashes what is there; it does not decide the file is
 * the right one, which is the reviewer's check before committing the manifest.
 */
export async function pinLocalFiles(
  root: string,
  dataset: DatasetDef,
  manifest: Manifest,
): Promise<Manifest> {
  const next: Manifest = {
    version: 1,
    datasets: structuredClone(manifest.datasets),
  }
  const pins = (next.datasets[dataset.id] ??= {})
  for (const file of dataset.files) {
    const path = join(datasetDir(root, dataset.id), file.name)
    if (!existsSync(path))
      throw new Error(`${path} is missing; put the download there first`)
    pins[file.name] = {
      bytes: (await stat(path)).size,
      sha256: await sha256OfFile(path),
    }
  }
  return next
}

export interface FetchReport {
  dataset: string
  file: string
  status: FetchStatus
  bytes: number
  sha256: string
}

/** Fetches every file of the chosen datasets and returns the updated manifest. */
export async function fetchDatasets(opts: {
  root: string
  datasets: DatasetDef[]
  manifest: Manifest
  updateManifest: boolean
  fetchImpl?: FetchImpl
  onFile?: (report: FetchReport) => void
}): Promise<Manifest> {
  const next: Manifest = {
    version: 1,
    datasets: structuredClone(opts.manifest.datasets),
  }
  for (const dataset of opts.datasets) {
    // A generated dataset has no files, so it gets no manifest entry either.
    if (dataset.files.length === 0) continue
    const pins = (next.datasets[dataset.id] ??= {})
    for (const file of dataset.files) {
      const { status, entry } = await fetchFile({
        url: file.url,
        dest: join(datasetDir(opts.root, dataset.id), file.name),
        expected: pins[file.name],
        updateManifest: opts.updateManifest,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
      pins[file.name] = entry
      opts.onFile?.({ dataset: dataset.id, file: file.name, status, ...entry })
    }
  }
  return next
}
