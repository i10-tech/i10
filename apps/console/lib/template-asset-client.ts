import type { AssetKind, FetchAsset } from "@/lib/email-snapshot"

/**
 * Assets for the snapshots, through the console's forward route and the API's
 * guarded proxy. Memoised per URL for the session, so a font shared by twenty
 * templates is fetched once; a failure is remembered too, so one dead image
 * is not asked for again by every template that uses it.
 *
 * ⚠ EXCEPT A 429. That is the API asking us to slow down, not a verdict on the
 * asset: it fails this snapshot (its fallback applies), then the memo entry is
 * dropped once Retry-After has passed, so a later snapshot asks again.
 *
 * ⚠ BOUNDED. The memo holds data URIs, which are bytes, so past a budget the
 * oldest answers are dropped and asked for again if needed.
 */
const BUDGET = 48 * 1024 * 1024

const memo = new Map<string, Promise<string | null>>()
const sizes = new Map<string, number>()
let held = 0

const DEFAULT_RETRY_MS = 30_000
const MAX_RETRY_MS = 5 * 60_000

/** Retry-After in seconds, as milliseconds we are willing to wait. */
function retryDelay(header: string | null): number {
  const seconds = Number(header)
  if (!header || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_MS
  return Math.min(seconds * 1000, MAX_RETRY_MS)
}

function remember(key: string, pending: Promise<string | null>) {
  memo.set(key, pending)
  void pending.then((value) => {
    if (!memo.has(key)) return
    const size = value?.length ?? 0
    sizes.set(key, size)
    held += size
    for (const old of memo.keys()) {
      if (held <= BUDGET) break
      held -= sizes.get(old) ?? 0
      sizes.delete(old)
      memo.delete(old)
    }
  })
}

function forget(key: string) {
  memo.delete(key)
  held -= sizes.get(key) ?? 0
  sizes.delete(key)
}

function forgetLater(key: string, ms: number) {
  const timer = setTimeout(() => forget(key), ms)
  // Never keep a server process or a test run alive for this.
  ;(timer as { unref?: () => void }).unref?.()
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Our own CDN, fetched straight from the browser instead of through the proxy.
 *
 * ⚠ IT IS OURS, PUBLIC AND IMMUTABLE (#490: template fonts and images, CORS
 * `*`). Through the proxy it would cost a round trip per file and, worse,
 * share the proxy's per-site limit across every workspace, so the one site
 * every template uses would be the first one throttled. The bytes are still
 * inlined as data URIs, so the previews' locked-down frames need no change.
 */
const OUR_CDN = new Set(["https://cdn.i10.tech", "https://cdn-dev.i10.tech"])

const FONT_TYPES: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
}

function ours(url: string): boolean {
  try {
    return OUR_CDN.has(new URL(url).origin)
  } catch {
    return false
  }
}

/** The type to inline as: the CDN's header, or the font's extension when that is generic. */
function inlineType(url: string, header: string | null): string | null {
  if (header && header !== "application/octet-stream")
    return header.split(";")[0]!.trim()
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? ""
  return FONT_TYPES[ext] ?? null
}

async function request(
  url: string,
  kind: AssetKind,
  key: string,
): Promise<string | null> {
  try {
    if (ours(url)) {
      const direct = await fetch(url, { mode: "cors", credentials: "omit" })
      if (!direct.ok) return null
      if (kind === "css") return await direct.text()
      const type = inlineType(url, direct.headers.get("content-type"))
      if (!type) return null
      return `data:${type};base64,${toBase64(new Uint8Array(await direct.arrayBuffer()))}`
    }
    const query = new URLSearchParams({ u: url })
    if (kind === "css") query.set("as", "css")
    const response = await fetch(`/api/template-asset?${query}`)
    if (response.status === 429) {
      forgetLater(key, retryDelay(response.headers.get("retry-after")))
      return null
    }
    if (!response.ok) return null
    if (kind === "css") return await response.text()
    const type = response.headers.get("content-type")
    if (!type) return null
    return `data:${type};base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`
  } catch {
    return null
  }
}

export const fetchAsset: FetchAsset = (url, kind) => {
  const key = `${kind} ${url}`
  let pending = memo.get(key)
  if (!pending) {
    pending = request(url, kind, key)
    remember(key, pending)
  }
  return pending
}
