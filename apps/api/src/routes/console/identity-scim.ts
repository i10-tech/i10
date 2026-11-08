import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import {
  DIRECTORY_PROVIDERS,
  GOOGLE_WATCH_EVENTS,
  type Directory,
  type DirectoryStore,
  type DirectoryToken,
  type DirectoryUserRow,
  type OutboxEntry,
} from "../../identity/directory-ports.js"
import { safeError } from "../../identity/directory.js"
import {
  GOOGLE_DIRECTORY_SCOPES,
  emailDomain,
  normaliseDomain,
  type CheckAccessResult,
  type GoogleServiceAccount,
} from "../../identity/google-directory.js"
import { hashSecret, newSecret, normaliseEmail } from "../../identity/model.js"
import { refuseFeature } from "./identity-features.js"
import { TOKEN_PREFIX } from "../../identity/scim.js"

/**
 * A workspace's SCIM and Google Workspace directories (#342, #343, sso.md 2.7
 * and 2.9), for the setup screen (#340).
 *
 *   GET    /identity/directories                      each with its tokens and counts
 *   POST   /identity/directories                      { name, provider, adminEmail?, domain? } (owner, step-up)
 *   GET    /identity/directories/:id
 *   PATCH  /identity/directories/:id                  { name?, enabled?, adminEmail?, domain? } (step-up)
 *   POST   /identity/directories/:id/check            Google Directory API check (sso:manage)
 *   POST   /identity/directories/:id/confirm-removals { removedUsers } (owner, step-up)
 *   POST   /identity/directories/:id/tokens           { overlapSeconds? } (owner, step-up)
 *   DELETE /identity/directories/:id/tokens/:tokenId  (step-up)
 *   GET    /identity/directories/:id/conflicts        who is not fully in, and why
 *   GET    /identity/directories/:id/groups           its groups with member counts (sso:manage)
 *   POST   /identity/directories/:id/conflicts/:userId/retry
 *
 * ⚠ A DIRECTORY CREATES AND DEPROVISIONS ACCOUNTS, SO WHO CONTROLS IT IS AN
 * OWNER'S, as the trust of a live SSO connection is (sso.md 2.14): making one,
 * setting or changing a Google directory's admin address or domain, issuing a
 * token (the credential itself) and ENABLING one need `owners:manage`. An
 * admin (`sso:manage`) can read them, check Google access, rename and disable
 * (tightening), and revoke a token. Everything that changes anything needs
 * step-up.
 *
 * ⚠ THE TOKEN IS SHOWN ONCE, IN THE RESPONSE THAT MAKES IT, and never stored,
 * returned again, logged or audited: only its hash is kept, and the audit
 * event names the token by id.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const conflict = (message: string) =>
  ({ statusCode: 409, name: "conflict" as const, message }) as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** At most this many directories in a workspace. */
export const MAX_DIRECTORIES = 10
const DAY_SECONDS = 24 * 60 * 60

export const GOOGLE_UNAVAILABLE_REASON =
  "Google Workspace directory sync is not available because GOOGLE_DIRECTORY_SERVICE_ACCOUNT is not configured on this deployment."

export interface GoogleConsoleDeps {
  serviceAccount: Pick<GoogleServiceAccount, "clientEmail" | "clientId"> | null
  scopes?: readonly string[]
  checkAccess(input: {
    tenantId: string
    adminEmail: string | null
    domain: string | null
  }): Promise<CheckAccessResult>
  schedulePull(tenantId: string, directoryId: string): Promise<void>
  stopChannels(
    tenantId: string,
    directoryId: string,
    adminEmail?: string | null,
  ): Promise<unknown>
}

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
  google?: GoogleConsoleDeps
}

const created = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(DIRECTORY_PROVIDERS).default("generic"),
    adminEmail: z.string().trim().min(1).max(320).optional(),
    domain: z.string().trim().min(1).max(253).optional(),
  })
  .strict()

const patched = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    createMailboxes: z.boolean().optional(),
    adminEmail: z.string().trim().min(1).max(320).optional(),
    domain: z.string().trim().min(1).max(253).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.name !== undefined ||
      p.enabled !== undefined ||
      p.createMailboxes !== undefined ||
      p.adminEmail !== undefined ||
      p.domain !== undefined,
    {
      message:
        "Change the name, Google Workspace settings, or whether the directory is enabled.",
    },
  )

// An owner confirms the number they were shown, so it is the whole body.
const confirmedRemovals = z
  .object({ removedUsers: z.number().int().min(1).max(1_000_000) })
  .strict()

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

interface GoogleSyncDetailView {
  missingScopes?: readonly string[]
  removedUsers?: number
  existingUsers?: number
  keptUsers?: number
}

const nonNegativeInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined

async function googleSyncDetailsByDirectory(
  d: ConsoleDeps,
  scim: ScimConsoleDeps,
  tenantId: string,
  directories: readonly Directory[],
): Promise<ReadonlyMap<string, GoogleSyncDetailView>> {
  const targets = directories.filter(
    (dir) =>
      dir.provider === "google" &&
      dir.lastSyncStatus === "failed" &&
      (dir.lastSyncError === "scope_missing" || dir.lastSyncError === "large_drop"),
  )
  const out = new Map<string, GoogleSyncDetailView>()
  if (targets.length === 0 || !d.identity) return out
  const allowedScopes = new Set(scim.google?.scopes ?? GOOGLE_DIRECTORY_SCOPES)
  const events = await d.identity.store.events(tenantId, { limit: 100 })
  for (const dir of targets) {
    const match = events.find(
      (e) =>
        e.type === "directory.sync_failed" &&
        e.reason === dir.lastSyncError &&
        e.data.directoryId === dir.id,
    )
    if (!match) continue
    const rawScopes = Array.isArray(match.data.missingScopes)
      ? match.data.missingScopes.filter(
          (s): s is string => typeof s === "string" && allowedScopes.has(s),
        )
      : []
    const removedUsers = nonNegativeInt(match.data.removedUsers)
    const existingUsers = nonNegativeInt(match.data.existingUsers)
    const keptUsers = nonNegativeInt(match.data.keptUsers)
    const detail: GoogleSyncDetailView = {
      ...(rawScopes.length > 0 ? { missingScopes: rawScopes } : {}),
      ...(removedUsers !== undefined ? { removedUsers } : {}),
      ...(existingUsers !== undefined ? { existingUsers } : {}),
      ...(keptUsers !== undefined ? { keptUsers } : {}),
    }
    if (Object.keys(detail).length > 0) out.set(dir.id, detail)
  }
  return out
}

async function googleWatchInfoByDirectory(
  scim: ScimConsoleDeps,
  tenantId: string,
  directories: readonly Directory[],
  now: Date,
): Promise<Map<string, { liveUpdates: boolean; watchStatus: "ok" | "failed" | null }>> {
  const out = new Map<
    string,
    { liveUpdates: boolean; watchStatus: "ok" | "failed" | null }
  >()
  const targets = directories.filter((dir) => dir.provider === "google")
  for (const dir of targets) {
    if (!dir.enabled) {
      out.set(dir.id, { liveUpdates: false, watchStatus: null })
      continue
    }
    const channels = await scim.store.watchChannels(tenantId, dir.id)
    const active = channels.filter((c) => c.expiresAt.getTime() > now.getTime())
    const events = new Set(active.map((c) => c.event))
    const isLive = GOOGLE_WATCH_EVENTS.every((e) => events.has(e))
    out.set(dir.id, {
      liveUpdates: isLive,
      watchStatus: isLive ? "ok" : "failed",
    })
  }
  return out
}

const googleSetup = (scim: ScimConsoleDeps) => {
  const sa = scim.google?.serviceAccount ?? null
  return {
    available: sa !== null,
    unavailableReason: sa ? null : GOOGLE_UNAVAILABLE_REASON,
    clientEmail: sa?.clientEmail ?? null,
    clientId: sa?.clientId ?? null,
    scopes: scim.google?.scopes ?? GOOGLE_DIRECTORY_SCOPES,
  }
}

const view = (
  directory: Directory,
  scim: ScimConsoleDeps,
  syncDetail?: GoogleSyncDetailView,
  watchInfo?: { liveUpdates: boolean; watchStatus: "ok" | "failed" | null },
) =>
  directory.provider === "google"
    ? {
        id: directory.id,
        name: directory.name,
        provider: directory.provider,
        enabled: directory.enabled,
        createMailboxes: directory.createMailboxes,
        baseUrl: null,
        adminEmail: directory.adminEmail,
        domain: directory.domain,
        lastSyncAt: directory.lastSyncAt,
        lastSyncStatus: directory.lastSyncStatus,
        lastSyncError: directory.lastSyncError,
        ...(syncDetail ? { lastSyncDetail: syncDetail } : {}),
        ...(watchInfo
          ? {
              liveUpdates: watchInfo.liveUpdates,
              watchStatus: watchInfo.watchStatus,
            }
          : {}),
        google: googleSetup(scim),
        createdAt: directory.createdAt,
      }
    : {
        id: directory.id,
        name: directory.name,
        provider: directory.provider,
        enabled: directory.enabled,
        createMailboxes: directory.createMailboxes,
        baseUrl: scim.baseUrl(directory.id),
        createdAt: directory.createdAt,
      }

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

  const validateGoogleFields = async (
    scim: ScimConsoleDeps,
    tenantId: string,
    input: { adminEmail?: string | undefined; domain?: string | undefined },
  ): Promise<
    { ok: true; adminEmail?: string; domain?: string } | { ok: false; message: string }
  > => {
    let adminEmail: string | undefined
    if (input.adminEmail !== undefined) {
      const clean = normaliseEmail(input.adminEmail)
      if (!clean)
        return { ok: false, message: "Enter a valid Google Workspace admin address." }
      const live = await scim.store.liveDomains(tenantId)
      if (!live.includes(emailDomain(clean)))
        return {
          ok: false,
          message:
            "The admin address must belong to a verified access domain of this workspace.",
        }
      adminEmail = clean
    }
    let domain: string | undefined
    if (input.domain !== undefined) {
      const clean = normaliseDomain(input.domain)
      if (!clean) return { ok: false, message: "Enter a valid domain name." }
      const live = await scim.store.liveDomains(tenantId)
      if (!live.includes(clean))
        return {
          ok: false,
          message:
            "The directory domain must be a verified access domain of this workspace.",
        }
      domain = clean
    }
    return {
      ok: true,
      ...(adminEmail !== undefined ? { adminEmail } : {}),
      ...(domain !== undefined ? { domain } : {}),
    }
  }

  app.get("/identity/directories", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see directories."), 403)
    const { tenantId } = c.get("auth")
    const rows = await scim.store.directories(tenantId)
    for (const row of rows) void scim.kick(tenantId, row.id)
    const syncDetails = await googleSyncDetailsByDirectory(d, scim, tenantId, rows)
    const watchInfos = await googleWatchInfoByDirectory(
      scim,
      tenantId,
      rows,
      new Date(),
    )
    return c.json({
      data: rows.map((r) => ({
        ...view(r, scim, syncDetails.get(r.id), watchInfos.get(r.id)),
        tokens: r.tokens.map(tokenView),
        users: r.users,
        conflicts: r.conflicts,
        pending: r.pending,
      })),
      max: MAX_DIRECTORIES,
      providers: DIRECTORY_PROVIDERS,
      google: googleSetup(scim),
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
    if (
      parsed.data.provider !== "google" &&
      (parsed.data.adminEmail !== undefined || parsed.data.domain !== undefined)
    )
      return c.json(
        validation(
          "Only a Google Workspace directory has an admin address and domain.",
        ),
        422,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const checked =
      parsed.data.provider === "google"
        ? await validateGoogleFields(scim, tenantId, parsed.data)
        : { ok: true as const }
    if (!checked.ok) return c.json(validation(checked.message), 422)
    if ((await scim.store.directories(tenantId)).length >= MAX_DIRECTORIES)
      return c.json(
        validation(`A workspace can have at most ${MAX_DIRECTORIES} directories.`),
        422,
      )
    // ⚠ THE FLAG FOLLOWS THE PROVIDER: SCIM and Google's directory sync are
    // separate features (sso.md decision 4).
    const refused = await refuseFeature(
      d,
      c,
      parsed.data.provider === "google" ? "google_directory" : "scim",
    )
    if (refused) return refused
    const made = await scim.store.createDirectory(tenantId, {
      name: parsed.data.name,
      provider: parsed.data.provider,
      ...(checked.adminEmail !== undefined ? { adminEmail: checked.adminEmail } : {}),
      ...(checked.domain !== undefined ? { domain: checked.domain } : {}),
      createdBy: userId,
    })
    await d.identity!.store.record(tenantId, {
      type: "directory.created",
      actorUserId: userId,
      data: {
        directoryId: made.id,
        name: made.name,
        provider: made.provider,
        ...(made.provider === "google"
          ? { adminEmail: made.adminEmail, domain: made.domain }
          : {}),
      },
    })
    const watchInfos = await googleWatchInfoByDirectory(
      scim,
      tenantId,
      [made],
      new Date(),
    )
    return c.json(view(made, scim, undefined, watchInfos.get(made.id)), 201)
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
    const syncDetails = await googleSyncDetailsByDirectory(d, scim, tenantId, [
      directory,
    ])
    const watchInfos = await googleWatchInfoByDirectory(
      scim,
      tenantId,
      [directory],
      new Date(),
    )
    return c.json({
      ...view(
        directory,
        scim,
        syncDetails.get(directory.id),
        watchInfos.get(directory.id),
      ),
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
    // ⚠ ENABLING AND GOOGLE TRUST SETTINGS ARE AN OWNER'S, DISABLING AN
    // ADMIN'S: a directory that is on provisions and deprovisions, and who we
    // impersonate or pull from decides which Workspace controls this tenant.
    const touchesTrust =
      parsed.data.enabled === true ||
      // ⚠ MAKING ADDRESSES THAT RECEIVE THE WORKSPACE'S MAIL, FOR WHOEVER RUNS
      // THE DIRECTORY: an owner's. Turning it off only stops new ones.
      parsed.data.createMailboxes === true ||
      parsed.data.adminEmail !== undefined ||
      parsed.data.domain !== undefined
    const needed: Permission = touchesTrust ? "owners:manage" : "sso:manage"
    if (!(await allowed(c, needed)))
      return c.json(
        forbidden(
          needed === "owners:manage"
            ? "Only an owner can enable a directory, let it create mailboxes, or change its Google Workspace settings."
            : "Only an admin can change a directory.",
        ),
        403,
      )
    const before = await directoryOf(c)
    if (!before) return c.json(notFound(), 404)
    if (
      before.provider !== "google" &&
      (parsed.data.adminEmail !== undefined || parsed.data.domain !== undefined)
    )
      return c.json(
        validation(
          "Only a Google Workspace directory has an admin address and domain.",
        ),
        422,
      )
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const checked =
      before.provider === "google"
        ? await validateGoogleFields(scim, tenantId, parsed.data)
        : { ok: true as const }
    if (!checked.ok) return c.json(validation(checked.message), 422)

    const willBeEnabled = parsed.data.enabled ?? before.enabled
    if (before.provider === "google" && willBeEnabled) {
      if (!scim.google?.serviceAccount)
        return c.json(validation(GOOGLE_UNAVAILABLE_REASON), 422)
      const effectiveAdmin = checked.adminEmail ?? before.adminEmail
      const effectiveDomain = checked.domain ?? before.domain
      if (!effectiveAdmin || !effectiveDomain)
        return c.json(
          validation(
            "Set the Google Workspace admin address and primary domain before enabling the directory.",
          ),
          422,
        )
      const live = await scim.store.liveDomains(tenantId)
      if (!live.includes(effectiveDomain))
        return c.json(
          validation(
            "The directory domain must be a verified access domain of this workspace.",
          ),
          422,
        )
      if (!live.includes(emailDomain(effectiveAdmin)))
        return c.json(
          validation(
            "The admin address must belong to a verified access domain of this workspace.",
          ),
          422,
        )
    }

    const after = await scim.store.updateDirectory(tenantId, before.id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.createMailboxes !== undefined
        ? { createMailboxes: parsed.data.createMailboxes }
        : {}),
      ...(checked.adminEmail !== undefined ? { adminEmail: checked.adminEmail } : {}),
      ...(checked.domain !== undefined ? { domain: checked.domain } : {}),
    })
    if (!after) return c.json(notFound(), 404)
    await d.identity!.store.record(tenantId, {
      type: "directory.updated",
      actorUserId: userId,
      data: {
        directoryId: after.id,
        from: {
          name: before.name,
          enabled: before.enabled,
          createMailboxes: before.createMailboxes,
          ...(checked.adminEmail !== undefined
            ? { adminEmail: before.adminEmail }
            : {}),
          ...(checked.domain !== undefined ? { domain: before.domain } : {}),
        },
        to: {
          name: after.name,
          enabled: after.enabled,
          createMailboxes: after.createMailboxes,
          ...(checked.adminEmail !== undefined ? { adminEmail: after.adminEmail } : {}),
          ...(checked.domain !== undefined ? { domain: after.domain } : {}),
        },
      },
    })
    // ⚠ THE PEOPLE IT ALREADY ACTIVATED ARE LOOKED AT AGAIN when mailboxes are
    // turned on: nothing changed on their rows, so no entry would ever say so.
    if (after.createMailboxes && !before.createMailboxes && after.enabled)
      await scim.schedule(tenantId, await scim.store.requeueActive(tenantId, after.id))
    // What it said while it was off is replayed now (applied only if it is on).
    if (after.enabled && !before.enabled) {
      await scim.kick(tenantId, after.id, { force: true })
      if (after.provider === "google" && scim.google) {
        try {
          await scim.google.schedulePull(tenantId, after.id)
        } catch (error) {
          d.identity?.log.warn(
            { ...safeError(error), directoryId: after.id },
            "could not schedule immediate Google directory pull",
          )
        }
      }
    } else if (after.provider === "google" && !after.enabled && before.enabled) {
      try {
        await scim.google?.stopChannels(tenantId, after.id, before.adminEmail)
      } catch (error) {
        d.identity?.log.warn(
          { ...safeError(error), directoryId: after.id },
          "could not stop Google directory watch channels",
        )
      }
    } else if (
      after.provider === "google" &&
      after.enabled &&
      (before.adminEmail !== after.adminEmail || before.domain !== after.domain)
    ) {
      try {
        await scim.google?.stopChannels(tenantId, after.id, before.adminEmail)
        await scim.google?.schedulePull(tenantId, after.id)
      } catch (error) {
        d.identity?.log.warn(
          { ...safeError(error), directoryId: after.id },
          "could not refresh Google directory after settings change",
        )
      }
    }
    const syncDetails = await googleSyncDetailsByDirectory(d, scim, tenantId, [after])
    const watchInfos = await googleWatchInfoByDirectory(
      scim,
      tenantId,
      [after],
      new Date(),
    )
    return c.json(
      view(after, scim, syncDetails.get(after.id), watchInfos.get(after.id)),
    )
  })

  app.post("/identity/directories/:id/check", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can check a directory."), 403)
    const directory = await directoryOf(c)
    if (!directory || directory.provider !== "google") return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    const result: CheckAccessResult = scim.google?.serviceAccount
      ? await scim.google.checkAccess({
          tenantId,
          adminEmail: directory.adminEmail,
          domain: directory.domain,
        })
      : { ok: false, error: "not_configured" }
    await d.identity!.store.record(tenantId, {
      type: "directory.google_checked",
      actorUserId: userId,
      data: {
        directoryId: directory.id,
        ok: result.ok,
        ...(result.ok
          ? {}
          : {
              error: result.error,
              ...(result.missingScopes
                ? { missingScopes: [...result.missingScopes] }
                : {}),
            }),
      },
    })
    return c.json(result)
  })

  // ⚠ A BLANK CHEQUE IS NOT ACCEPTED. The shrink guard refused a pull that
  // would remove most of a directory; an owner lets exactly the count they were
  // shown through, once, and a pull that would remove more is refused again.
  app.post(
    "/identity/directories/:id/confirm-removals",
    requireFreshAuth,
    async (c) => {
      const scim = wired()
      if (!scim) return c.json(notWired("SCIM directories"), 501)
      if (!(await allowed(c, "owners:manage")))
        return c.json(
          forbidden("Only an owner can confirm removing people from a directory."),
          403,
        )
      const parsed = confirmedRemovals.safeParse((await readJson(c)) ?? {})
      if (!parsed.success)
        return c.json(
          validation(parsed.error.issues[0]?.message ?? "Invalid request."),
          422,
        )
      const directory = await directoryOf(c)
      if (!directory || directory.provider !== "google") return c.json(notFound(), 404)
      if (!scim.google) return c.json(notWired("Google directory sync"), 501)
      const { tenantId } = c.get("auth")
      const { userId } = c.get("user")
      const shown = (
        await googleSyncDetailsByDirectory(d, scim, tenantId, [directory])
      ).get(directory.id)?.removedUsers
      if (
        directory.lastSyncStatus !== "failed" ||
        directory.lastSyncError !== "large_drop" ||
        shown === undefined
      )
        return c.json(
          conflict("This directory has no refused removal waiting for a go-ahead."),
          409,
        )
      if (shown !== parsed.data.removedUsers)
        return c.json(
          conflict("The number of people to remove has changed; look at it again."),
          409,
        )
      if (
        !(await scim.store.allowDirectoryDrop(tenantId, directory.id, {
          users: shown,
          at: new Date(),
        }))
      )
        return c.json(
          conflict("This directory has no refused removal waiting for a go-ahead."),
          409,
        )
      await d.identity!.store.record(tenantId, {
        type: "directory.removals_confirmed",
        actorUserId: userId,
        data: { directoryId: directory.id, removedUsers: shown },
      })
      try {
        await scim.google.schedulePull(tenantId, directory.id)
      } catch (error) {
        d.identity?.log.warn(
          { ...safeError(error), directoryId: directory.id },
          "could not schedule the Google directory pull after confirming removals",
        )
      }
      return c.json({ ok: true })
    },
  )

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
    if (directory.provider === "google")
      return c.json(
        validation(
          "Google Workspace directories use domain-wide delegation and do not issue SCIM tokens.",
        ),
        422,
      )
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

  app.get("/identity/directories/:id/groups", async (c) => {
    const scim = wired()
    if (!scim) return c.json(notWired("SCIM directories"), 501)
    if (!(await allowed(c, "sso:manage")))
      return c.json(forbidden("Only an admin can see directories."), 403)
    const directory = await directoryOf(c)
    if (!directory) return c.json(notFound(), 404)
    const { tenantId } = c.get("auth")
    return c.json({ data: await scim.store.groupSummaries(tenantId, directory.id) })
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
