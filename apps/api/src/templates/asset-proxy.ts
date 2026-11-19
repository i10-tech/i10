import { fixedWindow, type Limit } from "../identity/rate-limit.js"
import { pinnedRequest, vetHost, type Lookup } from "../webhooks/egress.js"

/**
 * A template thumbnail's remote images and web fonts, fetched for it.
 *
 * ⚠ AN IMAGE THE BROWSER BUILDS FROM AN EMAIL LOADS NOTHING EXTERNAL, so the
 * console asks here for each asset and inlines the bytes. That makes this a
 * fetcher of any URL a customer's HTML names, which is the shape of an SSRF:
 * every hop goes through the webhook egress guard (resolve, vet every address,
 * connect to the vetted address and nothing else).
 *
 * ⚠ THE TYPE IS READ FROM THE BYTES, NEVER THE HEADER. The upstream's
 * Content-Type is whatever its owner says; what we serve is what the first
 * bytes are. SVG is refused outright: it can carry script (#244 refuses it
 * too), and a stylesheet is served only to a caller that asked for one.
 */

export const IMAGE_CAP = 5 * 1024 * 1024
export const FONT_CAP = 2 * 1024 * 1024
export const CSS_CAP = 2 * 1024 * 1024
export const MAX_REDIRECTS = 3
export const TIMEOUT_MS = 5_000
export const CACHE_BYTES = 64 * 1024 * 1024
export const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_URL_LENGTH = 2048

/** Key prefix of this proxy's counters, apart from the SSO limiter's. */
export const RATE_PREFIX = "template-assets:rate:"
/** Every proxy request of a workspace, cache hits included. */
export const REQUESTS_PER_WORKSPACE: Limit = { max: 600, windowSeconds: 60 }
/** A workspace's upstream fetches: cache misses that go to the network. */
export const FETCHES_PER_WORKSPACE: Limit = { max: 120, windowSeconds: 60 }
/** Upstream fetches to one host, all workspaces together, redirect hops included. */
export const FETCHES_PER_HOST: Limit = { max: 300, windowSeconds: 60 }

export const RATE_LIMITED_MESSAGE =
  "Too many template asset requests. Wait a moment and try again."

export type AssetKind = "image" | "font" | "css"

export type AssetResult =
  | { ok: true; body: Uint8Array<ArrayBuffer>; type: string }
  | { ok: false; status: 400 | 403 | 413 | 415 | 502; message: string }
  | { ok: false; status: 429; message: string; retryAfter: number }

export interface AssetProxy {
  fetch(raw: string, as: "css" | undefined, workspace: string): Promise<AssetResult>
}

export interface AssetProxyOptions {
  lookup?: Lookup
  fetch?: typeof fetch
  timeoutMs?: number
  cacheBytes?: number
  now?: () => number
  /** The counter behind the rate limits; default is per-process, on `now`. */
  limiter?: ReturnType<typeof fixedWindow>
}

const fail = (status: 400 | 403 | 413 | 415 | 502, message: string): AssetResult => ({
  ok: false,
  status,
  message,
})

const ascii = (b: Uint8Array, at: number, text: string) =>
  b.length >= at + text.length &&
  [...text].every((ch, i) => b[at + i] === ch.charCodeAt(0))

const startsWith = (b: Uint8Array, ...bytes: number[]) =>
  b.length >= bytes.length && bytes.every((v, i) => b[i] === v)

interface Sniffed {
  kind: "image" | "font"
  type: string
}

/** What the first bytes say the file is, or null when it is not one we serve. */
export function sniff(b: Uint8Array): Sniffed | null {
  if (startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return { kind: "image", type: "image/png" }
  if (startsWith(b, 0xff, 0xd8, 0xff)) return { kind: "image", type: "image/jpeg" }
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))
    return { kind: "image", type: "image/gif" }
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"))
    return { kind: "image", type: "image/webp" }
  if (ascii(b, 4, "ftyp") && (ascii(b, 8, "avif") || ascii(b, 8, "avis")))
    return { kind: "image", type: "image/avif" }
  if (ascii(b, 0, "wOF2")) return { kind: "font", type: "font/woff2" }
  if (ascii(b, 0, "wOFF")) return { kind: "font", type: "font/woff" }
  if (startsWith(b, 0x00, 0x01, 0x00, 0x00) || ascii(b, 0, "true"))
    return { kind: "font", type: "font/ttf" }
  if (ascii(b, 0, "OTTO")) return { kind: "font", type: "font/otf" }
  return null
}

/** The shortest prefix `sniff` needs. */
const SNIFF_BYTES = 12

type Parsed = { ok: true; url: URL } | { ok: false; message: string }

function parseTarget(raw: string): Parsed {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH)
    return { ok: false, message: "Not a usable URL." }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: "Not a URL." }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, message: "Only http and https URLs are fetched." }
  if (url.username || url.password)
    return { ok: false, message: "A URL with credentials is not fetched." }
  // `URL.port` is empty for the scheme's default port, however it was written.
  if (url.port !== "") return { ok: false, message: "Only default ports are fetched." }
  return { ok: true, url }
}

class Refusal extends Error {
  constructor(readonly result: AssetResult) {
    super("refused")
  }
}

export function createAssetProxy(options: AssetProxyOptions = {}): AssetProxy {
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const budget = options.cacheBytes ?? CACHE_BYTES
  const now = options.now ?? Date.now
  const take = options.limiter ?? fixedWindow(null, now, RATE_PREFIX)
  const limited = (retryAfter: number): AssetResult => ({
    ok: false,
    status: 429,
    message: RATE_LIMITED_MESSAGE,
    retryAfter,
  })

  // Insertion order is recency: a hit is deleted and set again.
  const cache = new Map<
    string,
    { value: Extract<AssetResult, { ok: true }>; at: number }
  >()
  let cached = 0
  const pending = new Map<string, Promise<AssetResult>>()

  const remember = (key: string, value: Extract<AssetResult, { ok: true }>) => {
    if (value.body.byteLength > budget) return
    const old = cache.get(key)
    if (old) {
      cached -= old.value.body.byteLength
      cache.delete(key)
    }
    cache.set(key, { value, at: now() })
    cached += value.body.byteLength
    for (const [k, v] of cache) {
      if (cached <= budget) break
      cache.delete(k)
      cached -= v.value.body.byteLength
    }
  }

  async function read(
    start: URL,
    wantCss: boolean,
    signal: AbortSignal,
  ): Promise<Extract<AssetResult, { ok: true }>> {
    let url = start
    for (let hop = 0; ; hop++) {
      const allowed = await take(`host:${url.hostname.toLowerCase()}`, FETCHES_PER_HOST)
      if (!allowed.ok) throw new Refusal(limited(allowed.retryAfter))
      const verdict = await vetHost(url.hostname, {
        ...(options.lookup ? { lookup: options.lookup } : {}),
        signal,
      })
      if (!verdict.ok) {
        throw new Refusal(
          verdict.kind === "blocked"
            ? fail(403, "That address is not fetched.")
            : fail(502, "The address could not be resolved."),
        )
      }
      const pinned = pinnedRequest(url, verdict)
      const response = await doFetch(pinned.url, {
        method: "GET",
        headers: {
          host: pinned.host,
          accept: wantCss ? "text/css,*/*;q=0.1" : "image/*,font/*,*/*;q=0.1",
        },
        signal,
        redirect: "manual",
        ...(pinned.serverName ? { tls: { serverName: pinned.serverName } } : {}),
      })

      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {})
        const location = response.headers.get("location")
        if (!location || hop >= MAX_REDIRECTS)
          throw new Refusal(fail(502, "The upstream redirected too far."))
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new Refusal(fail(502, "The upstream redirected somewhere unusable."))
        }
        const parsed = parseTarget(next.toString())
        if (!parsed.ok) throw new Refusal(fail(403, "That redirect is not followed."))
        url = parsed.url
        continue
      }
      if (!response.ok || !response.body)
        throw new Refusal(fail(502, "The upstream did not return the file."))
      return await readBody(response, wantCss)
    }
  }

  /** The body, capped while it streams; its type is decided from the bytes. */
  async function readBody(response: Response, wantCss: boolean) {
    const reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let cap = wantCss ? CSS_CAP : IMAGE_CAP
    let sniffed: Sniffed | null | undefined
    const head = new Uint8Array(SNIFF_BYTES)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (let i = 0; i < value.byteLength && size + i < SNIFF_BYTES; i++)
          head[size + i] = value[i]!
        size += value.byteLength
        chunks.push(value)
        if (!wantCss && sniffed === undefined && size >= SNIFF_BYTES) {
          sniffed = sniff(head)
          if (!sniffed) throw new Refusal(fail(415, "That file type is not served."))
          cap = sniffed.kind === "font" ? FONT_CAP : IMAGE_CAP
        }
        if (size > cap) throw new Refusal(fail(413, "That file is too large."))
      }
    } catch (error) {
      if (error instanceof Refusal) throw error
      throw new Refusal(fail(502, "The upstream stopped answering."))
    } finally {
      void reader.cancel().catch(() => {})
    }

    const body = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      body.set(chunk, at)
      at += chunk.byteLength
    }
    if (wantCss) {
      if (body.includes(0)) throw new Refusal(fail(415, "That is not a stylesheet."))
      return { ok: true as const, body, type: "text/css; charset=utf-8" }
    }
    const found = sniffed ?? sniff(body)
    if (!found) throw new Refusal(fail(415, "That file type is not served."))
    if (found.kind === "font" && size > FONT_CAP)
      throw new Refusal(fail(413, "That file is too large."))
    return { ok: true as const, body, type: found.type }
  }

  async function load(raw: string, wantCss: boolean): Promise<AssetResult> {
    const parsed = parseTarget(raw)
    if (!parsed.ok) return fail(400, parsed.message)
    try {
      const value = await read(parsed.url, wantCss, AbortSignal.timeout(timeoutMs))
      remember(`${wantCss ? "css" : "bin"}:${raw}`, value)
      return value
    } catch (error) {
      if (error instanceof Refusal) return error.result
      return fail(502, "The upstream did not answer.")
    }
  }

  return {
    async fetch(raw, as, workspace) {
      const requests = await take(`requests:${workspace}`, REQUESTS_PER_WORKSPACE)
      if (!requests.ok) return limited(requests.retryAfter)
      const wantCss = as === "css"
      const key = `${wantCss ? "css" : "bin"}:${raw}`
      const hit = cache.get(key)
      if (hit && now() - hit.at < CACHE_TTL_MS) {
        cache.delete(key)
        cache.set(key, hit)
        return hit.value
      }
      let inFlight = pending.get(key)
      if (!inFlight) {
        // Registered before anything is awaited, so a second caller coalesces.
        // Only the one who starts the fetch pays for it; a waiter costs nothing.
        inFlight = (async () => {
          const fetches = await take(`fetches:${workspace}`, FETCHES_PER_WORKSPACE)
          return fetches.ok ? load(raw, wantCss) : limited(fetches.retryAfter)
        })().finally(() => pending.delete(key))
        pending.set(key, inFlight)
      }
      return inFlight
    },
  }
}
