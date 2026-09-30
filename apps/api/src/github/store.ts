import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import {
  githubInstallations,
  githubRepositories,
  githubSyncs,
  templateVersions,
  templates,
} from "../db/core.js"

/**
 * GitHub-connected templates' own state (#235): installations, repositories
 * and syncs, all under row security, all per workspace.
 *
 * ⚠ DISCONNECTING NEVER DELETES A TEMPLATE. Production code sends them by id;
 * a disconnected repository's templates become uploads, with every version
 * kept, and a new upload or a reconnect carries on from there.
 */

export interface InstallationRow {
  installation_id: number
  account_login: string
  account_type: string
  suspended: boolean
  created_at: string
}

export interface SyncRow {
  id: string
  commit_sha: string
  status: "pending" | "running" | "done" | "failed"
  outcomes: Record<string, unknown>[] | null
  problems: string[] | null
  created_at: string
  finished_at: string | null
}

export interface RepositoryRow {
  id: string
  installation_id: number
  repo_id: number
  full_name: string
  target_branch: string
  directory: string
  last_commit_sha: string | null
  last_synced_at: string | null
  removed: boolean
  templates: number
  last_sync: SyncRow | null
  created_at: string
}

export interface RepoTemplate {
  id: string
  name: string
  path: string
  removed: boolean
  live_sha256: string | null
  live_number: number
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]
const iso = (d: Date | null) => d?.toISOString() ?? null

function toSync(s: typeof githubSyncs.$inferSelect): SyncRow {
  return {
    id: s.id,
    commit_sha: s.commitSha,
    status: s.status,
    outcomes: s.outcomes,
    problems: s.problems,
    created_at: s.createdAt.toISOString(),
    finished_at: iso(s.finishedAt),
  }
}

export function githubStore(db: Database) {
  const repoRow = async (tx: Tx, r: typeof githubRepositories.$inferSelect) => {
    const [last] = await tx
      .select()
      .from(githubSyncs)
      .where(eq(githubSyncs.repositoryId, r.id))
      .orderBy(desc(githubSyncs.createdAt))
      .limit(1)
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(templates)
      .where(eq(templates.githubRepositoryId, r.id))
    return {
      id: r.id,
      installation_id: r.installationId,
      repo_id: r.repoId,
      full_name: r.fullName,
      target_branch: r.targetBranch,
      directory: r.directory,
      last_commit_sha: r.lastCommitSha,
      last_synced_at: iso(r.lastSyncedAt),
      removed: r.removedAt !== null,
      templates: n,
      last_sync: last ? toSync(last) : null,
      created_at: r.createdAt.toISOString(),
    } satisfies RepositoryRow
  }

  /** Templates of the given repositories become uploads, before the rows go. */
  const detach = (tx: Tx, repositoryIds: string[]) =>
    repositoryIds.length === 0
      ? Promise.resolve()
      : tx
          .update(templates)
          .set({ source: "upload", githubRepositoryId: null, updatedAt: new Date() })
          .where(inArray(templates.githubRepositoryId, repositoryIds))

  return {
    async installations(tenantId: string): Promise<InstallationRow[]> {
      return withTenant(db, tenantId, async (tx) =>
        (await tx.select().from(githubInstallations)).map((i) => ({
          installation_id: i.installationId,
          account_login: i.accountLogin,
          account_type: i.accountType,
          suspended: i.suspendedAt !== null,
          created_at: i.createdAt.toISOString(),
        })),
      )
    },

    /**
     * Binds an installation to a workspace. `taken` when another workspace
     * holds it: the unique index sees across tenants even though this
     * transaction cannot.
     */
    async bindInstallation(
      tenantId: string,
      i: { installationId: number; login: string; type: string },
    ): Promise<"ok" | "taken"> {
      try {
        await withTenant(db, tenantId, (tx) =>
          tx
            .insert(githubInstallations)
            .values({
              tenantId,
              installationId: i.installationId,
              accountLogin: i.login,
              accountType: i.type,
            })
            .onConflictDoUpdate({
              target: githubInstallations.installationId,
              set: { accountLogin: i.login, accountType: i.type, suspendedAt: null },
              // Only a row this workspace already owns may be refreshed.
              setWhere: eq(githubInstallations.tenantId, tenantId),
            }),
        )
      } catch (error) {
        if (isRlsViolation(error)) return "taken"
        throw error
      }
      // An upsert whose `setWhere` refused writes nothing and raises nothing.
      const mine = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
          .where(eq(githubInstallations.installationId, i.installationId)),
      )
      return mine.length > 0 ? "ok" : "taken"
    },

    async removeInstallation(tenantId: string, installationId: number) {
      await withTenant(db, tenantId, async (tx) => {
        const repos = await tx
          .select({ id: githubRepositories.id })
          .from(githubRepositories)
          .where(eq(githubRepositories.installationId, installationId))
        await detach(
          tx,
          repos.map((r) => r.id),
        )
        await tx
          .delete(githubInstallations)
          .where(eq(githubInstallations.installationId, installationId))
      })
    },

    async setSuspended(tenantId: string, installationId: number, suspended: boolean) {
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(githubInstallations)
          .set({ suspendedAt: suspended ? new Date() : null })
          .where(eq(githubInstallations.installationId, installationId)),
      )
    },

    async repositories(tenantId: string): Promise<RepositoryRow[]> {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(githubRepositories)
          .orderBy(githubRepositories.fullName)
        return Promise.all(rows.map((r) => repoRow(tx, r)))
      })
    },

    async repository(tenantId: string, id: string) {
      return withTenant(db, tenantId, async (tx) => {
        const [r] = await tx
          .select()
          .from(githubRepositories)
          .where(eq(githubRepositories.id, id))
          .limit(1)
        return r ?? null
      })
    },

    /** Null when the installation is not this workspace's; `conflict` if already connected. */
    async connect(
      tenantId: string,
      input: {
        installationId: number
        repoId: number
        fullName: string
        targetBranch: string
        directory: string
      },
    ) {
      return withTenant(db, tenantId, async (tx) => {
        const [owned] = await tx
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
          .where(eq(githubInstallations.installationId, input.installationId))
        if (!owned) return null
        const [row] = await tx
          .insert(githubRepositories)
          .values({ tenantId, ...input })
          .onConflictDoNothing({
            target: [githubRepositories.tenantId, githubRepositories.repoId],
          })
          .returning()
        return row ?? ({ conflict: true } as const)
      })
    },

    async updateRepository(
      tenantId: string,
      id: string,
      patch: { targetBranch?: string; directory?: string; fullName?: string },
    ) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(githubRepositories)
          .set(patch)
          .where(eq(githubRepositories.id, id))
          .returning()
        return row ?? null
      })
    },

    async disconnect(tenantId: string, id: string): Promise<boolean> {
      return withTenant(db, tenantId, async (tx) => {
        await detach(tx, [id])
        const gone = await tx
          .delete(githubRepositories)
          .where(eq(githubRepositories.id, id))
          .returning({ id: githubRepositories.id })
        return gone.length > 0
      })
    },

    async markRemoved(tenantId: string, installationId: number, repoIds: number[]) {
      if (repoIds.length === 0) return
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(githubRepositories)
          .set({ removedAt: new Date() })
          .where(
            and(
              eq(githubRepositories.installationId, installationId),
              inArray(githubRepositories.repoId, repoIds),
            ),
          ),
      )
    },

    async createSync(tenantId: string, repositoryId: string, commitSha: string) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(githubSyncs)
          .values({ tenantId, repositoryId, commitSha })
          .returning({ id: githubSyncs.id })
        return row!.id
      })
    },

    /**
     * Marks a sync running and returns it with its repository.
     *
     * ⚠ A RUNNING SYNC CAN BE CLAIMED AGAIN, because the recovery sweep only
     * offers one whose process has been gone for minutes. Everything a sync
     * writes is idempotent (an unchanged template makes no version), so
     * running one twice costs time, not correctness.
     */
    async claimSync(tenantId: string, syncId: string) {
      return withTenant(db, tenantId, async (tx) => {
        const [sync] = await tx
          .update(githubSyncs)
          .set({ status: "running", startedAt: new Date() })
          .where(
            and(
              eq(githubSyncs.id, syncId),
              inArray(githubSyncs.status, ["pending", "running"]),
            ),
          )
          .returning()
        if (!sync) return null
        const [repo] = await tx
          .select()
          .from(githubRepositories)
          .where(eq(githubRepositories.id, sync.repositoryId))
        return repo ? { sync, repo } : null
      })
    },

    async finishSync(
      tenantId: string,
      syncId: string,
      result: {
        status: "done" | "failed"
        outcomes?: Record<string, unknown>[]
        problems?: string[]
        repository?: { id: string; commitSha: string }
      },
    ) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .update(githubSyncs)
          .set({
            status: result.status,
            outcomes: result.outcomes ?? null,
            problems: result.problems ?? null,
            finishedAt: new Date(),
          })
          .where(eq(githubSyncs.id, syncId))
        if (result.repository) {
          await tx
            .update(githubRepositories)
            .set({
              lastCommitSha: result.repository.commitSha,
              lastSyncedAt: new Date(),
            })
            .where(eq(githubRepositories.id, result.repository.id))
        }
      })
    },

    async syncs(
      tenantId: string,
      repositoryId: string,
      limit = 20,
    ): Promise<SyncRow[]> {
      return withTenant(db, tenantId, async (tx) =>
        (
          await tx
            .select()
            .from(githubSyncs)
            .where(eq(githubSyncs.repositoryId, repositoryId))
            .orderBy(desc(githubSyncs.createdAt))
            .limit(limit)
        ).map(toSync),
      )
    },

    /** The templates a repository made, with what is live, for a sync to compare against. */
    async repoTemplates(
      tenantId: string,
      repositoryId: string,
    ): Promise<RepoTemplate[]> {
      return withTenant(db, tenantId, async (tx) =>
        (
          await tx
            .select({
              id: templates.id,
              name: templates.name,
              path: templates.path,
              removedAt: templates.removedAt,
              liveSha256: templateVersions.sourceSha256,
              liveNumber: templateVersions.number,
            })
            .from(templates)
            .leftJoin(
              templateVersions,
              eq(templateVersions.id, templates.liveVersionId),
            )
            .where(eq(templates.githubRepositoryId, repositoryId))
        ).map((t) => ({
          id: t.id,
          name: t.name,
          path: t.path ?? "",
          removed: t.removedAt !== null,
          live_sha256: t.liveSha256,
          live_number: t.liveNumber ?? 0,
        })),
      )
    },

    /** Marks templates gone from the repository, or back in it. */
    async setRemoved(tenantId: string, ids: string[], removed: boolean) {
      if (ids.length === 0) return
      await withTenant(db, tenantId, (tx) =>
        tx
          .update(templates)
          .set({ removedAt: removed ? new Date() : null })
          .where(
            and(
              inArray(templates.id, ids),
              removed
                ? isNull(templates.removedAt)
                : sql`${templates.removedAt} is not null`,
            ),
          ),
      )
    },
  }
}

export type GithubStore = ReturnType<typeof githubStore>

/** Postgres 42501: the row security policy refused a write. */
function isRlsViolation(error: unknown): boolean {
  let e: unknown = error
  while (e && typeof e === "object") {
    const code = (e as { code?: string }).code
    if (code === "42501" || code === "23505") return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}
