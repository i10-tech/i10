import type { Hono } from "hono"
import { normalizePath } from "@repo/templates"
import { signState, verifyState } from "../../github/connect.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"

/**
 * Connecting GitHub repositories to a workspace's templates (#235).
 *
 * ⚠ AN INSTALLATION IS BOUND ONLY AFTER PROOF - see github/connect.ts. The
 * `installation_id` GitHub sends back is a URL parameter; it is accepted only
 * when the signed-in person's own GitHub token lists it.
 */
export function mountGithub(app: Hono, d: ConsoleDeps) {
  const unwired = () => notWired("GitHub-connected templates")
  const branchOk = (b: string) =>
    /^[A-Za-z0-9._/-]{1,255}$/.test(b) && !b.includes("..")
  const dirOf = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null
    const trimmed = raw.trim().replace(/^\/+|\/+$/g, "")
    return trimmed === "" ? "" : normalizePath(trimmed)
  }

  app.get("/github", async (c) => {
    if (!d.github) {
      return c.json({ configured: false, installations: [], repositories: [] })
    }
    const { tenantId } = c.get("auth")
    const [installations, repositories] = await Promise.all([
      d.github.store.installations(tenantId),
      d.github.store.repositories(tenantId),
    ])
    return c.json({
      configured: true,
      app_slug: d.github.app.slug,
      installations,
      repositories,
    })
  })

  /** Where "Connect GitHub" goes: GitHub's install page, carrying a signed state. */
  app.post("/github/install", (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const state = signState(c.get("auth").tenantId, d.github.clientSecret)
    return c.json({
      url: `https://github.com/apps/${encodeURIComponent(d.github.app.slug)}/installations/new?state=${encodeURIComponent(state)}`,
    })
  })

  /** The setup redirect's parameters, checked, and the installation bound. */
  app.post("/github/installations", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const installationId = Number(body?.installation_id)
    const code = typeof body?.code === "string" ? body.code : ""
    const state = typeof body?.state === "string" ? body.state : ""
    if (
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      !code ||
      !state
    ) {
      return c.json(
        validation("`installation_id`, `code` and `state` are required."),
        422,
      )
    }
    if (verifyState(state, d.github.clientSecret) !== tenantId) {
      return c.json(
        validation(
          "This link was made for another workspace, or has expired. Connect GitHub again.",
        ),
        422,
      )
    }
    const userToken = await d.github.app.exchangeCode(code)
    if (!userToken) {
      return c.json(
        validation("GitHub did not accept the sign-in. Connect GitHub again."),
        422,
      )
    }
    const visible = await d.github.app.userInstallationIds(userToken)
    if (!visible.includes(installationId)) {
      return c.json(
        {
          statusCode: 403 as const,
          name: "forbidden" as const,
          message: "Your GitHub account cannot see that installation.",
        },
        403,
      )
    }
    const account = await d.github.app.installation(installationId)
    if (!account) return c.json(notFound("GitHub has no such installation."), 404)
    const bound = await d.github.store.bindInstallation(tenantId, {
      installationId,
      login: account.login,
      type: account.type,
    })
    if (bound === "taken") {
      return c.json(
        {
          statusCode: 409 as const,
          name: "conflict" as const,
          message: `The i10 app on ${account.login} is already connected to another workspace.`,
        },
        409,
      )
    }
    return c.json(
      { installation_id: installationId, account_login: account.login },
      201,
    )
  })

  app.get("/github/installations/:id/repositories", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const installationId = Number(c.req.param("id"))
    const mine = await d.github.store.installations(c.get("auth").tenantId)
    if (!mine.some((i) => i.installation_id === installationId))
      return c.json(notFound(), 404)
    const repos = await d.github.app.repositories(installationId)
    return c.json({
      data: repos.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        default_branch: r.default_branch,
        private: r.private,
      })),
    })
  })

  app.post("/github/repositories", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const installationId = Number(body?.installation_id)
    const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : ""
    const directory = body?.directory === undefined ? "emails" : dirOf(body.directory)
    if (!Number.isSafeInteger(installationId) || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      return c.json(
        validation("`installation_id` and `full_name` (owner/name) are required."),
        422,
      )
    }
    if (directory === null)
      return c.json(validation("`directory` is not a path in the repository."), 422)
    const mine = await d.github.store.installations(tenantId)
    if (!mine.some((i) => i.installation_id === installationId))
      return c.json(notFound(), 404)

    // The repository as GitHub says it is, through this installation - which
    // is also the check that the installation can reach it at all.
    const repo = await d.github.app.repository(installationId, fullName)
    if (!repo) {
      return c.json(
        notFound(
          "The app cannot see that repository. Grant it access on GitHub first.",
        ),
        404,
      )
    }
    const targetBranch =
      typeof body?.target_branch === "string" && body.target_branch.trim()
        ? body.target_branch.trim()
        : repo.default_branch
    if (!branchOk(targetBranch))
      return c.json(validation("`target_branch` is not a branch name."), 422)

    const row = await d.github.store.connect(tenantId, {
      installationId,
      repoId: repo.id,
      fullName: repo.full_name,
      targetBranch,
      directory,
    })
    if (!row) return c.json(notFound(), 404)
    if ("conflict" in row) {
      return c.json(
        {
          statusCode: 409 as const,
          name: "conflict" as const,
          message: "That repository is already connected.",
        },
        409,
      )
    }
    const syncId = await d.github.syncer.syncHead(tenantId, row)
    return c.json({ id: row.id, sync_id: syncId }, 201)
  })

  app.patch("/github/repositories/:id", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const patch: { targetBranch?: string; directory?: string } = {}
    if (body?.target_branch !== undefined) {
      const b = typeof body.target_branch === "string" ? body.target_branch.trim() : ""
      if (!branchOk(b))
        return c.json(validation("`target_branch` is not a branch name."), 422)
      patch.targetBranch = b
    }
    if (body?.directory !== undefined) {
      const dir = dirOf(body.directory)
      if (dir === null)
        return c.json(validation("`directory` is not a path in the repository."), 422)
      patch.directory = dir
    }
    const row = await d.github.store.updateRepository(
      tenantId,
      c.req.param("id"),
      patch,
    )
    if (!row) return c.json(notFound(), 404)
    // New branch or directory: what is live should follow it now, not at the next push.
    const syncId = await d.github.syncer.syncHead(tenantId, row)
    return c.json({ id: row.id, sync_id: syncId })
  })

  app.post("/github/repositories/:id/sync", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const { tenantId } = c.get("auth")
    const row = await d.github.store.repository(tenantId, c.req.param("id"))
    if (!row) return c.json(notFound(), 404)
    const syncId = await d.github.syncer.syncHead(tenantId, row)
    return syncId
      ? c.json({ sync_id: syncId }, 202)
      : c.json(validation(`The repository has no branch \`${row.targetBranch}\`.`), 422)
  })

  app.get("/github/repositories/:id/syncs", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const { tenantId } = c.get("auth")
    const row = await d.github.store.repository(tenantId, c.req.param("id"))
    if (!row) return c.json(notFound(), 404)
    return c.json({ data: await d.github.store.syncs(tenantId, row.id) })
  })

  /**
   * ⚠ THE TEMPLATES STAY. Production code sends them by id; they become
   * uploads with every version kept, and stop following the repository.
   */
  app.delete("/github/repositories/:id", async (c) => {
    if (!d.github) return c.json(unwired(), 501)
    const ok = await d.github.store.disconnect(
      c.get("auth").tenantId,
      c.req.param("id"),
    )
    return ok
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound(), 404)
  })
}
