import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { marker, resolveTemplateSend } from "@repo/templates"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import type { Renderer } from "../src/templates/renderer.js"
import {
  fileSetHash,
  followsTitle,
  templateStore,
  type TemplateStore,
} from "../src/templates/store.js"
import { uploadTemplates } from "../src/templates/upload.js"
import { memoryStore } from "../src/content/object-store.js"
import {
  MAX_ASSET_BYTES,
  assetFolder,
  templateAssetStore,
} from "../src/templates/assets.js"

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
    // Just published: the draft is not ahead of what is live.
    if (published && "version" in published) {
      expect(published.updated_at).toBe(published.published_at!)
    }

    for (const id of [created.id, "welcome"]) {
      const sent = await resolveTemplateSend(
        {
          from: "t@acme.test",
          template: { id },
          variables: { name: "<Ada>", url: "javascript:alert(1)" },
        },
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
      { from: "t@acme.test", template: { id: "receipt" } },
      store.lookup(t),
    )
    expect(live.ok && live.html).toBe("<p>one</p>")

    await store.publish(t, created.id)
    const pinned = await resolveTemplateSend(
      { from: "t@acme.test", template: { id: "receipt", version: 1 } },
      store.lookup(t),
    )
    const latest = await resolveTemplateSend(
      { from: "t@acme.test", template: { id: "receipt" } },
      store.lookup(t),
    )
    expect(pinned.ok && pinned.html).toBe("<p>one</p>")
    expect(latest.ok && latest.html).toBe("<p>two</p>")

    // Rolling back is promoting the older version.
    await store.promote(t, created.id, 1)
    const back = await resolveTemplateSend(
      { from: "t@acme.test", template: { id: "receipt" } },
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
      { from: "t@acme.test", template: { id: "invite" }, variables: { name: "Bo" } },
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
      const sent = await resolveTemplateSend(
        { from: "t@acme.test", template: { id } },
        store.lookup(theirs),
      )
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

  it("records where a template is maintained", async () => {
    const t = await workspace()
    const html = await store.create(t, { name: "edited" })
    const tsx = await store.create(t, { name: "uploaded", kind: "tsx" })
    expect("source" in html && html.source).toBe("managed")
    expect("source" in tsx && tsx.source).toBe("upload")
    expect((await store.identity(t, "uploaded"))?.source).toBe("upload")
  })

  it("stores a template's files, and makes no version from the same files again", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "welcome", kind: "tsx" })
    if ("conflict" in created) throw new Error("conflict")
    const files = {
      "auth/welcome.tsx": "entry",
      "components/layout.tsx": "layout",
    }
    const input = {
      entry: "auth/welcome.tsx",
      source: "entry",
      files,
      runtime: "test",
      subject: "Welcome, {{ name }}",
      skeleton: skeleton(),
    }

    const first = await store.createRenderedVersion(t, created.id, input)
    expect(first).toMatchObject({
      number: 1,
      unchanged: false,
      path: "auth/welcome.tsx",
      files: { "components/layout.tsx": "layout" },
      subject: "Welcome, {{ name }}",
      display: { html: "<p>{{{ name }}}</p>" },
    })
    // The exported subject became the draft's.
    expect((await store.get(t, created.id))?.subject).toBe("Welcome, {{ name }}")

    const again = await store.createRenderedVersion(t, created.id, input)
    expect(again).toMatchObject({ number: 1, unchanged: true })
    expect((await store.identity(t, created.id))?.live_sha256).toBe(
      fileSetHash("auth/welcome.tsx", files),
    )

    const changed = await store.createRenderedVersion(t, created.id, {
      ...input,
      files: { ...files, "components/layout.tsx": "layout v2" },
    })
    expect(changed).toMatchObject({ number: 2, unchanged: false })

    // A subject-only publish keeps the files, so it is still "the same files".
    await store.update(t, created.id, { subject: "Hello" })
    await store.publish(t, created.id)
    const v3 = await store.version(t, created.id, 3)
    expect(v3).toMatchObject({
      subject: "Hello",
      path: "auth/welcome.tsx",
      files: { "components/layout.tsx": "layout v2" },
    })
  })

  it("uploads a folder: creates, skips what is unchanged, and refuses what is not its own", async () => {
    const t = await workspace()
    const managed = await store.create(t, { name: "receipt" })
    if ("conflict" in managed) throw new Error("conflict")

    const compiled: string[] = []
    const renderer: Renderer = {
      async compile(input) {
        if ("files" in input) compiled.push(input.entry)
        return { ok: true, skeleton: skeleton(), runtime: "test", subject: null }
      },
    }
    const tpl = (extra = "") =>
      `import { Layout } from "../components/layout"\n${extra}\nexport default function T() { return null }\nT.PreviewProps = { name: "Ada" }`
    const folder = {
      "auth/welcome.tsx": tpl(),
      "auth/reset.tsx": tpl(),
      "billing/receipt.tsx": tpl(),
      "broken/orphan.tsx": `import x from "./missing"\nexport default x\nx.PreviewProps = {}`,
      "components/layout.tsx": "export const Layout = 1",
      "README.md": "ignored",
    }

    const first = await uploadTemplates({ templates: store, renderer }, t, folder)
    if (!first.ok) throw new Error(first.problems.join("\n"))
    const by = Object.fromEntries(first.data.map((o) => [o.name, o]))
    expect(by.welcome).toMatchObject({ outcome: "created", version: 1, folder: "auth" })
    expect(by.reset).toMatchObject({ outcome: "created", version: 1 })
    expect(by.receipt).toMatchObject({ outcome: "refused", template_id: managed.id })
    expect(by.orphan).toMatchObject({
      outcome: "refused",
      problems: ["`./missing`, imported by `broken/orphan.tsx`, is not in the files."],
    })
    expect(compiled.sort()).toEqual(["auth/reset.tsx", "auth/welcome.tsx"])
    // The upload's directory became a folder, once, holding both.
    const folders = await store.folders(t)
    expect(folders.map((f) => [f.name, f.templates])).toEqual([["auth", 2]])

    // The same folder again renders nothing; a changed layout versions both.
    compiled.length = 0
    const second = await uploadTemplates({ templates: store, renderer }, t, folder)
    expect(
      second.ok && second.data.filter((o) => o.outcome === "unchanged").length,
    ).toBe(2)
    expect(compiled).toEqual([])

    const third = await uploadTemplates({ templates: store, renderer }, t, {
      ...folder,
      "components/layout.tsx": "export const Layout = 2",
    })
    expect(
      third.ok &&
        third.data.filter((o) => o.outcome === "versioned").map((o) => o.name),
    ).toEqual(["reset", "welcome"])

    // Another workspace sees none of it.
    const other = await workspace()
    expect(await store.identity(other, "welcome")).toBeNull()
  })

  it("says so when a folder has no templates in it", async () => {
    const t = await workspace()
    const result = await uploadTemplates(
      {
        templates: store,
        renderer: { compile: () => Promise.reject(new Error("not called")) },
      },
      t,
      { "components/layout.tsx": "export const Layout = 1" },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toStartWith("No templates were found")
  })

  it("resolves a send in one query once the version is cached, and never across workspaces (#238)", async () => {
    const statements: string[] = []
    const counted = postgres(API_URL!, {
      max: 1,
      onnotice: () => {},
      debug: (_conn, query) => {
        if (/^\s*select/i.test(query) && !query.includes("set_config"))
          statements.push(query)
      },
    })
    try {
      const cached = templateStore(drizzle(counted, { schema }) as unknown as Database)
      const t = await workspace()
      const created = await cached.create(t, { name: "cached" })
      if ("conflict" in created) throw new Error("conflict")
      await cached.update(t, created.id, { subject: "s", html: "<p>{{ name }}</p>" })
      await cached.publish(t, created.id)
      await cached.update(t, created.id, { html: "<p>two {{ name }}</p>" })
      await cached.publish(t, created.id)

      const send = (version?: number) =>
        resolveTemplateSend(
          {
            from: "t@acme.test",
            template: { id: "cached", version },
            variables: { name: "A" },
          },
          cached.lookup(t),
        )

      statements.length = 0
      expect((await send()).ok).toBe(true)
      expect(statements.length).toBe(2) // the reference, then the content
      statements.length = 0
      expect(await send()).toMatchObject({ ok: true, html: "<p>two A</p>" })
      expect(statements.length).toBe(1) // the reference only

      // Pinned is the same single query, not a template lookup and a version lookup.
      await send(1)
      statements.length = 0
      expect(await send(1)).toMatchObject({ ok: true, html: "<p>A</p>" })
      expect(statements.length).toBe(1)

      // A promote takes effect on the very next send.
      await cached.promote(t, created.id, 1)
      expect(await send()).toMatchObject({ ok: true, html: "<p>A</p>" })

      // Another workspace asking for this version id by id gets nothing, from
      // the cache or from Postgres.
      const other = await workspace()
      const versionId = (await cached.lookup(t).versionIdFor({ id: "cached" }))!
      expect(await cached.lookup(other).version(versionId)).toBeNull()
    } finally {
      await counted.end()
    }
  })

  it("publishes a visual template from its exported HTML, and keeps its document (#243)", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "visual", kind: "visual" })
    if ("conflict" in created) throw new Error("conflict")
    expect(created.source).toBe("managed")

    const design = { type: "doc", content: [{ type: "paragraph" }] }
    await store.update(t, created.id, {
      subject: "Hi {{ name }}",
      design,
      html: '<p>Hi {{ name }}</p><a href="{{ url }}">go</a>',
      text: "Hi {{ name }}",
    })
    const published = await store.publish(t, created.id)
    expect(published && "version" in published && published.version).toBe(1)

    const v1 = await store.version(t, created.id, 1)
    expect(v1).toMatchObject({
      kind: "visual",
      design,
      // Shown in the editor's spelling, whichever the template was written in.
      display: { html: '<p>Hi {{{ name }}}</p><a href="{{{ url }}}">go</a>' },
    })
    const sent = await resolveTemplateSend(
      {
        from: "t@acme.test",
        template: { id: "visual" },
        variables: { name: "<A>", url: "javascript:x" },
      },
      store.lookup(t),
    )
    expect(sent).toMatchObject({
      ok: true,
      subject: "Hi <A>",
      html: '<p>Hi &lt;A&gt;</p><a href="#">go</a>',
    })
  })

  it("stores a template image once per workspace, public, and deletes it with the workspace (#244)", async () => {
    const bucket = memoryStore()
    const assets = templateAssetStore({
      db: drizzle(app, { schema }) as unknown as Database,
      store: bucket,
      publicUrl: "https://assets.test/",
    })
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ])
    const a = await workspace()
    const b = await workspace()

    const first = await assets.upload(a, png)
    if (!first.ok) throw new Error(first.problem)
    expect(first.asset.url).toBe(
      `https://assets.test/${assetFolder(a)}/${first.asset.sha256}.png`,
    )
    expect(first.asset.url).not.toContain(a) // the public URL names no workspace
    expect((await assets.upload(a, png)).ok).toBe(true)
    expect(bucket.puts).toBe(1) // the same image again writes nothing

    // Another workspace gets its own object, and cannot see the first's row.
    const other = await assets.upload(b, png)
    expect(other.ok && other.asset.url).not.toBe(first.asset.url)
    expect(bucket.puts).toBe(2)
    const [visible] = await app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${b}, true)`
      return tx`select count(*)::int as n from core.template_assets where tenant_id = ${a}`
    })
    expect(visible?.n).toBe(0)

    expect(
      await assets.upload(a, new TextEncoder().encode("<svg onload=alert(1)>")),
    ).toEqual({
      ok: false,
      problem: "Only PNG, JPEG, GIF and WebP images can be used in emails.",
    })
    const big = new Uint8Array(MAX_ASSET_BYTES + 1)
    big.set(png)
    expect((await assets.upload(a, big)).ok).toBe(false)

    // A live workspace keeps its images; a deleted one loses them all.
    await owner`update core.tenants set status = 'deleted' where id = ${a}`
    expect(await assets.sweepDeleted()).toBe(1)
    expect(
      bucket.objects.has(first.asset.url.replace("https://assets.test/", "")),
    ).toBe(false)
    expect(bucket.objects.size).toBe(1)
    expect(await assets.sweepDeleted()).toBe(0)
  })
})

suite("template folders, defaults and fallbacks", () => {
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

  it("files templates in folders, moves them, and keeps them when a folder goes", async () => {
    const t = await workspace()
    const folder = await store.createFolder(t, "Onboarding")
    if ("conflict" in folder) throw new Error("conflict")
    expect(folder).toMatchObject({ name: "Onboarding", templates: 0 })
    expect(await store.createFolder(t, "Onboarding")).toEqual({ conflict: true })

    const a = await store.create(t, { name: "a", folderId: folder.id })
    const b = await store.create(t, { name: "b" })
    if ("conflict" in a || "conflict" in b) throw new Error("conflict")
    expect(a.folder_id).toBe(folder.id)
    expect(b.folder_id).toBeNull()

    expect(await store.move(t, [b.id], folder.id)).toBe(1)
    expect((await store.folders(t))[0]).toMatchObject({ templates: 2 })
    expect(await store.move(t, [a.id], null)).toBe(1)

    const renamed = await store.renameFolder(t, folder.id, "Welcome")
    expect(renamed && "name" in renamed && renamed.name).toBe("Welcome")

    expect(await store.deleteFolder(t, folder.id)).toBe(true)
    // The shared welcome template is listed beside the workspace's own.
    const left = (await store.list(t)).filter((x) => !x.shared)
    expect(left.map((x) => [x.name, x.folder_id])).toEqual([
      ["a", null],
      ["b", null],
    ])
  })

  it("never files a template under another workspace's folder", async () => {
    const mine = await workspace()
    const theirs = await workspace()
    const foreign = await store.createFolder(theirs, "Private")
    if ("conflict" in foreign) throw new Error("conflict")
    const t = await store.create(mine, { name: "x" })
    if ("conflict" in t) throw new Error("conflict")

    expect(await store.move(mine, [t.id], foreign.id)).toBeNull()
    expect(await store.update(mine, t.id, { folderId: foreign.id })).toEqual({
      problem: "No folder with that id.",
    })
    expect(await store.deleteFolder(mine, foreign.id)).toBe(false)
  })

  it("duplicates the draft and the live version under the first free name", async () => {
    const t = await workspace()
    const src = await store.create(t, { name: "welcome", kind: "visual" })
    if ("conflict" in src) throw new Error("conflict")
    await store.update(t, src.id, {
      subject: "Hi",
      from: "Acme <hi@acme.test>",
      html: "<p>v1</p>",
      design: { type: "doc" },
    })
    await store.publish(t, src.id)

    const one = await store.duplicate(t, src.id)
    const two = await store.duplicate(t, src.id)
    expect(one).toMatchObject({
      name: "welcome-copy",
      version: 1,
      kind: "visual",
      from: "Acme <hi@acme.test>",
    })
    expect(two?.name).toBe("welcome-copy-2")
    const sent = await resolveTemplateSend(
      { template: { id: "welcome-copy" } },
      store.lookup(t),
    )
    expect(sent).toMatchObject({
      ok: true,
      html: "<p>v1</p>",
      from: "Acme <hi@acme.test>",
    })
  })

  it("moves the alias with the name while it still is the name, to the first free one", async () => {
    const t = await workspace()
    const taken = await store.create(t, { title: "Onboarding" })
    const tpl = await store.create(t, { title: "Untitled Template" })
    if ("conflict" in taken || "conflict" in tpl) throw new Error("conflict")
    expect(taken.name).toBe("onboarding")
    expect(tpl.name).toBe("untitled-template")

    // `onboarding` is someone else's, so this one is the next free.
    const renamed = await store.update(t, tpl.id, { title: "Onboarding" })
    expect(renamed && "name" in renamed && renamed.name).toBe("onboarding-2")
    // Saving the same name again changes nothing.
    const again = await store.update(t, tpl.id, { title: "Onboarding", subject: "Hi" })
    expect(again && "name" in again && again.name).toBe("onboarding-2")
    const moved = await store.update(t, tpl.id, { title: "Password reset!" })
    expect(moved && "name" in moved && moved.name).toBe("password-reset")

    // An alias chosen by hand stays put.
    await store.update(t, tpl.id, { name: "reset-v1" })
    const kept = await store.update(t, tpl.id, { title: "Reset" })
    expect(kept && "name" in kept && kept.name).toBe("reset-v1")
  })

  it("publishes the sender, reply-to, preview line and fallbacks, and a send uses them", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "invite" })
    if ("conflict" in created) throw new Error("conflict")
    await store.update(t, created.id, {
      subject: "Join {{ team }}",
      from: "Acme <hi@acme.test>",
      replyTo: ["help@acme.test"],
      previewText: "You are invited, {{ name }}",
      variables: [
        { name: "name", type: "string", fallback: "there" },
        { name: "team", type: "string", fallback: null },
      ],
      html: "<html><body><p>Hello {{ name }}</p></body></html>",
    })
    const published = await store.publish(t, created.id)
    expect(published && "version" in published && published.version).toBe(1)

    // `name` has a fallback; `team` has none, so leaving it out refuses.
    const refused = await resolveTemplateSend(
      { template: { id: "invite" } },
      store.lookup(t),
    )
    expect(refused).toMatchObject({ ok: false, error: "invalid" })

    const sent = await resolveTemplateSend(
      { template: { id: "invite" }, variables: { team: "Ops" } },
      store.lookup(t),
    )
    expect(sent).toMatchObject({
      ok: true,
      subject: "Join Ops",
      from: "Acme <hi@acme.test>",
      replyTo: ["help@acme.test"],
    })
    expect(sent.ok && sent.html).toContain("You are invited, there")
    expect(sent.ok && sent.html).toContain("<p>Hello there</p>")

    // The draft keeps the HTML as written; only the version carries the line.
    const draft = await store.get(t, created.id)
    expect(draft?.html).toBe("<html><body><p>Hello {{ name }}</p></body></html>")
    expect(draft?.history[0]).toMatchObject({
      preview_text: "You are invited, {{ name }}",
    })
  })

  it("fills a test email from the draft: fallbacks, else the placeholder", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "t" })
    if ("conflict" in created) throw new Error("conflict")
    expect(await store.draftEmail(t, created.id)).toEqual({
      problems: ["Write the email before sending a test."],
    })
    await store.update(t, created.id, {
      subject: "For {{ who }}",
      variables: [{ name: "who", type: "string", fallback: "you" }],
      html: "<p>{{ who }} and {{ other }}</p>",
    })
    const email = await store.draftEmail(t, created.id)
    expect(email).toMatchObject({
      subject: "For you",
      // A variable with no fallback is left in the editor's spelling.
      html: "<p>you and {{{ other }}}</p>",
    })
  })

  it("lets only an editor template switch between the visual editor and HTML", async () => {
    const t = await workspace()
    const created = await store.create(t, { name: "k", kind: "visual" })
    if ("conflict" in created) throw new Error("conflict")
    const switched = await store.update(t, created.id, { kind: "html" })
    expect(switched && "kind" in switched && switched.kind).toBe("html")

    const uploaded = await store.create(t, { name: "u", kind: "tsx" })
    if ("conflict" in uploaded) throw new Error("conflict")
    expect(await store.update(t, uploaded.id, { kind: "html" })).toEqual({
      problem: "Only a template written here can switch editors.",
    })
  })
})

function skeleton() {
  const nonce = "abcdefghijkl"
  return {
    html: `<p>${marker(nonce, 0)}</p>`,
    text: marker(nonce, 0),
    nonce,
    variables: [{ path: "name", preview: "Ada" }],
  }
}

describe("followsTitle", () => {
  it("knows an alias made from a title, with or without the suffix that freed it", () => {
    expect(followsTitle("welcome", "Welcome")).toBe(true)
    expect(followsTitle("welcome-3", "Welcome")).toBe(true)
    expect(followsTitle("untitled-template", null)).toBe(true)
    expect(followsTitle("welcome-copy", "Welcome")).toBe(false)
    expect(followsTitle("welcome-v2", "Welcome")).toBe(false)
    expect(followsTitle("hello", "Welcome")).toBe(false)
  })
})
