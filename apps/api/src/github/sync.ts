import { sql } from "drizzle-orm"
import {
  MAX_SET_BYTES,
  MAX_SET_FILES,
  MANIFEST,
  closureOf,
  discoverTemplates,
  isCodeFile,
  normalizePath,
  pick,
  type Discovered,
  type FileSet,
} from "@repo/templates"
import type { Database } from "../db/client.js"
import type { Renderer } from "../templates/renderer.js"
import { fileSetHash, type TemplateStore } from "../templates/store.js"
import type { UploadOutcome } from "../templates/upload.js"
import type { GitHubApp } from "./client.js"
import type { GithubStore, RepoTemplate } from "./store.js"

/**
 * A repository's templates, brought in line with one commit (#235).
 *
 * ⚠ A PUSH TO THE TARGET BRANCH GOES LIVE. Each template whose files changed
 * gets a new version recorded with the commit and path, and becomes what
 * customers receive; unchanged ones get nothing. Every other branch is only
 * compiled, and the result is reported on the commit as a check run - so a
 * pull request says whether its templates would be accepted before it merges.
 *
 * ⚠ THE BRANCH HEAD WINS, NOT THE ORDER EVENTS ARRIVE IN. Two quick pushes can
 * reach us, or finish, out of order; a sync whose commit is no longer the head
 * of its branch does not version anything - it makes sure the head is synced
 * instead. Without that, a slow sync of an older commit could finish last and
 * put the older email live.
 *
 * ⚠ ONE SYNC PER REPOSITORY AT A TIME IN THIS PROCESS, queued. Across pods the
 * branch-head rule and the unchanged check make a duplicate harmless.
 */

export interface SyncDeps {
  db: Database
  github: GitHubApp
  store: GithubStore
  templates: TemplateStore
  renderer: Renderer
  log: { info(o: object, m: string): void; error(o: object, m: string): void }
}

type Repo = {
  id: string
  installationId: number
  fullName: string
  targetBranch: string
  directory: string
}

const CHECK_NAME = "i10 templates"

export function githubSyncer(deps: SyncDeps) {
  const queues = new Map<string, Promise<void>>()

  /** Runs `work` after everything already queued for the repository. */
  function serialized(repositoryId: string, work: () => Promise<void>): Promise<void> {
    const previous = queues.get(repositoryId) ?? Promise.resolve()
    const next = previous.then(work, work)
    queues.set(repositoryId, next)
    void next.finally(() => {
      if (queues.get(repositoryId) === next) queues.delete(repositoryId)
    })
    return next
  }

  /** The code files under the repository's template directory at `sha`, relative to it. */
  async function filesAt(
    repo: Repo,
    sha: string,
  ): Promise<{ files: FileSet } | { problems: string[] }> {
    const { entries, truncated } = await deps.github.tree(
      repo.installationId,
      repo.fullName,
      sha,
    )
    if (truncated) {
      return {
        problems: [
          "The repository is too large to read in one go. Set a template directory that holds only your emails.",
        ],
      }
    }
    const root = repo.directory ? `${normalizePath(repo.directory) ?? ""}/` : ""
    const wanted = entries.filter((e) => {
      if (e.type !== "blob" || !e.path.startsWith(root)) return false
      const rel = e.path.slice(root.length)
      return (
        (isCodeFile(rel) || rel === MANIFEST) &&
        !rel.split("/").includes("node_modules")
      )
    })
    if (wanted.length === 0) {
      return {
        problems: [
          `No code files under \`${repo.directory || "/"}\` at ${sha.slice(0, 7)}.`,
        ],
      }
    }
    const bytes = wanted.reduce((n, e) => n + (e.size ?? 0), 0)
    if (wanted.length > MAX_SET_FILES || bytes > MAX_SET_BYTES) {
      return {
        problems: [
          `\`${repo.directory || "/"}\` holds ${wanted.length} code files (${Math.round(bytes / 1024)} KiB); ` +
            `at most ${MAX_SET_FILES} files and ${MAX_SET_BYTES / 1024 / 1024} MiB are read.`,
        ],
      }
    }
    const files: FileSet = {}
    // Eight at a time: fast, and well inside GitHub's secondary rate limits.
    for (let i = 0; i < wanted.length; i += 8) {
      await Promise.all(
        wanted.slice(i, i + 8).map(async (e) => {
          files[e.path.slice(root.length)] = await deps.github.blob(
            repo.installationId,
            repo.fullName,
            e.sha,
          )
        }),
      )
    }
    return { files }
  }

  /** One template of the commit: refused, unchanged, or a version. */
  async function versionOne(
    tenantId: string,
    repo: Repo,
    sha: string,
    template: Discovered,
    files: FileSet,
    mine: RepoTemplate | undefined,
    apply: boolean,
  ): Promise<UploadOutcome> {
    const base = {
      path: template.path,
      name: template.name,
      folder: template.folder,
      template_id: mine?.id ?? null,
    }
    const refused = (problems: string[]): UploadOutcome => ({
      ...base,
      outcome: "refused",
      problems,
    })

    if (!mine) {
      const other = await deps.templates.identity(tenantId, template.name)
      if (other) {
        return refused([
          `A template named \`${template.name}\` already exists in this workspace and is not this file's. Rename the file, or that template.`,
        ])
      }
    }
    const closure = closureOf(template.path, files)
    if (closure.problems.length > 0) return refused(closure.problems)
    const set = pick(files, closure.paths)
    if (mine && mine.live_sha256 === fileSetHash(template.path, set)) {
      return { ...base, outcome: "unchanged", version: mine.live_number }
    }

    const compiled = await deps.renderer.compile({ entry: template.path, files: set })
    if (!compiled.ok) {
      return "problems" in compiled
        ? refused(compiled.problems)
        : {
            ...base,
            outcome: "unavailable",
            message: "Templates cannot be rendered right now.",
          }
    }
    // A check run stops here: it says what WOULD happen, and changes nothing.
    if (!apply) return { ...base, outcome: mine ? "versioned" : "created", version: 0 }

    let id = mine?.id
    if (!id) {
      const created = await deps.templates.create(tenantId, {
        name: template.name,
        folder: template.folder,
        kind: "tsx",
        source: "github",
        github: { repositoryId: repo.id, path: template.path },
      })
      if ("conflict" in created) {
        return refused([
          `A template named \`${template.name}\` was created by something else meanwhile.`,
        ])
      }
      id = created.id
    }
    const version = await deps.templates.createRenderedVersion(tenantId, id, {
      entry: template.path,
      source: set[template.path]!,
      files: set,
      skeleton: compiled.skeleton,
      runtime: compiled.runtime,
      subject: compiled.subject,
      commitSha: sha,
      origin: "github",
    })
    if (!version) return refused(["The template was deleted while it was syncing."])
    return {
      ...base,
      template_id: id,
      outcome: version.unchanged ? "unchanged" : mine ? "versioned" : "created",
      version: version.number,
    }
  }

  /** Compiles the commit's templates; versions them only when `apply`. */
  async function evaluate(tenantId: string, repo: Repo, sha: string, apply: boolean) {
    const read = await filesAt(repo, sha)
    if ("problems" in read) return { ok: false as const, problems: read.problems }
    const found = discoverTemplates(read.files)
    const mine = await deps.store.repoTemplates(tenantId, repo.id)
    const byPath = new Map(mine.map((t) => [t.path, t]))

    const outcomes: UploadOutcome[] = []
    for (const template of found.templates) {
      outcomes.push(
        await versionOne(
          tenantId,
          repo,
          sha,
          template,
          read.files,
          byPath.get(template.path),
          apply,
        ),
      )
    }
    if (apply) {
      const present = new Set(found.templates.map((t) => t.path))
      await deps.store.setRemoved(
        tenantId,
        mine.filter((t) => !present.has(t.path)).map((t) => t.id),
        true,
      )
      await deps.store.setRemoved(
        tenantId,
        mine.filter((t) => present.has(t.path) && t.removed).map((t) => t.id),
        false,
      )
    }
    return { ok: true as const, outcomes, problems: found.problems }
  }

  async function report(
    repo: Repo,
    sha: string,
    result: Awaited<ReturnType<typeof evaluate>>,
    live: boolean,
  ) {
    const refused = result.ok
      ? result.outcomes.filter((o) => o.outcome === "refused")
      : []
    const conclusion = !result.ok || refused.length > 0 ? "failure" : "success"
    const lines = result.ok
      ? result.outcomes.map((o) => {
          const what =
            o.outcome === "refused"
              ? `not accepted: ${o.problems.join(" ")}`
              : o.outcome === "unavailable"
                ? "not checked: the renderer was unavailable"
                : live
                  ? `${o.outcome}${"version" in o && o.version ? ` (v${o.version})` : ""}`
                  : "accepted"
          return `- \`${o.path}\` (${o.name}): ${what}`
        })
      : result.problems.map((p) => `- ${p}`)
    const extra =
      result.ok && result.problems.length
        ? ["", ...result.problems.map((p) => `- ${p}`)]
        : []
    try {
      await deps.github.createCheckRun(repo.installationId, repo.fullName, {
        head_sha: sha,
        name: CHECK_NAME,
        conclusion,
        title:
          conclusion === "success"
            ? live
              ? "Templates are live"
              : "Templates would be accepted"
            : `${refused.length || "Some"} template${refused.length === 1 ? "" : "s"} not accepted`,
        summary: [...lines, ...extra].join("\n") || "No templates found.",
      })
    } catch (error) {
      // A missing Checks permission must not fail the sync itself.
      deps.log.error(
        { err: error, repo: repo.fullName },
        "could not report a GitHub check run",
      )
    }
  }

  const syncer = {
    /** Runs a recorded sync. Never throws: failure is recorded on the sync. */
    run(tenantId: string, syncId: string, repositoryId: string): Promise<void> {
      return serialized(repositoryId, async () => {
        const claimed = await deps.store.claimSync(tenantId, syncId)
        if (!claimed) return
        const { sync, repo } = claimed
        try {
          if (repo.removedAt) {
            await deps.store.finishSync(tenantId, syncId, {
              status: "failed",
              problems: ["The GitHub App no longer has access to this repository."],
            })
            return
          }
          const head = await deps.github.branchHead(
            repo.installationId,
            repo.fullName,
            repo.targetBranch,
          )
          if (!head) {
            await deps.store.finishSync(tenantId, syncId, {
              status: "failed",
              problems: [`The repository has no branch \`${repo.targetBranch}\`.`],
            })
            return
          }
          if (head !== sync.commitSha) {
            // Superseded: sync the head instead, and never put the older commit live.
            await deps.store.finishSync(tenantId, syncId, {
              status: "done",
              problems: [
                `Superseded by ${head.slice(0, 7)}, the head of \`${repo.targetBranch}\`.`,
              ],
            })
            const next = await deps.store.createSync(tenantId, repo.id, head)
            void syncer.run(tenantId, next, repo.id)
            return
          }
          const result = await evaluate(tenantId, repo, sync.commitSha, true)
          await deps.store.finishSync(tenantId, syncId, {
            status: result.ok ? "done" : "failed",
            outcomes: result.ok
              ? (result.outcomes as unknown as Record<string, unknown>[])
              : undefined,
            problems: result.problems,
            repository: { id: repo.id, commitSha: sync.commitSha },
          })
          await report(repo, sync.commitSha, result, true)
          deps.log.info(
            { repo: repo.fullName, sha: sync.commitSha, ok: result.ok },
            "github templates synced",
          )
        } catch (error) {
          deps.log.error({ err: error, syncId }, "github sync failed")
          await deps.store
            .finishSync(tenantId, syncId, {
              status: "failed",
              problems: [
                "The sync could not finish. It will be retried on the next push, or resync by hand.",
              ],
            })
            .catch(() => {})
        }
      })
    },

    /** A new sync of the branch head, for a connect or a manual resync. */
    async syncHead(tenantId: string, repo: Repo): Promise<string | null> {
      const head = await deps.github.branchHead(
        repo.installationId,
        repo.fullName,
        repo.targetBranch,
      )
      if (!head) return null
      const id = await deps.store.createSync(tenantId, repo.id, head)
      void syncer.run(tenantId, id, repo.id)
      return id
    },

    /** Compiles a commit on another branch and reports it; writes nothing of ours. */
    check(tenantId: string, repo: Repo, sha: string): Promise<void> {
      return serialized(repo.id, async () => {
        try {
          await report(repo, sha, await evaluate(tenantId, repo, sha, false), false)
        } catch (error) {
          deps.log.error(
            { err: error, repo: repo.fullName, sha },
            "github check failed",
          )
        }
      })
    },

    /** Picks up syncs a restart or a crash left behind. */
    async recover(): Promise<number> {
      const due = (await deps.db.execute(
        sql`select tenant_id, sync_id from core.github_syncs_due(interval '2 minutes', interval '15 minutes', 20)`,
      )) as unknown as { tenant_id: string; sync_id: string }[]
      for (const { tenant_id, sync_id } of due) {
        const claimed = await deps.store.claimSync(tenant_id, sync_id)
        if (claimed) {
          // Claimed here only to learn the repository; `run` claims again.
          void syncer.run(tenant_id, sync_id, claimed.repo.id)
        }
      }
      return due.length
    },
  }
  return syncer
}

export type GithubSyncer = ReturnType<typeof githubSyncer>
