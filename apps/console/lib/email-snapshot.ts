/**
 * An email as one self-contained SVG image, for the template cards and the
 * folder papers (#248).
 *
 * ⚠ AN SVG IMAGE RUNS NO SCRIPT AND LOADS NOTHING, so it is safe to build from
 * a customer's HTML - and it means every remote image and web font has to be
 * INLINED as a `data:` URI first. `inlineAssets` does that, through an injected
 * `fetchAsset` (the console's proxy in the app, a fake in the tests).
 *
 * ⚠ A FAILED ASSET NEVER FAILS THE PICTURE. An image keeps its box (its
 * width and height stay, the pixel is transparent); a font is dropped and the
 * fallback stack applies.
 */

export type AssetKind = "image" | "font" | "css"

/**
 * The asset at an absolute URL: a `data:` URI for an image or a font, the
 * stylesheet's text for css, or null when it could not be had.
 */
export type FetchAsset = (url: string, kind: AssetKind) => Promise<string | null>

/** The width an email is drawn at, then cropped by whoever shows it. */
export const EMAIL_WIDTH = 760
/** Tall enough for the crop of any consumer (a paper needs about 1000). */
export const SNAPSHOT_HEIGHT = 1400

/** The most distinct assets one email may ask for. */
export const MAX_ASSETS = 40
/** The most fetches in flight at once. */
export const MAX_CONCURRENT = 6

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="
const NO_FONT = "data:,"

interface Run {
  fetchAsset: FetchAsset
  seen: Map<string, Promise<string | null>>
  max: number
  gate: <T>(fn: () => Promise<T>) => Promise<T>
}

function makeRun(fetchAsset: FetchAsset, max: number, concurrent: number): Run {
  let active = 0
  const waiting: (() => void)[] = []
  // A finished fetch hands its slot to the next waiter, so `active` never
  // dips below the limit while somebody is queued.
  const gate = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= concurrent) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  return { fetchAsset, seen: new Map(), max, gate }
}

function load(run: Run, url: string, kind: AssetKind): Promise<string | null> {
  const key = `${kind} ${url}`
  const known = run.seen.get(key)
  if (known) return known
  if (run.seen.size >= run.max) return Promise.resolve(null)
  const pending = run.gate(() => run.fetchAsset(url, kind)).catch(() => null)
  run.seen.set(key, pending)
  return pending
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
}
const decode = (s: string) => s.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (e) => ENTITIES[e]!)
const encode = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

/** An absolute http(s) URL, or null for anything we leave alone. */
function resolve(raw: string, base: string | undefined): string | null {
  const value = raw.trim()
  if (!value || /^data:/i.test(value)) return null
  try {
    if (base === undefined && !/^(https?:)?\/\//i.test(value)) return null
    const url = new URL(base === undefined && value.startsWith("//") ? `https:${value}` : value, base)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null
  } catch {
    return null
  }
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  fn: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = [...text.matchAll(pattern)]
  const parts = await Promise.all(matches.map((m) => fn(m)))
  let out = ""
  let at = 0
  matches.forEach((m, i) => {
    out += text.slice(at, m.index) + parts[i]
    at = m.index + m[0].length
  })
  return out + text.slice(at)
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi

function rewriteUrls(
  text: string,
  base: string | undefined,
  run: Run,
  kind: "image" | "font",
): Promise<string> {
  return replaceAsync(text, CSS_URL, async (m) => {
    const url = resolve(m[1] ?? m[2] ?? m[3] ?? "", base)
    if (!url) return m[0]
    const data = await load(run, url, kind)
    return `url(${data ?? (kind === "font" ? NO_FONT : PIXEL)})`
  })
}

async function rewriteCss(css: string, base: string | undefined, run: Run): Promise<string> {
  // An import loads nothing inside an image, and its URL is not an image.
  const flat = css.replace(/@import[^;]*;/gi, "")
  const fonts = await replaceAsync(flat, /@font-face\s*\{[^}]*\}/gi, async (m) =>
    rewriteUrls(m[0], base, run, "font"),
  )
  return rewriteUrls(fonts, base, run, "image")
}

const TAG =
  /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

async function rewriteTag(m: RegExpExecArray, run: Run): Promise<string> {
  const name = m[1]!.toLowerCase()
  const attrs: { name: string; value: string | null }[] = [...(m[2] ?? "").matchAll(ATTR)].map(
    (a) => ({
      name: a[1]!.toLowerCase(),
      value: a[2] !== undefined || a[3] !== undefined || a[4] !== undefined
        ? decode(a[2] ?? a[3] ?? a[4] ?? "")
        : null,
    }),
  )
  const get = (n: string) => attrs.find((a) => a.name === n)?.value ?? null

  if (name === "link") {
    const href = resolve(get("href") ?? "", undefined)
    if (!/\bstylesheet\b/i.test(get("rel") ?? "") || !href) return m[0]
    const css = await load(run, href, "css")
    if (css === null) return ""
    const inlined = await rewriteCss(css, href, run)
    return `<style>${inlined.replace(/<\/style/gi, "")}</style>`
  }

  let changed = false
  const jobs = attrs.map(async (a) => {
    if (a.value === null) return
    if (name === "img" && a.name === "src") {
      const url = resolve(a.value, undefined)
      if (!url) return
      a.value = (await load(run, url, "image")) ?? PIXEL
      changed = true
    } else if (a.name === "background") {
      const url = resolve(a.value, undefined)
      if (!url) return
      a.value = (await load(run, url, "image")) ?? PIXEL
      changed = true
    } else if (a.name === "style" && /url\(/i.test(a.value)) {
      const next = await rewriteUrls(a.value, undefined, run, "image")
      if (next !== a.value) {
        a.value = next
        changed = true
      }
    }
  })
  await Promise.all(jobs)

  if (name === "img") {
    const kept = attrs.filter((a) => a.name !== "srcset" && a.name !== "sizes")
    if (kept.length !== attrs.length) {
      attrs.length = 0
      attrs.push(...kept)
      changed = true
    }
  }
  if (!changed) return m[0]
  const written = attrs
    .map((a) => (a.value === null ? ` ${a.name}` : ` ${a.name}="${encode(a.value)}"`))
    .join("")
  return `<${m[1]}${written}${m[3] ? " /" : ""}>`
}

async function rewriteSegment(html: string, run: Run): Promise<string> {
  const styled = await replaceAsync(html, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (m) =>
    `${m[1]}${await rewriteCss(m[2]!, undefined, run)}${m[3]}`,
  )
  return replaceAsync(styled, TAG, (m) => rewriteTag(m, run))
}

/**
 * The email with its remote images, background images, web fonts and linked
 * stylesheets inlined. Comments (Outlook's conditional blocks) are left alone.
 */
export async function inlineAssets(
  html: string,
  fetchAsset: FetchAsset,
  limits: { max?: number; concurrent?: number } = {},
): Promise<string> {
  const run = makeRun(fetchAsset, limits.max ?? MAX_ASSETS, limits.concurrent ?? MAX_CONCURRENT)
  const segments = html.split(/(<!--[\s\S]*?-->)/)
  const done = await Promise.all(
    segments.map((s, i) => (i % 2 === 1 ? s : rewriteSegment(s, run))),
  )
  return done.join("")
}

/**
 * The email as an SVG image of its own HTML, at an email's width.
 * Browser-only (DOMParser). Expects `html` already inlined.
 */
export function snapshotSvg(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc.querySelectorAll("script, link, meta, title").forEach((n) => n.remove())
  const page = doc.createElement("div")
  page.setAttribute(
    "style",
    `width:${EMAIL_WIDTH}px;height:${SNAPSHOT_HEIGHT}px;overflow:hidden;background:#fff;${doc.body.getAttribute("style") ?? ""}`,
  )
  doc.querySelectorAll("style").forEach((s) => page.appendChild(s))
  while (doc.body.firstChild) page.appendChild(doc.body.firstChild)
  const xhtml = new XMLSerializer().serializeToString(page)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${EMAIL_WIDTH}" height="${SNAPSHOT_HEIGHT}" viewBox="0 0 ${EMAIL_WIDTH} ${SNAPSHOT_HEIGHT}"><foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`
}

const VARIABLE = /\{\{\{\s*([A-Za-z_][\w.]*)\s*\}\}\}|\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g

/** The editor's chip (editor.css `.i10-variable`), as inline style. */
const CHIP =
  "display:inline-block;padding:0 .3em;margin:0 .06em;border-radius:5px;" +
  "background:rgba(59,130,246,.1);box-shadow:inset 0 0 0 1px rgba(59,130,246,.25);" +
  "color:#2563eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
  "font-size:.82em;line-height:1.45;white-space:nowrap"

/**
 * Variables left unfilled, drawn as the editor's chip: `{{{name}}}` in blue
 * monospace with its braces dimmed - not raw braces in the body text.
 *
 * ⚠ TEXT ONLY. A variable in a link's address stays as written; only what a
 * reader would see is restyled, and only for this picture.
 */
export function asInEditor(html: string): string {
  if (typeof DOMParser === "undefined" || !/\{\{/.test(html)) return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement?.tagName
    if (parent === "STYLE" || parent === "SCRIPT" || parent === "TITLE") continue
    if (VARIABLE.test(n.textContent ?? "")) texts.push(n as Text)
    VARIABLE.lastIndex = 0
  }
  for (const node of texts) {
    const value = node.textContent ?? ""
    const parts = doc.createDocumentFragment()
    let at = 0
    for (const m of value.matchAll(VARIABLE)) {
      parts.append(value.slice(at, m.index))
      const chip = doc.createElement("span")
      chip.setAttribute("style", CHIP)
      const brace = (t: string) => {
        const b = doc.createElement("span")
        b.setAttribute("style", "opacity:.55")
        b.textContent = t
        return b
      }
      chip.append(brace("{{{"), (m[1] ?? m[2])!, brace("}}}"))
      parts.append(chip)
      at = m.index + m[0].length
    }
    parts.append(value.slice(at))
    node.replaceWith(parts)
  }
  return "<!doctype html>" + doc.documentElement.outerHTML
}
