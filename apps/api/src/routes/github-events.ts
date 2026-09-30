import { Hono } from "hono"
import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { verifyWebhook } from "../github/connect.js"
import type { GithubStore } from "../github/store.js"
import type { GithubSyncer } from "../github/sync.js"

/**
 * `POST /webhooks/github` - the GitHub App's events (#235).
 *
 * ⚠ THE SIGNATURE IS THE WHOLE OF THE AUTHORIZATION, as for Polar. Nothing in
 * the body is believed until `X-Hub-Signature-256` matches the raw bytes.
 *
 * ⚠ AND WHOSE EVENT IT IS COMES FROM OUR TABLES, NEVER THE PAYLOAD. GitHub
 * names an installation and a repository; the definer functions in 0094 map
 * those to the workspaces that connected them, and every write after that
 * runs as that workspace, under row security.
 *
 * ⚠ IT ANSWERS AT ONCE. GitHub gives a webhook ten seconds; a sync reads a
 * tree, blobs and renders every changed template. The sync is recorded first,
 * so a deploy mid-way loses nothing - see `recover` in github/sync.ts.
 */
export interface GithubWebhookDeps {
  secret: string
  db: Database
  store: GithubStore
  syncer: GithubSyncer
  log: { error(o: object, m: string): void }
}

interface PushEvent {
  ref?: string
  after?: string
  deleted?: boolean
  installation?: { id?: number }
  repository?: { id?: number; full_name?: string }
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[]
}

export function createGithubWebhooks(deps?: GithubWebhookDeps) {
  const app = new Hono()

  app.post("/github", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "GitHub-connected templates are not configured.",
        },
        503,
      )
    }
    const body = await c.req.text()
    if (!verifyWebhook(body, c.req.header("x-hub-signature-256"), deps.secret)) {
      return c.json(
        { statusCode: 401, name: "invalid_signature", message: "Bad signature." },
        401,
      )
    }
    const event = c.req.header("x-github-event") ?? ""
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(body) as Record<string, unknown>
    } catch {
      return c.json(
        { statusCode: 400, name: "invalid_json", message: "Not JSON." },
        400,
      )
    }

    try {
      if (event === "push") await onPush(deps, payload as PushEvent)
      else if (event === "installation") await onInstallation(deps, payload)
      else if (event === "installation_repositories")
        await onRepositories(deps, payload)
    } catch (error) {
      // ⚠ STILL A 2XX: GitHub would redeliver, and the failure is ours to fix,
      // not the payload's. Logged loudly instead.
      deps.log.error({ err: error, event }, "github webhook could not be handled")
    }
    return c.json({ received: true }, 202)
  })

  return app
}

async function owners(db: Database, installationId: number) {
  return (
    (await db.execute(
      sql`select tenant_id from core.github_installation_owner(${installationId})`,
    )) as unknown as { tenant_id: string }[]
  ).map((r) => r.tenant_id)
}

async function onPush(deps: GithubWebhookDeps, e: PushEvent) {
  const installationId = e.installation?.id
  const repoId = e.repository?.id
  if (
    !installationId ||
    !repoId ||
    !e.after ||
    e.deleted ||
    !e.ref?.startsWith("refs/heads/")
  ) {
    return
  }
  const branch = e.ref.slice("refs/heads/".length)
  const connections = (await deps.db.execute(
    sql`select tenant_id, repository_id from core.github_connections(${installationId}, ${repoId})`,
  )) as unknown as { tenant_id: string; repository_id: string }[]

  for (const { tenant_id: tenantId, repository_id: id } of connections) {
    const repo = await deps.store.repository(tenantId, id)
    if (!repo) continue
    // Renames reach us here first; keep the name the links use current.
    if (e.repository?.full_name && e.repository.full_name !== repo.fullName) {
      await deps.store.updateRepository(tenantId, id, {
        fullName: e.repository.full_name,
      })
      repo.fullName = e.repository.full_name
    }
    // ⚠ ONLY PUSHES THAT TOUCH THE TEMPLATE DIRECTORY. GitHub lists changed
    // paths for up to twenty commits; past that, or with no list, assume yes.
    const root = repo.directory ? `${repo.directory.replace(/\/+$/, "")}/` : ""
    const commits = e.commits ?? []
    const touched =
      commits.length === 0 ||
      commits.length >= 20 ||
      commits.some((c) =>
        [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((p) =>
          p.startsWith(root),
        ),
      )
    if (!touched) continue

    if (branch === repo.targetBranch) {
      const syncId = await deps.store.createSync(tenantId, id, e.after)
      void deps.syncer.run(tenantId, syncId, id)
    } else {
      void deps.syncer.check(tenantId, repo, e.after)
    }
  }
}

async function onInstallation(deps: GithubWebhookDeps, p: Record<string, unknown>) {
  const installationId = (p.installation as { id?: number } | undefined)?.id
  if (!installationId) return
  for (const tenantId of await owners(deps.db, installationId)) {
    if (p.action === "deleted")
      await deps.store.removeInstallation(tenantId, installationId)
    else if (p.action === "suspend")
      await deps.store.setSuspended(tenantId, installationId, true)
    else if (p.action === "unsuspend")
      await deps.store.setSuspended(tenantId, installationId, false)
  }
}

async function onRepositories(deps: GithubWebhookDeps, p: Record<string, unknown>) {
  const installationId = (p.installation as { id?: number } | undefined)?.id
  const removed = ((p.repositories_removed as { id?: number }[] | undefined) ?? [])
    .map((r) => r.id)
    .filter((id): id is number => typeof id === "number")
  if (!installationId || removed.length === 0) return
  for (const tenantId of await owners(deps.db, installationId)) {
    await deps.store.markRemoved(tenantId, installationId, removed)
  }
}
