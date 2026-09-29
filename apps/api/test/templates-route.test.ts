import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import { marker } from "@repo/templates"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { mountTemplates } from "../src/routes/console/templates.js"
import type { Renderer } from "../src/templates/renderer.js"
import type {
  TemplateIdentity,
  TemplateStore,
  VersionDetail,
} from "../src/templates/store.js"

/**
 * The template upload routes (#234): which forms they accept, what they send
 * to the renderer, and the statuses they answer with. The store's own rules
 * are proven against Postgres in templates-db.test.ts.
 */
const TENANT = "11111111-1111-4111-8111-111111111111"
const ID = "22222222-2222-4222-8222-222222222222"
const NONCE = "abcdefghijkl"

const identity = (over: Partial<TemplateIdentity> = {}): TemplateIdentity => ({
  id: ID,
  name: "welcome",
  source: "upload",
  kind: "tsx",
  live_number: 1,
  live_sha256: null,
  ...over,
})

const detail = (over: Partial<VersionDetail & { unchanged: boolean }> = {}) => ({
  id: "v1",
  number: 2,
  kind: "tsx" as const,
  subject: null,
  variables: [],
  runtime: "test",
  path: "welcome.tsx",
  commit_sha: null,
  live: true,
  created_at: "2026-09-30T00:00:00.000Z",
  source: "",
  files: null,
  display: { html: null, text: null },
  unchanged: false,
  ...over,
})

function harness(
  opts: { identity?: TemplateIdentity | null; unchanged?: boolean } = {},
) {
  const createRenderedVersion = mock(async () =>
    detail({ unchanged: !!opts.unchanged }),
  )
  const store = {
    identity: async () => (opts.identity === undefined ? identity() : opts.identity),
    createRenderedVersion,
    create: async () => ({ conflict: true }),
  } as unknown as TemplateStore
  const compile = mock<Renderer["compile"]>(async () => ({
    ok: true,
    runtime: "test",
    subject: null,
    skeleton: { html: marker(NONCE, 0), text: "", nonce: NONCE, variables: [] },
  }))
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" })
    await next()
  })
  mountTemplates(app, {
    templates: store,
    templateRenderer: { compile },
  } as unknown as ConsoleDeps)
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  return { post, compile, createRenderedVersion }
}

const layout = { "components/layout.tsx": "export const Layout = 1" }
const entry = 'import { Layout } from "./components/layout"\nexport default () => null'

describe("uploading a version", () => {
  it("sends only the entry's closure to the renderer", async () => {
    const { post, compile, createRenderedVersion } = harness()
    const response = await post(`/templates/${ID}/versions`, {
      entry: "./welcome.tsx",
      files: { "welcome.tsx": entry, ...layout, "other.tsx": "x", "notes.md": "y" },
    })
    expect(response.status).toBe(201)
    expect(compile.mock.calls[0]?.[0]).toEqual({
      entry: "welcome.tsx",
      files: { "welcome.tsx": entry, ...layout },
    })
    expect(createRenderedVersion.mock.calls[0]).toMatchObject([
      TENANT,
      ID,
      { entry: "welcome.tsx", source: entry, origin: "upload" },
    ])
  })

  it("answers 200 and says so when the files are the live version's", async () => {
    const { post } = harness({ unchanged: true })
    const response = await post(`/templates/${ID}/versions`, { source: "x" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ unchanged: true })
  })

  it("refuses a missing import before the sandbox", async () => {
    const { post, compile } = harness()
    const response = await post(`/templates/${ID}/versions`, {
      entry: "welcome.tsx",
      files: { "welcome.tsx": entry },
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      problems: [
        "`./components/layout`, imported by `welcome.tsx`, is not in the files.",
      ],
    })
    expect(compile).not.toHaveBeenCalled()
  })

  it("refuses an upload to a template kept in GitHub", async () => {
    const { post, compile } = harness({ identity: identity({ source: "github" }) })
    const response = await post(`/templates/${ID}/versions`, { source: "x" })
    expect(response.status).toBe(422)
    expect(compile).not.toHaveBeenCalled()
  })

  it("does not accept a name where an id belongs", async () => {
    const { post } = harness()
    expect((await post("/templates/welcome/versions", { source: "x" })).status).toBe(
      404,
    )
  })
})

describe("uploading a folder", () => {
  it("answers 422 when nothing in it is a template", async () => {
    const { post } = harness()
    const response = await post("/templates/upload", { files: layout })
    expect(response.status).toBe(422)
  })

  it("answers 200 with an outcome per template", async () => {
    const { post } = harness({ identity: identity({ source: "managed" }) })
    const response = await post("/templates/upload", {
      files: {
        "welcome.tsx": `${entry}\nexport const x = 1\nconst T = () => null; T.PreviewProps = {}`,
        ...layout,
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: [{ name: "welcome", outcome: "refused" }],
      problems: [],
    })
  })
})
