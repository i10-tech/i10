/**
 * Drives the templates page's gestures with a real mouse, in both views: lifting
 * a template, a folder and a mixed selection onto folders and breadcrumb crumbs,
 * the refusals, a box (from the cards, the toolbar's empty space and below a
 * short list), a checkbox sweep, Esc mid-lift, and a click that still opens.
 *
 *   bun scripts/motion/drag.ts [--base http://localhost:3010]
 *
 * Against the preview (CONSOLE_PREVIEW=1, whose fake server keeps the folder tree
 * and answers a move with the real API's refusals). Exit code 1 means a scenario
 * failed. The last scenario runs the motion sampler over one folder drag and
 * prints what it flagged (snap, pop-in, pop-out).
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { chromium, type Locator } from "playwright-core"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const base = flag("base") ?? "http://localhost:3010"
const sampler = readFileSync(join(dirname(import.meta.path), "sampler.js"), "utf8")

// The preview's tree, by id: transactional holds only folders; security is two
// levels down; q1 is five, so its path folds.
const ID = (n: number) => `f01de700-0000-4000-8000-${String(n).padStart(12, "0")}`
const F = {
  auth: ID(1),
  billing: ID(2),
  lifecycle: ID(3),
  drafts: ID(4),
  transactional: ID(5),
  security: ID(6),
  archive: ID(7),
  y2025: ID(8),
  q1: ID(9),
}

type Pt = { x: number; y: number }
type View = "grid" | "table"
const failures: string[] = []
const results: string[] = []

function check(ok: boolean, what: string) {
  results.push(`${ok ? "pass" : "FAIL"}  ${what}`)
  if (!ok) failures.push(what)
}

const browser = await chromium.launch({ channel: "chrome", headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
await context.addInitScript(sampler)
const page = await context.newPage()
page.on("pageerror", (e) => failures.push(`page error: ${e.message}`))

async function open(view: View, path = "/templates", { cards = true } = {}) {
  await context.addCookies([{ name: "i10-view-templates", value: view, url: base }])
  await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 180000 })
  if (cards) await page.waitForSelector("[data-select-key]", { timeout: 120000 })
  else await page.waitForSelector("[data-slot=page]", { timeout: 120000 })
  await page.waitForFunction(() => !document.querySelector("main [data-bone-bar]"))
  await page.waitForTimeout(1200)
}

const center = async (l: Locator): Promise<Pt> => {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** Many small steps with a pause between them, like a hand. */
async function glide(from: Pt, to: Pt, { steps = 40, ms = 12 } = {}) {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    )
    if (ms) await page.waitForTimeout(ms)
  }
}

const rowSelector = (view: View) => (view === "grid" ? "main li" : "main tbody tr")
/** The folder's card or row, found by its id (it is the drop target's id too). */
const folderCard = (view: View, id: string) =>
  page.locator(`${rowSelector(view)}[data-drop-to="${id}"]`)
const crumb = (id: string) => page.locator(`main nav a[data-drop-to="${id}"]`)
const templates = () =>
  page.locator('[data-select-key]:not([data-select-key^="folder:"])')
const key = (id: string) => page.locator(`[data-select-key="${id}"]`)
const ticked = () =>
  page.locator("main [data-select-key] [role=checkbox][data-state=checked]").count()
const moveToast = () => page.getByText(/moved to/).first()
const search = () =>
  page
    .locator("[data-list-toolbar]")
    .getByRole("button", { name: /search/i })
    .first()

/** The lift that follows the pointer: its label, where it sits, and what art it carries. */
const chip = () =>
  page.evaluate(() => {
    const root = [...document.body.children].find(
      (c) =>
        c.getAttribute("aria-hidden") === "true" &&
        c.className.includes("fixed") &&
        c.textContent,
    ) as HTMLElement | undefined
    if (!root) return null
    const at = root.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/)
    return {
      text: root.textContent!,
      x: Number(at?.[1]),
      y: Number(at?.[2]),
      images: root.querySelectorAll("img").length,
      folders: root.querySelectorAll("[data-drag-art] svg").length,
    }
  })

/** Effective opacity of a card, product of itself and everything above it. */
const opacityOf = (id: string) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-select-key="${id}"]`)!
    let o = 1
    for (let n: Element | null = el; n; n = n.parentElement)
      o *= Number(getComputedStyle(n).opacity)
    const inner = el.firstElementChild
      ? Number(getComputedStyle(el.firstElementChild).opacity)
      : 1
    return o * inner
  }, id)

/** Lets go; the body of the move sent to the server, or null when nothing was sent. */
async function release(): Promise<string | null> {
  const sent = page
    .waitForRequest((r) => r.method() === "POST" && !!r.headers()["next-action"], {
      timeout: 2500,
    })
    .catch(() => null)
  await page.mouse.up()
  const request = await sent
  return request ? (request.postData() ?? "") : null
}

async function lift(from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(from, to)
  await page.waitForTimeout(450)
}

async function undo() {
  const button = page.getByRole("button", { name: "Undo" })
  if (await button.count()) await button.first().click()
  await page.waitForTimeout(900)
}

const coveredBy = (a: Pt, b: Pt) =>
  page.evaluate(
    (box) =>
      [...document.querySelectorAll("main [data-select-key]")].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.right > box.l && r.left < box.r && r.bottom > box.t && r.top < box.b
      }).length,
    {
      l: Math.min(a.x, b.x),
      r: Math.max(a.x, b.x),
      t: Math.min(a.y, b.y),
      b: Math.max(a.y, b.y),
    },
  )

async function dragTemplateOntoFolder(view: View) {
  await open(view)
  const tpl = templates().first()
  const id = (await tpl.getAttribute("data-select-key"))!
  const from = await center(tpl)
  const to = await center(folderCard(view, F.auth))
  await lift(from, to)
  const c = await chip()
  check(
    !!c && Math.abs(c.x - to.x) < 0.6 && Math.abs(c.y - to.y) < 0.6,
    `${view}: the lift sits exactly on the pointer (no lag)`,
  )
  check(
    !!c && c.images >= 1 && c.folders === 0,
    `${view}: a lifted template's preview is its email picture (${c?.images} images)`,
  )
  check(
    (await opacityOf(id)) < 0.6,
    `${view}: the origin card dims while it is carried`,
  )
  const body = await release()
  await moveToast()
    .waitFor({ timeout: 4000 })
    .catch(() => {})
  check(
    !!body && body.includes(id) && body.includes(F.auth),
    `${view}: a template dropped on a folder sends a move naming both`,
  )
  check(await moveToast().isVisible(), `${view}: the move toast shows`)
  await undo()
}

async function dragFolderIntoFolder(view: View) {
  await open(view)
  const before = await page.locator(`main [data-select-key^="folder:"]`).count()
  const target = folderCard(view, F.auth)
  const countBefore = (await target.innerText()).replace(/\s+/g, " ")
  const from = await center(folderCard(view, F.billing))
  const to = await center(target)
  await lift(from, to)
  const c = await chip()
  check(
    c?.text === "billing",
    `${view}: a lifted folder's label is its name (${c?.text})`,
  )
  check(
    !!c && c.folders >= 1,
    `${view}: a lifted folder's preview is its folder art (${c?.folders} drawings)`,
  )
  check(
    (await opacityOf(`folder:${F.billing}`)) < 0.6,
    `${view}: the folder dims while it is carried`,
  )
  const body = await release()
  await page.waitForTimeout(900)
  check(
    !!body &&
      body.includes(F.billing) &&
      body.includes(F.auth) &&
      body.includes("folderIds"),
    `${view}: the move request names the folder and its target`,
  )
  check(
    (await page.locator(`main [data-select-key^="folder:"]`).count()) === before - 1 &&
      (await folderCard(view, F.billing).count()) === 0,
    `${view}: the folder leaves this page`,
  )
  const countAfter = (await target.innerText()).replace(/\s+/g, " ")
  check(
    countAfter !== countBefore && /1 folder/.test(countAfter),
    `${view}: the target's count rises (${countBefore} -> ${countAfter})`,
  )
  check(await moveToast().isVisible(), `${view}: the toast shows`)
  await undo()
  check(
    (await folderCard(view, F.billing).count()) === 1,
    `${view}: Undo puts the folder back`,
  )
}

async function dragMixedSelection(view: View) {
  await open(view)
  const tpl = templates().first()
  const tplId = (await tpl.getAttribute("data-select-key"))!
  await folderCard(view, F.lifecycle).locator("[role=checkbox]").click()
  await tpl.locator("[role=checkbox]").click()
  check((await ticked()) === 2, `${view}: a folder and a template are ticked`)
  const from = await center(folderCard(view, F.lifecycle))
  const to = await center(folderCard(view, F.auth))
  await lift(from, to)
  const c = await chip()
  check(
    c?.text.startsWith("lifecycle") === true && c.text.endsWith("2"),
    `${view}: the label names the folder grabbed and the badge counts both (${c?.text})`,
  )
  check(
    !!c && c.folders >= 1 && c.images >= 1,
    `${view}: a mixed stack carries the folder's art and the template's picture`,
  )
  const body = await release()
  await page.waitForTimeout(900)
  check(
    !!body &&
      body.includes(F.lifecycle) &&
      body.includes(tplId) &&
      body.includes(F.auth),
    `${view}: one request moves the folder and the template together`,
  )
  await undo()
}

async function dropOnAncestorCrumb(view: View) {
  await open(view, `/templates/folder/${F.security}`)
  const crumbs = await page
    .locator("main nav [data-drop-to]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-drop-to")))
  check(
    JSON.stringify(crumbs) === JSON.stringify(["root", F.transactional]),
    `${view}: two levels deep, every ancestor crumb is a target and this folder is not (${crumbs})`,
  )
  const tpl = templates().first()
  const id = (await tpl.getAttribute("data-select-key"))!
  await lift(await center(tpl), await center(crumb(F.transactional)))
  const body = await release()
  await page.waitForTimeout(900)
  check(
    !!body && body.includes(id) && body.includes(F.transactional),
    `${view}: a template dropped on the parent crumb moves there`,
  )
  check((await key(id).count()) === 0, `${view}: and leaves this folder`)
  await undo()

  await lift(
    await center(folderCard(view, F.archive)),
    await center(page.locator("main nav [data-drop-to=root]")),
  )
  const body2 = await release()
  await page.waitForTimeout(900)
  check(
    !!body2 && body2.includes(F.archive) && body2.includes("null"),
    `${view}: a folder dropped on All templates moves to the top`,
  )
  await undo()
}

async function refusedDrops(view: View) {
  await open(view)
  const from = await center(folderCard(view, F.transactional))
  await lift(from, { x: from.x + 6, y: from.y + 4 })
  const body = await release()
  await page.waitForTimeout(700)
  check(body === null, `${view}: a folder dropped on itself sends nothing`)
  check(!(await moveToast().isVisible()), `${view}: and shows no toast`)
  check((await chip()) === null, `${view}: the lift flew back`)
  check(
    (await opacityOf(`folder:${F.transactional}`)) > 0.9,
    `${view}: and the folder is undimmed`,
  )

  // Search looks everywhere: folders at any depth, by name.
  await search().click()
  await page.keyboard.type("c")
  await page.waitForTimeout(700)
  check(
    (await folderCard(view, F.archive).count()) === 1,
    `${view}: search finds a folder three levels down by its name`,
  )
  for (const [name, id] of [
    ["its child", F.security],
    ["its grandchild", F.archive],
  ] as const) {
    const start = await center(folderCard(view, F.transactional))
    await lift(start, await center(folderCard(view, id)))
    const sent = await release()
    await page.waitForTimeout(700)
    check(sent === null, `${view}: a folder dropped on ${name} sends nothing`)
    check((await chip()) === null, `${view}: and the lift flies back (${name})`)
  }
}

async function breadcrumbFolds() {
  await open("grid", `/templates/folder/${F.q1}`, { cards: false })
  const nav = page.locator("main nav[aria-label=Breadcrumb] ol")
  const height = (await nav.boundingBox())!.height
  check(height < 60, `a five-deep path stays on one line (${Math.round(height)}px)`)
  check(
    (await nav.getByRole("button", { name: "Folders in between" }).count()) === 1,
    `the middle of a long path folds into one menu`,
  )
}

async function boxFromGap(view: View) {
  await open(view)
  let from: Pt
  let to: Pt
  if (view === "grid") {
    const a = (await folderCard(view, F.auth).boundingBox())!
    const b = (await folderCard(view, F.billing).boundingBox())!
    from = { x: (a.x + a.width + b.x) / 2, y: a.y + 20 }
    to = { x: b.x + b.width + 40, y: b.y + b.height + 200 }
  } else {
    const rows = await page
      .locator("main tbody tr[data-select-key]")
      .last()
      .boundingBox()
    from = { x: 700, y: rows!.y + rows!.height + 40 }
    to = { x: 700, y: rows!.y - 160 }
  }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(from, to, { steps: 30 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const got = await ticked()
  const expected = await coveredBy(from, to)
  check(
    got > 0 && got === expected,
    `${view}: a box from empty space selects what it touches (${got} of ${expected})`,
  )
}

async function boxFromToolbar(view: View) {
  await open(view)
  const bar = (await page.locator("[data-list-toolbar]").boundingBox())!
  const find = (await search().boundingBox())!
  const end = (await page.locator("[data-list-toolbar-end]").boundingBox())!
  const gap = (find.x + find.width + end.x) / 2
  const from = { x: gap, y: bar.y + bar.height / 2 }
  const to = { x: gap + 120, y: bar.y + bar.height + 520 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(from, to, { steps: 30 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const got = await ticked()
  const expected = await coveredBy(from, to)
  check(
    got > 0 && got === expected,
    `${view}: a box started in the toolbar's empty space selects what it covers (${got} of ${expected})`,
  )
}

async function boxFromBelowShortList(view: View) {
  await open(view, `/templates/folder/${F.security}`)
  const last = (await page.locator("main [data-select-key]").last().boundingBox())!
  const from = { x: 700, y: 1100 - 40 }
  const to = { x: 500, y: last.y + 10 }
  check(
    from.y > last.y + last.height + 100,
    `${view}: the list is short, with room below it`,
  )
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(from, to, { steps: 30 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const got = await ticked()
  const expected = await coveredBy(from, to)
  check(
    got > 0 && got === expected,
    `${view}: a box started below a short list selects what it covers (${got} of ${expected})`,
  )
}

async function marginBox(view: View) {
  await open(view)
  const first = (await page.locator("main [data-select-key]").first().boundingBox())!
  const from = { x: first.x - 14, y: first.y + 40 }
  const to = { x: first.x + first.width + 30, y: first.y + first.height + 30 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await glide(from, to, { steps: 20 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const got = await ticked()
  check(
    got > 0 && got === (await coveredBy(from, to)),
    `${view}: a box started in the margin beside the cards works (${got})`,
  )
}

async function controlsAndTitleStartNothing(view: View) {
  await open(view)
  const cards = (await page.locator("main [data-select-key]").first().boundingBox())!
  const press = async (l: Locator, name: string) => {
    const from = await center(l)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await glide(from, { x: from.x, y: cards.y + 200 }, { steps: 15 })
    const boxShown = await page.evaluate(
      () => !!document.querySelector("body > div.fixed.border-primary\\/60"),
    )
    await page.mouse.up()
    await page.waitForTimeout(200)
    check(
      (await ticked()) === 0 && !boxShown,
      `${view}: dragging from ${name} starts no box`,
    )
  }
  await press(page.getByRole("heading", { level: 1 }), "the page title")
  await press(page.locator("[data-slot=page-description]"), "the description")
  await press(search(), "the search button")
  await open(view)
  await search().click()
  const field = page.locator("[data-list-toolbar] input").first()
  await field.fill("welcome")
  check(
    (await field.inputValue()) === "welcome",
    `${view}: the search field still takes typing`,
  )
  await open(view)
  await page.getByRole("button", { name: "New" }).click()
  check(
    await page
      .getByRole("menuitem", { name: /Template/ })
      .first()
      .isVisible(),
    `${view}: the New menu still opens`,
  )
  await page.keyboard.press("Escape")
}

async function escMidLift(view: View) {
  await open(view)
  const tpl = templates().first()
  const id = (await tpl.getAttribute("data-select-key"))!
  const from = await center(tpl)
  const to = await center(folderCard(view, F.auth))
  await lift(from, to)
  await page.keyboard.press("Escape")
  await page.mouse.up()
  await page.waitForTimeout(700)
  check(!(await moveToast().isVisible()), `${view}: Esc mid-lift moves nothing`)
  check((await key(id).count()) === 1, `${view}: the template is still there`)
  check((await ticked()) === 0, `${view}: and the selection is as it was`)
  check(
    !page.url().includes("/folder/"),
    `${view}: and the release did not open anything`,
  )
}

async function liftOntoNothingCancels(view: View) {
  await open(view)
  const tpl = templates().first()
  const from = await center(tpl)
  const b = (await tpl.boundingBox())!
  await lift(from, { x: from.x + 40, y: b.y + b.height + 60 })
  const sent = await release()
  await page.waitForTimeout(600)
  check(
    sent === null && (await ticked()) === 0,
    `${view}: a lift released on nothing moves and selects nothing`,
  )
}

async function checkboxSweep(view: View) {
  await open(view)
  const boxes = page.locator("main [data-select-key] [role=checkbox]")
  const a = await center(boxes.nth(0))
  const b = await center(boxes.nth(2))
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await glide(a, b, { steps: 30 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  check(
    (await ticked()) >= 3,
    `${view}: pressing a checkbox and dragging ticks what it passes (${await ticked()})`,
  )
}

async function pressWithoutMovingStillOpens(view: View) {
  await open(view)
  const p = await center(folderCard(view, F.auth))
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForURL(/\/templates\/folder\//, { timeout: 15000 }).catch(() => {})
  check(
    /\/templates\/folder\//.test(page.url()),
    `${view}: a press without moving is still a click`,
  )
}

for (const view of ["grid", "table"] as const) {
  await dragTemplateOntoFolder(view)
  await dragFolderIntoFolder(view)
  await dragMixedSelection(view)
  await dropOnAncestorCrumb(view)
  await refusedDrops(view)
  await boxFromGap(view)
  await boxFromToolbar(view)
  await boxFromBelowShortList(view)
  await marginBox(view)
  await controlsAndTitleStartNothing(view)
  await escMidLift(view)
  await liftOntoNothingCancels(view)
  await checkboxSweep(view)
  await pressWithoutMovingStillOpens(view)
}
await breadcrumbFolds()

// The sampler over one folder lifted and dropped into another (grid).
await open("grid")
{
  const from = await center(folderCard("grid", F.billing))
  const to = await center(folderCard("grid", F.auth))
  await page.mouse.move(from.x, from.y)
  await page.evaluate(() =>
    (window as unknown as { __motion: { start(): void } }).__motion.start(),
  )
  await page.mouse.down()
  await glide(from, to, { steps: 60, ms: 16 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(900)
  const report = await page.evaluate(() =>
    (
      window as unknown as {
        __motion: {
          stop(o: { jump: number; appear: number }): {
            frames: number
            ms: number
            issues: { kind: string; t: number; name: string; detail: string }[]
          }
        }
      }
    ).__motion.stop({ jump: 5, appear: 14 }),
  )
  console.log(
    `sampler: ${report.frames} frames over ${report.ms}ms, ${report.issues.length} flagged`,
  )
  const tally = new Map<string, number>()
  for (const i of report.issues)
    tally.set(`${i.kind} ${i.name}`, (tally.get(`${i.kind} ${i.name}`) ?? 0) + 1)
  for (const [what, n] of tally) console.log(`  ${n}x ${what}`)
  for (const i of report.issues.slice(0, 3))
    console.log(`  first: ${i.kind.padEnd(8)} t=${i.t}ms ${i.name} ${i.detail}`)
  await undo()
}

console.log(results.join("\n"))
console.log(
  `${results.filter((r) => r.startsWith("pass")).length} passed, ${failures.length} failed`,
)
for (const f of failures) console.log(`  failed: ${f}`)
await browser.close()
process.exit(failures.length ? 1 : 0)
