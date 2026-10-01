import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { SendEmail } from "@repo/contracts"
import { resolveTemplateSend } from "@repo/templates"
import { createApp } from "../src/app.js"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import type { ConsoleDeps } from "../src/routes/console.js"
import { templateStore, type TemplateStore } from "../src/templates/store.js"

/**
 * The console's template routes end to end (#162): the whole app, the real
 * store, a real database as `i10_api` - everything the editor and the
 * templates page call, short of Clerk.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/templates-routes-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const BEARER = { Authorization: "Bearer stub", "Content-Type": "application/json" }

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let store: TemplateStore
let tenant: string
const sent: SendEmail[] = []
let app: ReturnType<typeof createApp>

const call = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(`/console${path}`, {
    method,
    headers: BEARER,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test reads its own shape
    body: (await response.json()) as Record<string, any>,
  }
}

suite("console template routes", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    store = templateStore(drizzle(db, { schema }) as unknown as Database)
    tenant = crypto.randomUUID()
    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${tenant}, ${`r-${tenant.slice(0, 8)}`}, 'R', ${`routes-${tenant}`})`
    app = createApp({
      console: {
        sessions: { verify: async () => ({ status: "signed-in", userId: "user_1" }) },
        tenants: { resolve: async () => tenant },
        templates: store,
        sendableFrom: async (_t, domains) =>
          new Set(domains.filter((d) => d === "acme.test")),
        sendTest: async (_t, payload) => {
          sent.push(payload)
          return { status: "accepted", ids: ["msg-test"] }
        },
        marketing: {} as ConsoleDeps["marketing"],
        queries: {} as ConsoleDeps["queries"],
        usage: {} as ConsoleDeps["usage"],
        onboarding: {} as ConsoleDeps["onboarding"],
        profile: {} as ConsoleDeps["profile"],
        log: { error: () => {}, warn: () => {} },
      } as ConsoleDeps,
    })
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id = ${tenant}`
    await owner.end()
    await db.end()
  })

  it("makes an untitled template, then untitled-template-2", async () => {
    const one = await call("POST", "/templates", { kind: "visual" })
    const two = await call("POST", "/templates", { kind: "visual" })
    expect(one).toMatchObject({
      status: 201,
      body: { name: "untitled-template", title: "Untitled Template" },
    })
    expect(two.body.name).toBe("untitled-template-2")
  })

  it("files templates in folders, moves them and deletes the folder without deleting them", async () => {
    const folder = await call("POST", "/template-folders", { name: "Onboarding" })
    expect(folder).toMatchObject({
      status: 201,
      body: { name: "Onboarding", templates: 0 },
    })
    expect(
      (await call("POST", "/template-folders", { name: "Onboarding" })).status,
    ).toBe(409)
    expect((await call("POST", "/template-folders", { name: "  " })).status).toBe(422)

    const t = await call("POST", "/templates", {
      name: "welcome",
      folder_id: folder.body.id,
    })
    expect(t.body.folder_id).toBe(folder.body.id)

    const list = await call("GET", "/templates")
    expect(list.body.folders).toEqual([
      expect.objectContaining({ name: "Onboarding", templates: 1 }),
    ])

    expect(
      await call("POST", "/templates/move", { ids: [t.body.id], folder_id: null }),
    ).toMatchObject({
      status: 200,
      body: { moved: 1 },
    })
    expect(
      (
        await call("POST", "/templates/move", {
          ids: [t.body.id],
          folder_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404)

    const renamed = await call("PATCH", `/template-folders/${folder.body.id}`, {
      name: "Welcome",
    })
    expect(renamed.body.name).toBe("Welcome")
    await call("POST", "/templates/move", {
      ids: [t.body.id],
      folder_id: folder.body.id,
    })
    expect((await call("DELETE", `/template-folders/${folder.body.id}`)).status).toBe(
      200,
    )
    const after = await call("GET", `/templates/${t.body.id}`)
    expect(after).toMatchObject({ status: 200, body: { folder_id: null } })
  })

  it("checks every draft field: a sender on a verified domain, reply-to, variables, the alias", async () => {
    const t = (await call("POST", "/templates", { name: "receipt" })).body
    const patch = (body: unknown) => call("PATCH", `/templates/${t.id}`, body)

    expect((await patch({ from: "Acme <hi@acme.test>" })).body.from).toBe(
      "Acme <hi@acme.test>",
    )
    const unverified = await patch({ from: "hi@elsewhere.test" })
    expect(unverified.status).toBe(422)
    expect(unverified.body.message).toContain("elsewhere.test is not a verified domain")
    expect((await patch({ from: "not an address" })).status).toBe(422)

    expect(
      (await patch({ reply_to: "a@acme.test, b@acme.test" })).body.reply_to,
    ).toEqual(["a@acme.test", "b@acme.test"])
    expect((await patch({ reply_to: ["nope"] })).status).toBe(422)

    const vars = await patch({
      variables: [
        { name: "amount", type: "number", fallback: "0" },
        { name: "plan", type: "string", fallback: "" },
      ],
    })
    expect(vars.body.variables).toEqual([
      { name: "amount", type: "number", fallback: "0" },
      { name: "plan", type: "string", fallback: null },
    ])
    expect(
      (await patch({ variables: [{ name: "1bad", type: "string" }] })).status,
    ).toBe(422)
    expect(
      (await patch({ variables: [{ name: "n", type: "number", fallback: "ten" }] }))
        .status,
    ).toBe(422)
    expect(
      (await patch({ variables: [{ name: "a" }, { name: "a" }] })).body.message,
    ).toContain("declared twice")

    expect((await patch({ name: "11111111-1111-4111-8111-111111111111" })).status).toBe(
      422,
    )
    expect((await patch({ name: "receipt-v2", title: "Receipt" })).body).toMatchObject({
      name: "receipt-v2",
      title: "Receipt",
    })
  })

  it("sends the draft as a test, fallbacks filled, and refuses without a sender", async () => {
    const t = (await call("POST", "/templates", { name: "invite" })).body
    expect(
      (await call("POST", `/templates/${t.id}/test`, { to: "me@acme.test" })).status,
    ).toBe(422)

    await call("PATCH", `/templates/${t.id}`, {
      subject: "Join {{ team }}",
      variables: [{ name: "team", type: "string", fallback: "us" }],
      html: "<p>Hi {{ who }}</p>",
    })
    const noSender = await call("POST", `/templates/${t.id}/test`, {
      to: "me@acme.test",
    })
    expect(noSender.body.message).toContain("From address")

    const ok = await call("POST", `/templates/${t.id}/test`, {
      to: ["me@acme.test"],
      from: "Acme <hi@acme.test>",
    })
    expect(ok.status).toBe(201)
    expect(sent.at(-1)).toMatchObject({
      from: "Acme <hi@acme.test>",
      to: ["me@acme.test"],
      subject: "[Test] Join us",
      html: "<p>Hi {{ who }}</p>",
    })
    expect((await call("POST", `/templates/${t.id}/test`, { to: "x" })).status).toBe(
      422,
    )
  })

  it("previews the draft for the list's thumbnails", async () => {
    const t = (await call("POST", "/templates", { name: "thumb" })).body
    expect((await call("GET", `/templates/${t.id}/draft-preview`)).body).toEqual({
      html: null,
      subject: null,
      text: null,
    })
    await call("PATCH", `/templates/${t.id}`, { html: "<p>Hello</p>" })
    expect((await call("GET", `/templates/${t.id}/draft-preview`)).body.html).toBe(
      "<p>Hello</p>",
    )
  })

  it("duplicates, deletes several at once, and a published template sends with its defaults", async () => {
    const t = (await call("POST", "/templates", { name: "digest", kind: "visual" }))
      .body
    await call("PATCH", `/templates/${t.id}`, {
      subject: "Your week",
      from: "Acme <hi@acme.test>",
      preview_text: "Five things",
      html: "<html><body><p>Week</p></body></html>",
      design: { type: "doc" },
    })
    const published = await call("POST", `/templates/${t.id}/publish`)
    expect(published.body).toMatchObject({ version: 1 })
    expect(published.body.updated_at).toBe(published.body.published_at)

    const sendable = await resolveTemplateSend(
      { template: { id: "digest" } },
      store.lookup(tenant),
    )
    expect(sendable).toMatchObject({
      ok: true,
      from: "Acme <hi@acme.test>",
      subject: "Your week",
    })
    expect(sendable.ok && sendable.html).toContain("Five things")

    const copy = await call("POST", `/templates/${t.id}/duplicate`)
    expect(copy).toMatchObject({
      status: 201,
      body: { name: "digest-copy", version: 1 },
    })

    const gone = await call("POST", "/templates/delete", {
      ids: [t.id, copy.body.id, "nonsense"],
    })
    expect(gone.body.deleted.sort()).toEqual([t.id, copy.body.id].sort())
    expect((await call("GET", `/templates/${t.id}`)).status).toBe(404)
  })
})
