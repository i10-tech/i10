/**
 * Plays an interaction in real Chrome and reports what a person would see jerk.
 *
 *   bun scripts/motion/check.ts scripts/motion/flows/sso.json [--base http://localhost:3010] [--only name] [--frames]
 *
 * A flow is a list of steps. Each action step is measured frame by frame for `window`
 * ms, and reports:
 *   snap     an element moved far more in one frame than in the frames around it
 *   pop-in   an element arrived at full size and full opacity in one frame
 *   pop-out  an element left at full size and full opacity in one frame
 * With --frames it also saves about 30 screenshots a second of each measured step to
 * .motion/<flow>/<step>/, for looking at. Exit code 1 means something was flagged.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { chromium, type Locator, type Page } from "playwright-core"

type Step = {
  /** goto | click | fill | hover | press | wait */
  do: string
  url?: string
  role?: string
  name?: string
  text?: string
  label?: string
  value?: string
  ms?: number
  /** Measure this step for this long; default 1500. `false` skips measuring. */
  window?: number | false
  note?: string
  exact?: boolean
}
type Flow = { name: string; scheme?: "light" | "dark"; width?: number; height?: number; steps: Step[] }

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const file = args[0]
if (!file) throw new Error("Usage: bun scripts/motion/check.ts <flows.json>")
const base = flag("base") ?? "http://localhost:3010"
const only = flag("only")
const saveFrames = args.includes("--frames")
const JUMP = Number(flag("jump") ?? 5)
const APPEAR = Number(flag("appear") ?? 14)
const sampler = readFileSync(join(dirname(import.meta.path), "sampler.js"), "utf8")
const flows = JSON.parse(readFileSync(file, "utf8")) as Flow[]

function target(page: Page, s: Step): Locator {
  if (s.label) return page.getByLabel(s.label, { exact: s.exact ?? false }).first()
  if (s.text) return page.getByText(s.text, { exact: s.exact ?? false }).first()
  return page
    .getByRole((s.role ?? "button") as "button", { name: s.name, exact: s.exact ?? true })
    .first()
}

async function act(page: Page, s: Step) {
  if (s.do === "goto") await page.goto(base + s.url, { waitUntil: "commit", timeout: 90000 })
  else if (s.do === "click") await target(page, s).click({ timeout: 20000 })
  else if (s.do === "fill") await target(page, s).fill(s.value ?? "", { timeout: 20000 })
  else if (s.do === "hover") await target(page, s).hover({ timeout: 20000 })
  else if (s.do === "press") await page.keyboard.press(s.value ?? "Enter")
  else if (s.do === "wait") await page.waitForTimeout(s.ms ?? 500)
  else throw new Error(`Unknown step ${s.do}`)
}

async function grabFrames(page: Page, dir: string, ms: number) {
  mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  let n = 0
  cdp.on("Page.screencastFrame", (frame) => {
    writeFileSync(join(dir, `${String(n++).padStart(3, "0")}.jpg`), Buffer.from(frame.data, "base64"))
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 })
  return async () => {
    await page.waitForTimeout(0)
    await cdp.send("Page.stopScreencast").catch(() => {})
    await cdp.detach().catch(() => {})
    return { frames: n, ms }
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true })
let flagged = 0
for (const flow of flows) {
  if (only && flow.name !== only) continue
  const context = await browser.newContext({
    viewport: { width: flow.width ?? 1280, height: flow.height ?? 1700 },
    colorScheme: flow.scheme ?? "light",
  })
  await context.addInitScript(sampler)
  const page = await context.newPage()
  page.on("pageerror", (e) => console.log(`  PAGE ERROR ${e.message}`))
  console.log(`\n${flow.name}`)
  let index = 0
  for (const step of flow.steps) {
    index++
    const title = `${index}. ${step.do} ${step.url ?? step.name ?? step.label ?? step.text ?? step.value ?? ""}`
    const window_ = step.window ?? (step.do === "wait" ? false : 1500)
    if (window_ === false) {
      await act(page, step)
      continue
    }
    const stopFrames = saveFrames
      ? await grabFrames(page, join(".motion", flow.name, String(index)), window_)
      : null
    if (step.do === "goto") {
      await act(page, step)
      await page.waitForFunction(() => Boolean(window.__motion), null, { timeout: 30000 })
      await page.evaluate(() => window.__motion.start())
    } else {
      await target(page, step).waitFor({ timeout: 20000 }).catch(() => {})
      await page.evaluate(() => window.__motion.start())
      await act(page, step)
    }
    await page.waitForTimeout(window_)
    const report = await page.evaluate(
      (o) => window.__motion.stop(o),
      { jump: JUMP, appear: APPEAR },
    )
    const saved = stopFrames ? await stopFrames() : null
    const issues = report.issues as { kind: string; t: number; name: string; detail: string }[]
    flagged += issues.length
    console.log(`  ${title}: ${report.frames} frames${saved ? `, ${saved.frames} saved` : ""}, ${issues.length ? `${issues.length} flagged` : "clean"}`)
    for (const i of issues.slice(0, 12)) console.log(`    ${i.kind} at ${i.t}ms ${i.name}: ${i.detail}`)
    if (issues.length > 12) console.log(`    and ${issues.length - 12} more`)
  }
  await context.close()
}
await browser.close()
console.log(flagged ? `\n${flagged} flagged` : "\nAll clean")
process.exit(flagged ? 1 : 0)

declare global {
  interface Window {
    __motion: {
      start(): void
      stop(o: { jump: number; appear: number }): { frames: number; ms: number; issues: unknown[] }
    }
  }
}
