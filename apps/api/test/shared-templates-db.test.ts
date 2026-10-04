import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { resolveTemplateSend } from "@repo/templates"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { SHARED_TEMPLATES } from "../src/templates/shared.js"
import { templateStore, type TemplateStore } from "../src/templates/store.js"

/**
 * The welcome template every workspace starts with (templates/shared.ts):
 * kept once, listed and sendable everywhere, and copied into a workspace only
 * when that workspace edits it.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/shared-templates-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const WELCOME = SHARED_TEMPLATES.find((t) => t.name === "welcome")!

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let store: TemplateStore
const tenants: string[] = []

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`t-${id.slice(0, 8)}`}, 'T', ${`tpl-test-${id}`})`
  tenants.push(id)
  return id
}

const send = (t: string, id: string, variables?: Record<string, unknown>) =>
  resolveTemplateSend(
    { from: "t@acme.test", template: { id }, ...(variables ? { variables } : {}) },
    store.lookup(t),
  )

suite("shared templates", () => {
  beforeAll(() => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {} })
    store = templateStore(drizzle(app, { schema }) as unknown as Database)
  })
  afterAll(async () => {
    if (tenants.length) await owner`delete from core.tenants where id = any(${tenants})`
    await owner.end()
    await app.end()
  })

  it("is listed and sendable in a new workspace with no row written", async () => {
    const t = await workspace()
    const listed = await store.list(t)
    expect(listed.map((x) => [x.name, x.shared])).toEqual([["welcome", true]])

    const sent = await send(t, "welcome", { name: "<Ada>", company: "Acme" })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(sent.versionId).toBe(WELCOME.versionId)
    expect(sent.subject).toBe("Welcome to Acme")
    expect(sent.html).toContain("Hi &lt;Ada&gt;,")
    expect(sent.html).not.toContain("{{")

    // Fallbacks fill what a send leaves out.
    const bare = await send(t, "welcome")
    expect(bare.ok && bare.subject).toBe("Welcome to the team")
    expect(bare.ok && bare.html).toContain("Hi there,")

    const [row] = await owner`select count(*)::int as n from core.templates
                                where tenant_id = ${t}`
    expect(row?.n).toBe(0)
  })

  it("becomes the workspace's own on the first edit, and only that workspace's", async () => {
    const mine = await workspace()
    const theirs = await workspace()

    const edited = await store.update(mine, WELCOME.templateId, {
      subject: "Hello {{ name }}",
    })
    if (!edited || "conflict" in edited || "problem" in edited)
      throw new Error("no copy")
    expect(edited.id).not.toBe(WELCOME.templateId)
    expect(edited.name).toBe("welcome")
    expect(edited.shared).toBe(false)
    expect(edited.version).toBe(1)

    // Until it is published the copy sends exactly what the shared one did.
    const before = await send(mine, "welcome", { company: "Acme" })
    expect(before.ok && before.subject).toBe("Welcome to Acme")
    expect(before.ok && before.versionId).not.toBe(WELCOME.versionId)

    await store.publish(mine, edited.id)
    const after = await send(mine, "welcome", { name: "Ada" })
    expect(after.ok && after.subject).toBe("Hello Ada")

    // The shared id now opens the copy, and the list shows only the copy.
    expect((await store.get(mine, WELCOME.templateId))?.id).toBe(edited.id)
    expect((await store.list(mine)).map((x) => [x.id, x.shared])).toEqual([
      [edited.id, false],
    ])

    // Another workspace is untouched.
    const other = await send(theirs, "welcome", { company: "Beta" })
    expect(other.ok && other.versionId).toBe(WELCOME.versionId)
    expect((await store.list(theirs))[0]?.shared).toBe(true)
  })

  it("makes one copy when two saves race", async () => {
    const t = await workspace()
    await Promise.all([
      store.update(t, WELCOME.templateId, { subject: "a" }),
      store.update(t, WELCOME.templateId, { subject: "b" }),
    ])
    const rows = await owner`select id from core.templates where tenant_id = ${t}`
    expect(rows.length).toBe(1)
  })

  it("is deleted for one workspace only, and stays deleted", async () => {
    const mine = await workspace()
    const theirs = await workspace()

    expect(await store.delete(mine, WELCOME.templateId)).toBe(true)
    expect(await store.list(mine)).toEqual([])
    expect(await store.get(mine, WELCOME.templateId)).toBeNull()
    expect((await send(mine, "welcome")).ok).toBe(false)

    // Nobody else loses it, and nothing of ours was written or removed.
    expect((await store.list(theirs))[0]?.shared).toBe(true)
    expect((await send(theirs, "welcome")).ok).toBe(true)
    const [row] = await owner`select count(*)::int as n from core.templates
                              where tenant_id = any(${[mine, theirs]})`
    expect(row?.n).toBe(0)

    // A template of their own called welcome is theirs as usual.
    const made = await store.create(mine, { name: "welcome" })
    if ("conflict" in made) throw new Error("conflict")
    expect((await store.list(mine)).map((x) => x.id)).toEqual([made.id])
  })

  it("deleting the workspace's own copy does not bring the shared one back", async () => {
    const t = await workspace()
    const copy = await store.update(t, WELCOME.templateId, { subject: "Mine" })
    if (!copy || "conflict" in copy || "problem" in copy) throw new Error("no copy")

    expect(await store.deleteMany(t, [copy.id])).toEqual([copy.id])
    expect(await store.list(t)).toEqual([])
    expect((await send(t, "welcome")).ok).toBe(false)
  })

  it("deleting by the shared id removes the workspace's copy, not a dismissal alone", async () => {
    const t = await workspace()
    const copy = await store.update(t, WELCOME.templateId, { subject: "Mine" })
    if (!copy || "conflict" in copy || "problem" in copy) throw new Error("no copy")

    expect(await store.delete(t, WELCOME.templateId)).toBe(true)
    const rows = await owner`select id from core.templates where tenant_id = ${t}`
    expect(rows.length).toBe(0)
    expect(await store.list(t)).toEqual([])
  })

  it("is not replaced by the shared one when the workspace's own has no version", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "welcome" })
    if ("conflict" in created) throw new Error("conflict")
    expect((await send(t, "welcome")).ok).toBe(false)
  })
})
