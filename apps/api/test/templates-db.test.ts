import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { marker, resolveTemplateSend } from "@repo/templates"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { templateStore, type TemplateStore } from "../src/templates/store.js"

/**
 * Templates and versions (#160, #161) against the real schema as `i10_api`.
 *
 * Run it against a THROWAWAY database with every migration applied:
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/templates-db.test.ts
 *
 * The URL is the OWNER's (to seed tenants); the store logs in as `i10_api`, which
 * is what makes row security apply.
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

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

suite("templates", () => {
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

  it("publishes an HTML draft as version 1, sendable by id and by name", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "welcome" })
    if ("conflict" in created) throw new Error("conflict")
    await store.update(t, created.id, {
      subject: "Hi {{name}}",
      html: '<p>Hello {{ name }}</p><a href="{{url}}">go</a>',
    })

    const published = await store.publish(t, created.id)
    expect(published && "version" in published && published.version).toBe(1)

    for (const id of [created.id, "welcome"]) {
      const sent = await resolveTemplateSend(
        { template: { id }, variables: { name: "<Ada>", url: "javascript:alert(1)" } },
        store.lookup(t),
      )
      expect(sent).toMatchObject({
        ok: true,
        html: '<p>Hello &lt;Ada&gt;</p><a href="#">go</a>',
        subject: "Hi <Ada>",
      })
    }
  })

  it("never changes what is sent until the draft is published again", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "receipt" })
    if ("conflict" in created) throw new Error("conflict")
    await store.update(t, created.id, { subject: "s", html: "<p>one</p>" })
    await store.publish(t, created.id)
    await store.update(t, created.id, { html: "<p>two</p>" })

    const live = await resolveTemplateSend(
      { template: { id: "receipt" } },
      store.lookup(t),
    )
    expect(live.ok && live.html).toBe("<p>one</p>")

    await store.publish(t, created.id)
    const pinned = await resolveTemplateSend(
      { template: { id: "receipt", version: 1 } },
      store.lookup(t),
    )
    const latest = await resolveTemplateSend(
      { template: { id: "receipt" } },
      store.lookup(t),
    )
    expect(pinned.ok && pinned.html).toBe("<p>one</p>")
    expect(latest.ok && latest.html).toBe("<p>two</p>")

    // Rolling back is promoting the older version.
    await store.promote(t, created.id, 1)
    const back = await resolveTemplateSend(
      { template: { id: "receipt" } },
      store.lookup(t),
    )
    expect(back.ok && back.html).toBe("<p>one</p>")
  })

  it("stores a rendered TSX version and re-publishes it under a new subject without the sandbox", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "invite", kind: "tsx" })
    if ("conflict" in created) throw new Error("conflict")
    await store.update(t, created.id, { subject: "Join {{team}}" })

    const nonce = "abcdefghijkl"
    const version = await store.createRenderedVersion(t, created.id, {
      source: "export default () => null",
      runtime: "test",
      skeleton: {
        html: `<p>${marker(nonce, 0)}</p>`,
        text: marker(nonce, 0),
        nonce,
        variables: [{ path: "name", preview: "Ada" }],
      },
    })
    expect(version?.variables.map((v) => v.path)).toEqual(["name", "team"])

    await store.update(t, created.id, { subject: "Welcome" })
    const republished = await store.publish(t, created.id)
    expect(republished && "version" in republished && republished.version).toBe(2)

    // v2 no longer needs `team`, which only the old subject used.
    const sent = await resolveTemplateSend(
      { template: { id: "invite" }, variables: { name: "Bo" } },
      store.lookup(t),
    )
    expect(sent).toMatchObject({ ok: true, html: "<p>Bo</p>", subject: "Welcome" })
    expect((await store.version(t, created.id, 2))?.source).toBe(
      "export default () => null",
    )
  })

  it("is invisible to another workspace, by id and by name", async () => {
    const mine = await workspace()
    const theirs = await workspace()
    const created = await store.create(mine, { name: "secret" })
    if ("conflict" in created) throw new Error("conflict")
    await store.update(mine, created.id, { subject: "s", text: "x" })
    await store.publish(mine, created.id)

    expect(await store.get(theirs, created.id)).toBeNull()
    for (const id of [created.id, "secret"]) {
      const sent = await resolveTemplateSend({ template: { id } }, store.lookup(theirs))
      expect(sent).toMatchObject({ ok: false, error: "not_found" })
    }
  })

  it("refuses a placeholder inside a script", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "bad" })
    if ("conflict" in created) throw new Error("conflict")
    await store.update(t, created.id, { html: "<script>{{x}}</script>" })
    const result = await store.publish(t, created.id)
    expect(result && "problems" in result).toBe(true)
  })
})
