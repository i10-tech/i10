import { createHash, createHmac } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { marker, resolveTemplateSend } from "@repo/templates"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import type { CheckRun, GitHubApp } from "../src/github/client.js"
import { githubStore, type GithubStore } from "../src/github/store.js"
import { githubSyncer, type GithubSyncer } from "../src/github/sync.js"
import { createGithubWebhooks } from "../src/routes/github-events.js"
import type { Renderer } from "../src/templates/renderer.js"
import { templateStore, type TemplateStore } from "../src/templates/store.js"

/**
 * GitHub-connected templates (#235) end to end, against the real schema as
 * `i10_api`, with GitHub faked: commits, branch heads, trees and blobs.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/github-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

/** A fake repository: commits are file maps, branches point at commits. */
function fakeGitHub() {
  const commits = new Map<string, Record<string, string>>()
  const heads = new Map<string, string>()
  const checks: CheckRun[] = []
  const blobs = new Map<string, string>()
  const sha = (s: string) => createHash("sha1").update(s).digest("hex")
  const app: GitHubApp = {
    slug: "i10-test",
    installation: async () => ({ login: "acme", type: "Organization" }),
    repositories: async () => [],
    repository: async (_i, fullName) => ({
      id: 42,
      full_name: fullName,
      default_branch: "main",
      private: true,
    }),
    branchHead: async (_i, _r, branch) => heads.get(branch) ?? null,
    tree: async (_i, _r, commit) => ({
      truncated: false,
      entries: Object.entries(commits.get(commit) ?? {}).map(([path, text]) => {
        const s = sha(text)
        blobs.set(s, text)
        return { path, type: "blob" as const, sha: s, size: text.length }
      }),
    }),
    blob: async (_i, _r, s) => blobs.get(s)!,
    createCheckRun: async (_i, _r, run) => void checks.push(run),
    exchangeCode: async () => "user-token",
    userInstallationIds: async () => [],
  }
  return {
    app,
    checks,
    /** Commits the files on `branch` and returns the commit's sha. */
    push(branch: string, files: Record<string, string>) {
      const s = sha(JSON.stringify(files) + branch + commits.size)
      commits.set(s, files)
      heads.set(branch, s)
      return s
    },
  }
}

const renderer: Renderer = {
  async compile(input) {
    const entry = "files" in input ? input.files[input.entry]! : input.source
    if (entry.includes("REFUSE"))
      return { ok: false, problems: ["A variable is used as a condition."] }
    const nonce = "abcdefghijkl"
    return {
      ok: true,
      runtime: "test",
      subject: /subject = "([^"]+)"/.exec(entry)?.[1] ?? null,
      skeleton: {
        html: `<p>${entry.length}:${marker(nonce, 0)}</p>`,
        text: marker(nonce, 0),
        nonce,
        variables: [{ path: "name", preview: "Ada" }],
      },
    }
  },
}

/** A template file; `layout` is the import path of a shared layout, when it has one. */
const tpl = (heading: string, extra = "", layout?: string) =>
  `${layout ? `import { Layout } from "${layout}"\n` : ""}${extra}\nexport const subject = "Hi {{ name }}"\nexport default function T() { return null /* ${heading} */ }\nT.PreviewProps = { name: "Ada" }\n`

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database
let templates: TemplateStore
let store: GithubStore
const tenants: string[] = []
const log = { info: () => {}, error: () => {} }

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`g-${id.slice(0, 8)}`}, 'G', ${`gh-test-${id}`})`
  tenants.push(id)
  return id
}

suite("github-connected templates", () => {
  beforeAll(() => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(app, { schema }) as unknown as Database
    templates = templateStore(db)
    store = githubStore(db)
  })
  afterAll(async () => {
    if (tenants.length) await owner`delete from core.tenants where id = any(${tenants})`
    await owner.end()
    await app.end()
  })

  async function connected(installationId: number) {
    const gh = fakeGitHub()
    const syncer: GithubSyncer = githubSyncer({
      db,
      github: gh.app,
      store,
      templates,
      renderer,
      log,
    })
    const t = await workspace()
    expect(
      await store.bindInstallation(t, {
        installationId,
        login: "acme",
        type: "Organization",
      }),
    ).toBe("ok")
    const repo = await store.connect(t, {
      installationId,
      repoId: installationId * 10,
      fullName: "acme/emails",
      targetBranch: "main",
      directory: "emails",
    })
    if (!repo || "conflict" in repo) throw new Error("connect failed")
    const sync = async (sha: string) => {
      const id = await store.createSync(t, repo.id, sha)
      await syncer.run(t, id, repo.id)
      return (await store.syncs(t, repo.id))[0]!
    }
    return { gh, syncer, t, repo, sync }
  }

  const iid = () => Math.floor(Math.random() * 1e9) + 1

  it("versions a push to the target branch, and only what changed", async () => {
    const { gh, t, repo, sync } = await connected(iid())
    const files = {
      "emails/auth/welcome.tsx": tpl("welcome", "", "../components/layout"),
      "emails/auth/reset.tsx": tpl("reset", "", "../components/layout"),
      "emails/components/layout.tsx": "export const Layout = 1",
      "README.md": "not read",
      "src/app.ts": "not under the directory",
    }
    const first = await sync(gh.push("main", files))
    expect(first.status).toBe("done")
    expect(first.outcomes?.map((o) => `${o.name}:${o.outcome}`).sort()).toEqual([
      "reset:created",
      "welcome:created",
    ])

    const list = await templates.list(t)
    const w = list.find((x) => x.name === "welcome")!
    expect(w).toMatchObject({
      source: "github",
      folder: "auth",
      github: {
        repository: "acme/emails",
        directory: "emails",
        path: "auth/welcome.tsx",
        removed: false,
      },
    })
    const v1 = await templates.version(t, w.id, 1)
    expect(v1).toMatchObject({
      commit_sha: expect.any(String),
      path: "auth/welcome.tsx",
      subject: "Hi {{ name }}",
    })

    // Only reset changes: welcome is unchanged and gets no version.
    const second = await sync(
      gh.push("main", {
        ...files,
        "emails/auth/reset.tsx": tpl("reset v2", "", "../components/layout"),
      }),
    )
    expect(second.outcomes?.map((o) => `${o.name}:${o.outcome}`).sort()).toEqual([
      "reset:versioned",
      "welcome:unchanged",
    ])
    expect((await templates.get(t, w.id))?.versions).toBe(1)

    // The pushed version is what a send gets now.
    const sent = await resolveTemplateSend(
      { template: { id: "reset" }, variables: { name: "Bo" } },
      templates.lookup(t),
    )
    expect(sent.ok && sent.html).toContain("Bo")
    expect(gh.checks.at(-1)).toMatchObject({
      conclusion: "success",
      title: "Templates are live",
    })
    expect(repo.fullName).toBe("acme/emails")
  })

  it("keeps a removed file's template sending, marked removed; refuses with the reason", async () => {
    const { gh, t, sync } = await connected(iid())
    const base = {
      "emails/a.tsx": tpl("a"),
      "emails/components/layout.tsx": "export const Layout = 1",
    }
    await sync(gh.push("main", base))
    const after = await sync(
      gh.push("main", {
        "emails/components/layout.tsx": "export const Layout = 1",
        "emails/b.tsx": tpl("b", "// REFUSE"),
      }),
    )
    expect(after.outcomes).toEqual([
      expect.objectContaining({
        name: "b",
        outcome: "refused",
        problems: ["A variable is used as a condition."],
      }),
    ])
    const a = (await templates.list(t)).find((x) => x.name === "a")!
    expect(a.github?.removed).toBe(true)
    expect(a.version).toBe(1) // still live
    expect(gh.checks.at(-1)?.conclusion).toBe("failure")
  })

  it("never puts an older commit live: a superseded sync syncs the head instead", async () => {
    const { gh, t, repo, syncer } = await connected(iid())
    const old = gh.push("main", { "emails/x.tsx": tpl("old") })
    const head = gh.push("main", { "emails/x.tsx": tpl("new") })
    const id = await store.createSync(t, repo.id, old)
    await syncer.run(t, id, repo.id)
    // The follow-up for the head runs on the same queue; wait for it.
    await new Promise((r) => setTimeout(r, 200))
    const syncs = await store.syncs(t, repo.id)
    expect(syncs.find((s) => s.commit_sha === old)?.problems?.[0]).toContain(
      "Superseded",
    )
    expect(syncs.find((s) => s.commit_sha === head)?.status).toBe("done")
    const x = (await templates.list(t)).find((y) => y.name === "x")!
    expect((await templates.version(t, x.id, 1))?.commit_sha).toBe(head)
  })

  it("only checks other branches, writing nothing of ours", async () => {
    const { gh, t, repo, syncer } = await connected(iid())
    const sha = gh.push("feature", { "emails/new.tsx": tpl("new") })
    await syncer.check(t, repo, sha)
    expect(await templates.list(t)).toEqual([])
    expect(gh.checks.at(-1)).toMatchObject({
      head_sha: sha,
      conclusion: "success",
      title: "Templates would be accepted",
    })
  })

  it("binds an installation to one workspace only, and keeps each workspace's repositories its own", async () => {
    const installationId = iid()
    const { t } = await connected(installationId)
    const other = await workspace()
    expect(
      await store.bindInstallation(other, {
        installationId,
        login: "acme",
        type: "Organization",
      }),
    ).toBe("taken")
    expect(await store.repositories(other)).toEqual([])
    expect((await store.repositories(t)).length).toBe(1)
  })

  it("turns templates into uploads on disconnect, with every version kept", async () => {
    const { gh, t, repo, sync } = await connected(iid())
    await sync(gh.push("main", { "emails/keep.tsx": tpl("keep") }))
    expect(await store.disconnect(t, repo.id)).toBe(true)
    const keep = (await templates.list(t)).find((x) => x.name === "keep")!
    expect(keep).toMatchObject({ source: "upload", github: null, version: 1 })
  })

  it("routes a signed push to the right workspace and ignores an unsigned one", async () => {
    const installationId = iid()
    const { gh, t, repo, syncer } = await connected(installationId)
    const hooks = createGithubWebhooks({
      secret: "s".repeat(20),
      db,
      store,
      syncer,
      log,
    })
    const sha = gh.push("main", { "emails/hooked.tsx": tpl("hooked") })
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: sha,
      installation: { id: installationId },
      repository: { id: repo.repoId, full_name: "acme/emails" },
      commits: [{ added: ["emails/hooked.tsx"] }],
    })
    const post = (sig: string) =>
      hooks.request("/github", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": sig },
        body,
      })
    expect((await post("sha256=00")).status).toBe(401)
    const good = `sha256=${createHmac("sha256", "s".repeat(20)).update(body).digest("hex")}`
    expect((await post(good)).status).toBe(202)
    await new Promise((r) => setTimeout(r, 300))
    expect((await templates.list(t)).map((x) => x.name)).toEqual(["hooked"])
  })

  it("recovers a sync a restart left pending", async () => {
    const { gh, t, repo, syncer } = await connected(iid())
    const sha = gh.push("main", { "emails/late.tsx": tpl("late") })
    const id = await store.createSync(t, repo.id, sha)
    await owner`update core.github_syncs set created_at = now() - interval '5 minutes' where id = ${id}`
    expect(await syncer.recover()).toBeGreaterThanOrEqual(1)
    await new Promise((r) => setTimeout(r, 300))
    expect((await store.syncs(t, repo.id))[0]?.status).toBe("done")
  })
})
