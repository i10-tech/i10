import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import {
  DIRECTORY_PROVIDERS,
  type Directory,
  type DirectoryStore,
  type DirectoryToken,
  type DirectoryUserRow,
  type OutboxEntry,
} from "../../identity/directory-ports.js"
import { hashSecret, newSecret } from "../../identity/model.js"
import { TOKEN_PREFIX } from "../../identity/scim.js"

/**
 * A workspace's SCIM directories (#342, sso.md 2.7), for the setup screen
 * (#340).
 *
 *   GET    /identity/directories                      each with its tokens and counts
 *   POST   /identity/directories                      { name, provider } (owner, step-up)
 *   GET    /identity/directories/:id
 *   PATCH  /identity/directories/:id                  { name?, enabled? } (step-up)
 *   POST   /identity/directories/:id/tokens           { overlapSeconds? } (owner, step-up)
 *   DELETE /identity/directories/:id/tokens/:tokenId  (step-up)
 *   GET    /identity/directories/:id/conflicts        who is not fully in, and why
 *   POST   /identity/directories/:id/conflicts/:userId/retry
 *
 * ⚠ A DIRECTORY CREATES AND DEPROVISIONS ACCOUNTS, SO WHO CONTROLS IT IS AN
 * OWNER'S, as the trust of a live SSO connection is (sso.md 2.14): making one,
 * issuing a token (the credential itself) and ENABLING one need
 * `owners:manage`. An admin (`sso:manage`) can read them, rename and disable
 * (tightening), and revoke a token. Everything that changes anything needs
 * step-up.
 *
 * ⚠ THE TOKEN IS SHOWN ONCE, IN THE RESPONSE THAT MAKES IT, and never stored,
 * returned again, logged or audited: only its hash is kept, and the audit
 * event names the token by id.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** At most this many directories in a workspace. */
export const MAX_DIRECTORIES = 10
const DAY_SECONDS = 24 * 60 * 60

export interface ScimConsoleDeps {
  store: DirectoryStore
  /** `<SCIM_BASE_URL>/<id>`: what to paste into the IdP. */
  baseUrl(directoryId: string): string
  /** Re-schedules a directory's unapplied entries; `force` skips the throttle. */
  kick(
    tenantId: string,
    directoryId: string,
    options?: { force?: boolean },
  ): Promise<unknown>
  schedule(tenantId: string, entries: readonly OutboxEntry[]): Promise<void>
}

const created = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(DIRECTORY_PROVIDERS).default("generic"),
  })
  .strict()

const patched = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((p) => p.name !== undefined || p.enabled !== undefined, {
    message: "Change the name or whether the directory is enabled.",
  })

const issued = z
  .object({
    // Seconds the older tokens keep working: zero ends them at once, a week at most.
    overlapSeconds: z
      .number()
      .int()
      .min(0)
      .max(7 * DAY_SECONDS)
      .default(DAY_SECONDS),
  })
  .strict()

const view = (directory: Directory, baseUrl: (id: string) => string) => ({
  id: directory.id,
  name: directory.name,
  provider: directory.provider,
  enabled: directory.enabled,
  baseUrl: baseUrl(directory.id),
  createdAt: directory.createdAt,
})

const tokenView = (t: DirectoryToken) => ({
  id: t.id,
  hint: t.hint,
  createdBy: t.createdBy,
  createdAt: t.createdAt,
  expiresAt: t.expiresAt,
  revokedAt: t.revokedAt,
  lastUsedAt: t.lastUsedAt,
})

const conflictView = (u: DirectoryUserRow) => ({
  id: u.id,
  userName: u.userName,
  displayName: u.displayName,
  email: u.email,
  active: u.active,
  deleted: u.deletedAt !== null,
  conflict: u.conflict,
  since: u.conflictAt,
})

export function mountIdentityScim(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  const wired = () => d.identity?.scim ?? null

  app.get("/identity/directories", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see directories."), 403)
    const { tenantId } = c.get("auth")
    const rows = await scim.store.directories(tenantId)
    for (const row of rows) void scim.kick(tenantId, row.id)
    return c.json({
      data: rows.map((r) => ({
        ...view(r, scim.baseUrl),
        tokens: r.tokens.map(tokenView),
        users: r.users,
        conflicts: r.conflicts,
        pending: r.pending,
      })),
      max: MAX_DIRECTORIES,
      providers: DIRECTORY_PROVIDERS,
    })
  })

  app.post("/identity/directories", requireFreshAuth, async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "owners:manage")))
      return c.json(forbidden("Only an owner can add a directory."), 403)
    const parsed = created.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid directory."),
        422,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    if ((await scim.store.directories(tenantId)).length >= MAX_DIRECTORIES)
      return c.json(
        validation(`A workspace can have at most ${MAX_DIRECTORIES} directories.`),
        422,
      )
    const made = await scim.store.createDirectory(tenantId, {
      ...parsed.data,
      createdBy: userId,
    })
    await d.identity!.store.record(tenantId, {
      type: "directory.created",
      actorUserId: userId,
      data: { directoryId: made.id, name: made.name, provider: made.provider },
    })
    return c.json(view(made, scim.baseUrl), 201)
  })

  const directoryOf = async (c: Context) => {
    const scim = wired()!
    const id = c.req.param("id") ?? ""
    if (!UUID.test(id)) return null
    const { tenantId } = c.get("auth")
    return scim.store.directory(tenantId, id)
  }

  app.get("/identity/directories/:id", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see directories."), 403)
    const { tenantId } = c.get("auth")
    const directory = await directoryOf(c)
    if (!directory) return c.json(notFound(), 404)
    void scim.kick(tenantId, directory.id)
    const summary = (await scim.store.directories(tenantId)).find(
      (r) => r.id === directory.id,
    )
    return c.json({
      ...view(directory, scim.baseUrl),
      tokens: (summary?.tokens ?? []).map(tokenView),
      users: summary?.users ?? 0,
      conflicts: summary?.conflicts ?? 0,
      pending: summary?.pending ?? 0,
    })
  })

  app.patch("/identity/directories/:id", requireFreshAuth, async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    const parsed = patched.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid change."),
        422,
      )
    // ⚠ ENABLING IS AN OWNER'S, DISABLING AN ADMIN'S: a directory that is on
    // provisions and deprovisions, one that is off cannot.
    const needed: Permission =
      parsed.data.enabled === true ? "owners:manage" : "sso:manage"
    if (!(await allowed(c, needed)))
      return c.json(
        forbidden(
          needed === "owners:manage"
            ? "Only an owner can enable a directory."
            : "Only an admin can change a directory.",
        ),
        403,
      )
    const before = await directoryOf(c)
    if (!before) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const after = await scim.store.updateDirectory(tenantId, before.id, parsed.data)
    if (!after) return c.json(notFound(), 404)
    await d.identity!.store.record(tenantId, {
      type: "directory.updated",
      actorUserId: userId,
      data: {
        directoryId: after.id,
        from: { name: before.name, enabled: before.enabled },
        to: { name: after.name, enabled: after.enabled },
      },
    })
    // What it said while it was off is replayed now (applied only if it is on).
    if (after.enabled && !before.enabled)
      await scim.kick(tenantId, after.id, { force: true })
    return c.json(view(after, scim.baseUrl))
  })

  app.post("/identity/directories/:id/tokens", requireFreshAuth, async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "owners:manage")))
      return c.json(forbidden("Only an owner can issue a directory token."), 403)
    const parsed = issued.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(parsed.error.issues[0]?.message ?? "Invalid request."),
        422,
      )
    const directory = await directoryOf(c)
    if (!directory) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const token = `${TOKEN_PREFIX}${newSecret()}`
    const made = await scim.store.issueToken(
      tenantId,
      directory.id,
      {
        tokenHash: hashSecret(token),
        hint: token.slice(0, TOKEN_PREFIX.length + 4),
        createdBy: userId,
        overlapMs: parsed.data.overlapSeconds * 1000,
      },
      new Date(),
    )
    if (!made) return c.json(notFound(), 404)
    await d.identity!.store.record(tenantId, {
      type: "directory.token_issued",
      actorUserId: userId,
      data: {
        directoryId: directory.id,
        tokenId: made.id,
        overlapSeconds: parsed.data.overlapSeconds,
      },
    })
    c.header("Cache-Control", "no-store")
    return c.json(
      { ...tokenView(made), token, baseUrl: scim.baseUrl(directory.id) },
      201,
    )
  })

  app.delete(
    "/identity/directories/:id/tokens/:tokenId",
    requireFreshAuth,
    async (c) => {
      const scim = wired()
      if (!scim) return c.json(notWired("SCIM directories"), 501)
      if (!(await allowed(c, "sso:manage")))
        return c.json(forbidden("Only an admin can revoke a directory token."), 403)
      const directory = await directoryOf(c)
      if (!directory) return c.json(notFound(), 404)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const tokenId = c.req.param("tokenId") ?? ""
      if (!UUID.test(tokenId)) return c.json(notFound(), 404)
      if (!(await scim.store.revokeToken(tenantId, directory.id, tokenId, new Date())))
        return c.json(notFound(), 404)
      await d.identity!.store.record(tenantId, {
        type: "directory.token_revoked",
        actorUserId: userId,
        data: { directoryId: directory.id, tokenId },
      })
      return c.json({ ok: true })
    },
  )

  app.get("/identity/directories/:id/conflicts", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see directories."), 403)
    const directory = await directoryOf(c)
    if (!directory) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    return c.json({
      data: (await scim.store.conflicts(tenantId, directory.id)).map(conflictView),
    })
  })

  app.post("/identity/directories/:id/conflicts/:userId/retry", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can retry a directory user."), 403)
    const directory = await directoryOf(c)
    if (!directory) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const entry = await scim.store.requeue(
      tenantId,
      directory.id,
      c.req.param("userId") ?? "",
    )
    if (!entry) return c.json(notFound(), 404)
    await scim.schedule(tenantId, [entry])
    await d.identity!.store.record(tenantId, {
      type: "directory.user_retried",
      actorUserId: userId,
      data: { directoryId: directory.id, directoryUserId: entry.directoryUserId },
    })
    return c.json({ ok: true })
  })
}
