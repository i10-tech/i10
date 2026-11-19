/**
 * Measures, frame by frame, what a click between list pages paints: skeleton bars
 * or content, and when the destination's content first shows.
 *
 *   bun scripts/motion/revisit.ts [--base http://localhost:3043]
 *
 * Against the preview (CONSOLE_PREVIEW=1, CONSOLE_PREVIEW_DELAY_MS=800). Plays
 * /templates -> a folder -> "All templates" -> the same folder -> /domains and
 * prints one line per click. A first visit must show bars and hold them at least
 * 400ms; a revisit must show none and paint content within a few frames.
 */
import { chromium, type Page } from "playwright-core"

const args = process.argv.slice(2)
const base = args.includes("--base") ? args[args.indexOf("--base") + 1]! : "http://localhost:3043"
// --requests also prints each fetch a click sent and what came back.
const verbose = args.includes("--requests")
const FOLDER = "/templates/folder/f01de700-0000-4000-8000-000000000002"

type Frame = { t: number; path: string; bars: number; busy: number; page: string; text: string }

const browser = await chromium.launch({ channel: "chrome", headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.addInitScript(() => {
  const w = window as unknown as { __frames: unknown[]; __sampling: boolean }
  w.__frames = []
  w.__sampling = false
  document.addEventListener("click", () => ((window as unknown as { __clickAt: number }).__clickAt = performance.now()), true)
  const tick = () => {
    if (w.__sampling) {
      const main = document.querySelector("main")
      w.__frames.push({
        t: performance.now(),
        path: location.pathname,
        bars: document.querySelectorAll("main [data-bone-bar]").length,
        busy: document.querySelectorAll('main [aria-busy="true"]').length,
        page: main?.querySelector('nav[aria-label="Breadcrumb"]')
          ? "folder"
          : main?.querySelector('a[href^="/templates/folder/"]')
            ? "index"
            : main?.querySelector("h1")?.textContent?.trim() || "?",
        text: main?.querySelector("table") ? "table" : "grid",
      })
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

async function settled(p: Page, path: string, linger = 1500) {
  await p.waitForFunction(
    (path) =>
      location.pathname === path &&
      !document.querySelector("main [data-bone-bar]") &&
      !document.querySelector('main [aria-busy="true"]'),
    path,
    { timeout: 120000, polling: "raf" },
  )
  await p.waitForTimeout(linger)
}

async function measure(
  label: string,
  dest: string,
  want: string,
  click: () => Promise<void>,
  linger = 1500,
) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[]; __sampling: boolean }
    w.__frames = []
    w.__sampling = true
  })
  requests.length = 0
  requests.push(`${Date.now() - started}ms click`)
  await click()
  await settled(page, dest, linger)
  const frames = (await page.evaluate(() => {
    const w = window as unknown as { __frames: unknown[]; __sampling: boolean }
    w.__sampling = false
    return w.__frames
  })) as Frame[]
  const at = await page.evaluate(() => (window as unknown as { __clickAt: number }).__clickAt)
  const after = frames.filter((f) => f.t >= at)
  const barred = after.filter((f) => f.bars > 0)
  const content = after.find((f) => f.page === want && f.bars === 0 && f.busy === 0)
  const committed = after.find((f) => f.path === dest)
  const ms = (f?: Frame) => (f ? `${Math.round(f.t - at)}ms` : "never")
  console.log(
    [
      label.padEnd(30),
      `bar frames ${String(barred.length).padStart(3)}`,
      `bars ${ms(barred[0])}..${ms(barred.at(-1))}`,
      `content ${ms(content)}`,
      `url ${ms(committed)}`,
      `frames ${after.length}`,
    ].join("  "),
  )
  if (verbose) for (const line of requests) console.log(`    ${line}`)
  return after
}

const requests: string[] = []
const started = Date.now()
page.on("request", (req) => {
  if (!["fetch", "xhr"].includes(req.resourceType())) return
  const url = new URL(req.url())
  if (url.pathname.startsWith("/api/template-preview")) return
  requests.push(`${Date.now() - started}ms   sent ${req.method()} ${url.pathname}`)
})
page.on("response", (response) => {
  const req = response.request()
  if (!["fetch", "xhr"].includes(req.resourceType())) return
  const url = new URL(req.url())
  if (url.pathname.startsWith("/api/template-preview")) return
  const action = req.headers()["next-action"] ? " action" : ""
  const h = req.headers()
  const rsc = h["rsc"]
    ? ` rsc${h["next-router-prefetch"] ? " prefetch" : ""}${h["next-router-segment-prefetch"] ? ` seg=${h["next-router-segment-prefetch"]}` : ""}`
    : ""
  const revalidated = response.headers()["x-action-revalidated"]
  requests.push(
    `${Date.now() - started}ms ${req.method()} ${url.pathname}${url.search}${action}${rsc}${revalidated ? ` revalidated=${revalidated}` : ""}`,
  )
})

const link = (href: string) => async () => {
  await page.locator(`main a[href="${href}"]`).first().click()
}

await page.goto(`${base}/templates`, { waitUntil: "load", timeout: 180000 })
await settled(page, "/templates")
// Warm the folder and domains routes' code so the first visits measure data, not compiles.
for (const warm of [FOLDER, "/domains", "/templates"]) {
  await page.goto(`${base}${warm}`, { waitUntil: "load", timeout: 180000 })
  await settled(page, warm)
}

await measure("first visit: folder", FOLDER, "folder", link(FOLDER))
await measure("revisit: All templates", "/templates", "index", async () => {
  await page.locator('main nav[aria-label="Breadcrumb"] a[href="/templates"]').click()
})
await measure("revisit: same folder", FOLDER, "folder", link(FOLDER))
await measure("revisit: All templates again", "/templates", "index", async () => {
  await page.locator('main nav[aria-label="Breadcrumb"] a[href="/templates"]').click()
})
// A mutation empties Next's cache, so the next visit is a first visit again: never stale.
await measure("revisit: same folder (3)", FOLDER, "folder", link(FOLDER))
await page.locator('main button[aria-label^="Actions for"]').first().click()
await page.getByRole("menuitem", { name: "Duplicate template" }).click()
await page.waitForTimeout(3000)
await measure("after a mutation: All templates", "/templates", "index", async () => {
  await page.locator('main nav[aria-label="Breadcrumb"] a[href="/templates"]').click()
})

// Something changes on the server between visits: the layout the templates page is drawn in.
await measure("revisit: same folder (2)", FOLDER, "folder", link(FOLDER))
await page.context().addCookies([{ name: "i10-view-templates", value: "table", url: base }])
const changed = await measure("revisit after a change", "/templates", "index", async () => {
  await page.locator('main nav[aria-label="Breadcrumb"] a[href="/templates"]').click()
}, 5000)
const at = changed[0]!.t
const table = changed.find((f) => f.text === "table")
console.log(
  `    drawn as a grid from the cache, then a table at ${table ? Math.round(table.t - at) : "never"}ms; ` +
    `bar frames after the click ${changed.filter((f) => f.bars > 0).length}`,
)

await measure("first visit: domains", "/domains", "Domains", async () => {
  await page.locator('a[href="/domains"]').first().click()
})

await browser.close()
