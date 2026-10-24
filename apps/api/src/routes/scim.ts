import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { safeError } from "../identity/directory.js"
import type {
  Directory,
  DirectoryGroupRow,
  DirectoryStore,
  DirectoryUserRow,
  OutboxEntry,
} from "../identity/directory-ports.js"
import { hashSecret, sameHash } from "../identity/model.js"
import type { AuditEvent, Logger } from "../identity/ports.js"
import { fixedWindow, trustedClientIp, type Limit } from "../identity/rate-limit.js"
import {
  LIMITS,
  SCIM_CONTENT_TYPE,
  ScimError,
  errorBody,
  groupResource,
  listResponse,
  parseFilter,
  patchGroup,
  patchUser,
  project,
  readGroup,
  readListQuery,
  readPatch,
  readProjection,
  readToken,
  readUser,
  resourceTypes,
  schemas,
  serviceProviderConfig,
  userResource,
  type StoredGroup,
  type StoredUser,
} from "../identity/scim.js"

/**
 * The SCIM 2.0 server (#342, RFC 7644, sso.md 2.7), at
 * `<SCIM_BASE_URL>/<directory id>`, for Okta, Entra, Google and anything else
 * that speaks the protocol. Outside the OpenAPI document: it is somebody
 * else's contract.
 *
 *   GET   /ServiceProviderConfig, /ResourceTypes[/:id], /Schemas[/:id]
 *   GET   /Users?filter&startIndex&count&attributes&excludedAttributes
 *   POST  /Users                 GET, PUT, PATCH, DELETE /Users/:id
 *   GET   /Groups                POST /Groups
 *   GET, PUT, PATCH, DELETE /Groups/:id
 *   ...   /Bulk, /Me, /.search   501
 *
 * ⚠ THE BEARER TOKEN IS THE WHOLE OF THE AUTHORISATION, AND IT CAN CREATE AND
 * DEPROVISION ACCOUNTS. It must be ours in shape, hash to a stored row, belong
 * to THIS directory (the URL names one; the token's row decides which, and the
 * workspace), be neither revoked nor expired, and the directory enabled. The
 * tenant a request is served under is the token row's, never anything the
 * request says. The token is never logged, never audited, never in an error.
 *
 * ⚠ LIMITED THREE WAYS, ALL BEFORE ANY WORK. Per client address on everything;
 * per client address on FAILED authentication (the 429 replaces the 401, so
 * guessing is slowed while a valid token on the same address is never
 * locked out - Okta and Entra egress from addresses shared by many tenants);
 * and per directory once authenticated.
 *
 * ⚠ NOTHING HERE TOUCHES CLERK. A write stores the resource, the outbox entry
 * and the audit event in one transaction and answers; the apply job
 * (identity/directory.ts) does the rest. The IdP never waits on, or fails
 * because of, Clerk.
 *
 * ⚠ EVERY ERROR IS SCIM'S OWN SHAPE (`application/scim+json`), including the
 * ones Hono would answer itself: the body limit, a wrong content type, an
 * unknown path. A handler that throws is caught HERE: the app's `onError` is
 * not SCIM-shaped and `app.route()` drops a sub-app's own.
 */

export interface ScimRouteDeps {
  store: DirectoryStore
  /** The directory's base URL, `<SCIM_BASE_URL>/<id>`. */
  baseUrl(directoryId: string): string
  /** Puts committed outbox entries on the queue; never throws. */
  schedule(tenantId: string, entries: readonly OutboxEntry[]): Promise<void>
  /** Re-schedules a directory's entries nobody applied (throttled); never throws. */
  kick(tenantId: string, directoryId: string): Promise<unknown>
  record(tenantId: string, event: AuditEvent): Promise<void>
  take: ReturnType<typeof fixedWindow>
  contextSecret: string | undefined
  limits?: Partial<{ perIp: Limit; authFailures: Limit; perDirectory: Limit }>
  log: Pick<Logger, "warn" | "error">
  now?: () => Date
}

/** Okta and Entra send bursts: this is far above a full sync, and far below a flood. */
export const PER_IP: Limit = { max: 1200, windowSeconds: 60 }
export const AUTH_FAILURES: Limit = { max: 30, windowSeconds: 60 }
export const PER_DIRECTORY: Limit = { max: 6000, windowSeconds: 60 }

type Env = {
  Variables: {
    scim: { tenantId: string; directory: Directory; tokenId: string; base: string }
  }
}

const respond = (c: Context, body: unknown, status: number) =>
  c.body(JSON.stringify(body), status as 200, {
    "content-type": `${SCIM_CONTENT_TYPE}; charset=utf-8`,
  })

const failure = (c: Context, error: ScimError, retryAfter?: number) => {
  if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter))
  return respond(c, errorBody(error), error.status)
}

/** A path parameter; an empty one matches nothing. */
const param = (c: Context<Env>, name: string) => c.req.param(name) ?? ""

const notFound = (what: string) => new ScimError(404, `${what} not found.`)

export function createScimRoutes(deps?: ScimRouteDeps) {
  const app = new Hono<Env>()
  const now = () => (deps?.now ?? (() => new Date()))()
  const limits = {
    perIp: deps?.limits?.perIp ?? PER_IP,
    authFailures: deps?.limits?.authFailures ?? AUTH_FAILURES,
    perDirectory: deps?.limits?.perDirectory ?? PER_DIRECTORY,
  }

  /** Any throw as a SCIM answer: a refusal as itself, anything else as a 503 and a log line. */
  const failed = (c: Context<Env>, error: unknown): Response => {
    if (error instanceof ScimError) return failure(c, error)
    deps?.log.error(
      { ...safeError(error), route: c.req.routePath, method: c.req.method },
      "a SCIM request failed",
    )
    return failure(c, new ScimError(503, "The service is temporarily unavailable."), 5)
  }

  /** A handler whose every throw is answered by `failed`. */
  const route =
    (fn: (c: Context<Env>, d: ScimRouteDeps) => Promise<Response>) =>
    async (c: Context<Env>): Promise<Response> => {
      try {
        if (!deps) return failure(c, new ScimError(501, "SCIM is not configured."))
        return await fn(c, deps)
      } catch (error) {
        return failed(c, error)
      }
    }

  app.use(
    "*",
    bodyLimit({
      maxSize: LIMITS.body,
      onError: (c) =>
        failure(c, new ScimError(413, "The request is larger than the 1 MiB allowed.")),
    }),
  )

  /** The refusal to answer, or null once the request is authenticated and within its limits. */
  async function authenticate(
    c: Context<Env>,
    d: ScimRouteDeps,
  ): Promise<Response | null> {
    const ip = trustedClientIp(c.req.raw.headers, d.contextSecret)
    if (ip) {
      const verdict = await d.take(`scim:ip:${ip}`, limits.perIp)
      if (!verdict.ok)
        return failure(c, new ScimError(429, "Too many requests."), verdict.retryAfter)
    }

    /*
     * ⚠ EVERY REFUSAL BELOW COUNTS AGAINST THE ADDRESS, and past the limit the
     * answer is 429 instead. A refusal for a token we know (revoked, expired,
     * the wrong directory, a disabled directory) is audited under its
     * workspace - what the token resolved to, never the token.
     */
    const refuse = async (
      status: 401 | 403 | 404,
      detail: string,
      reason: string,
      known?: { tenantId: string; directoryId: string; tokenId: string },
    ) => {
      const verdict = await d.take(`scim:fail:${ip ?? "unknown"}`, limits.authFailures)
      if (!verdict.ok)
        return failure(c, new ScimError(429, "Too many requests."), verdict.retryAfter)
      if (known)
        await d.record(known.tenantId, {
          type: "scim.auth_failed",
          reason,
          data: { directoryId: known.directoryId, tokenId: known.tokenId },
        })
      if (status === 401) c.header("WWW-Authenticate", 'Bearer realm="scim"')
      return failure(c, new ScimError(status, detail))
    }

    const token = readToken(c.req.header("authorization"))
    if (!token) return refuse(401, "A bearer token is required.", "malformed")
    const hash = hashSecret(token)
    const row = await d.store.tokenByHash(hash)
    if (!row || !sameHash(row.tokenHash, hash))
      return refuse(401, "The token is not valid.", "unknown")
    const known = {
      tenantId: row.tenantId,
      directoryId: row.directoryId,
      tokenId: row.id,
    }
    if (row.revokedAt) return refuse(401, "The token is not valid.", "revoked", known)
    if (row.expiresAt && row.expiresAt.getTime() <= now().getTime())
      return refuse(401, "The token is not valid.", "expired", known)
    if (row.directoryId !== c.req.param("directory")?.toLowerCase())
      return refuse(
        403,
        "The token is not for this directory.",
        "wrong_directory",
        known,
      )
    const directory = await d.store.directory(row.tenantId, row.directoryId)
    if (!directory)
      return refuse(404, "The directory does not exist.", "no_directory", known)
    if (!directory.enabled)
      return refuse(403, "The directory is disabled.", "directory_disabled", known)

    const verdict = await d.take(`scim:dir:${directory.id}`, limits.perDirectory)
    if (!verdict.ok)
      return failure(c, new ScimError(429, "Too many requests."), verdict.retryAfter)

    const method = c.req.method
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const type = (c.req.header("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase()
      if (type !== SCIM_CONTENT_TYPE && type !== "application/json")
        return failure(
          c,
          new ScimError(
            415,
            "The content type must be application/scim+json or application/json.",
          ),
        )
    }

    c.set("scim", {
      tenantId: row.tenantId,
      directory,
      tokenId: row.id,
      base: d.baseUrl(directory.id),
    })
    try {
      await d.store.touchToken(row.tenantId, row.id, now())
    } catch (error) {
      d.log.warn(
        { ...safeError(error), tokenId: row.id },
        "could not note a SCIM token's use",
      )
    }
    d.kick(row.tenantId, directory.id).catch((error: unknown) =>
      d.log.warn(
        { ...safeError(error), directoryId: directory.id },
        "a SCIM kick failed",
      ),
    )
    return null
  }

  app.use("/:directory/*", async (c, next) => {
    let refusal: Response | null
    try {
      refusal = deps
        ? await authenticate(c, deps)
        : failure(c, new ScimError(501, "SCIM is not configured."))
    } catch (error) {
      return failed(c, error)
    }
    if (refusal) return refusal
    await next()
  })

  const body = async (c: Context<Env>): Promise<unknown> => {
    try {
      return await c.req.json()
    } catch {
      throw new ScimError(400, "The body is not valid JSON.", "invalidSyntax")
    }
  }

  const event = (
    c: Context<Env>,
    type: string,
    data: Record<string, unknown> = {},
  ): AuditEvent => {
    const s = c.get("scim")
    return {
      type,
      data: { directoryId: s.directory.id, tokenId: s.tokenId, ...data },
    }
  }

  /** `id` in a PUT body must be the resource's own (RFC 7644 3.5.1). */
  const sameId = (input: unknown, id: string) => {
    const sent = (input as { id?: unknown } | null)?.id
    if (sent !== undefined && String(sent).toLowerCase() !== id.toLowerCase())
      throw new ScimError(400, "id cannot be changed.", "mutability")
  }

  const userEvent =
    (c: Context<Env>) => (before: DirectoryUserRow, after: StoredUser) =>
      event(
        c,
        before.active && !after.active
          ? "scim.user.deactivated"
          : !before.active && after.active
            ? "scim.user.reactivated"
            : "scim.user.updated",
        { directoryUserId: before.id },
      )

  const userViews = async (
    c: Context<Env>,
    d: ScimRouteDeps,
    rows: DirectoryUserRow[],
  ) => {
    const s = c.get("scim")
    const groups = await d.store.groupsOf(
      s.tenantId,
      rows.map((r) => r.id),
    )
    return rows.map((r) => userResource(r, groups.get(r.id) ?? [], s.base))
  }

  const groupViews = async (
    c: Context<Env>,
    d: ScimRouteDeps,
    rows: DirectoryGroupRow[],
  ) => {
    const s = c.get("scim")
    const members = await d.store.membersOf(
      s.tenantId,
      rows.map((r) => r.id),
    )
    return rows.map((r) => groupResource(r, members.get(r.id) ?? [], s.base))
  }

  // ── Discovery ──

  app.get(
    "/:directory/ServiceProviderConfig",
    route(async (c) => respond(c, serviceProviderConfig(c.get("scim").base), 200)),
  )
  app.get(
    "/:directory/ResourceTypes",
    route(async (c) => {
      const all = resourceTypes(c.get("scim").base)
      return respond(c, listResponse(all, all.length, 1), 200)
    }),
  )
  app.get(
    "/:directory/ResourceTypes/:id",
    route(async (c) => {
      const id = param(c, "id").toLowerCase()
      const found = resourceTypes(c.get("scim").base).find(
        (t) => t.id.toLowerCase() === id,
      )
      if (!found) throw notFound("The resource type")
      return respond(c, found, 200)
    }),
  )
  app.get(
    "/:directory/Schemas",
    route(async (c) => {
      const all = schemas(c.get("scim").base)
      return respond(c, listResponse(all, all.length, 1), 200)
    }),
  )
  app.get(
    "/:directory/Schemas/:id",
    route(async (c) => {
      const id = param(c, "id").toLowerCase()
      const found = schemas(c.get("scim").base).find((x) => x.id.toLowerCase() === id)
      if (!found) throw notFound("The schema")
      return respond(c, found, 200)
    }),
  )

  // ── Users ──

  app.get(
    "/:directory/Users",
    route(async (c, d) => {
      const s = c.get("scim")
      const q = readListQuery(c.req.query())
      const filter = parseFilter(q.filter, "User")
      const page = await d.store.listUsers(s.tenantId, s.directory.id, {
        filter,
        startIndex: q.startIndex,
        count: q.count,
      })
      const resources = (await userViews(c, d, page.rows)).map((r) => project(r, q))
      return respond(c, listResponse(resources, page.total, q.startIndex), 200)
    }),
  )

  app.post(
    "/:directory/Users",
    route(async (c, d) => {
      const s = c.get("scim")
      const stored = readUser(await body(c))
      const made = await d.store.createUser(
        s.tenantId,
        s.directory.id,
        stored,
        event(c, "scim.user.created"),
      )
      if (made === "taken")
        throw new ScimError(
          409,
          "A user with that userName already exists.",
          "uniqueness",
        )
      await d.schedule(s.tenantId, made.outbox)
      const [view] = await userViews(c, d, [made.row])
      c.header("Location", `${s.base}/Users/${made.row.id}`)
      return respond(c, view, 201)
    }),
  )

  app.get(
    "/:directory/Users/:id",
    route(async (c, d) => {
      const s = c.get("scim")
      const row = await d.store.user(s.tenantId, s.directory.id, param(c, "id"))
      if (!row) throw notFound("The user")
      const [view] = await userViews(c, d, [row])
      return respond(c, project(view!, readProjection(c.req.query())), 200)
    }),
  )

  const edited = async (
    c: Context<Env>,
    d: ScimRouteDeps,
    edit: (current: DirectoryUserRow) => StoredUser,
  ) => {
    const s = c.get("scim")
    const done = await d.store.editUser(
      s.tenantId,
      s.directory.id,
      param(c, "id"),
      edit,
      userEvent(c),
    )
    if (done === null) throw notFound("The user")
    if (done === "taken")
      throw new ScimError(
        409,
        "A user with that userName already exists.",
        "uniqueness",
      )
    await d.schedule(s.tenantId, done.outbox)
    const [view] = await userViews(c, d, [done.row])
    return respond(c, view, 200)
  }

  app.put(
    "/:directory/Users/:id",
    route(async (c, d) => {
      const input = await body(c)
      sameId(input, param(c, "id"))
      const stored = readUser(input)
      return edited(c, d, () => stored)
    }),
  )

  app.patch(
    "/:directory/Users/:id",
    route(async (c, d) => {
      const ops = readPatch(await body(c))
      return edited(c, d, (current) => patchUser(current.resource, ops, current.id))
    }),
  )

  app.delete(
    "/:directory/Users/:id",
    route(async (c, d) => {
      const s = c.get("scim")
      const id = param(c, "id")
      const done = await d.store.deleteUser(
        s.tenantId,
        s.directory.id,
        id,
        event(c, "scim.user.deleted", { directoryUserId: id.toLowerCase() }),
      )
      if (!done) throw notFound("The user")
      await d.schedule(s.tenantId, done.outbox)
      return c.body(null, 204)
    }),
  )

  // ── Groups ──

  app.get(
    "/:directory/Groups",
    route(async (c, d) => {
      const s = c.get("scim")
      const q = readListQuery(c.req.query())
      const filter = parseFilter(q.filter, "Group")
      const page = await d.store.listGroups(s.tenantId, s.directory.id, {
        filter,
        startIndex: q.startIndex,
        count: q.count,
      })
      const resources = (await groupViews(c, d, page.rows)).map((r) => project(r, q))
      return respond(c, listResponse(resources, page.total, q.startIndex), 200)
    }),
  )

  app.post(
    "/:directory/Groups",
    route(async (c, d) => {
      const s = c.get("scim")
      const stored = readGroup(await body(c))
      const made = await d.store.createGroup(
        s.tenantId,
        s.directory.id,
        stored,
        event(c, "scim.group.created"),
      )
      await d.schedule(s.tenantId, made.outbox)
      const [view] = await groupViews(c, d, [made.row])
      c.header("Location", `${s.base}/Groups/${made.row.id}`)
      return respond(c, view, 201)
    }),
  )

  app.get(
    "/:directory/Groups/:id",
    route(async (c, d) => {
      const s = c.get("scim")
      const row = await d.store.group(s.tenantId, s.directory.id, param(c, "id"))
      if (!row) throw notFound("The group")
      const [view] = await groupViews(c, d, [row])
      return respond(c, project(view!, readProjection(c.req.query())), 200)
    }),
  )

  const groupEdited = async (
    c: Context<Env>,
    d: ScimRouteDeps,
    edit: (current: { row: DirectoryGroupRow; members: string[] }) => StoredGroup,
  ) => {
    const s = c.get("scim")
    const id = param(c, "id")
    const done = await d.store.editGroup(
      s.tenantId,
      s.directory.id,
      id,
      edit,
      event(c, "scim.group.updated"),
    )
    if (!done) throw notFound("The group")
    await d.schedule(s.tenantId, done.outbox)
    const [view] = await groupViews(c, d, [done.row])
    return respond(c, view, 200)
  }

  app.put(
    "/:directory/Groups/:id",
    route(async (c, d) => {
      const input = await body(c)
      sameId(input, param(c, "id"))
      const stored = readGroup(input)
      return groupEdited(c, d, () => stored)
    }),
  )

  app.patch(
    "/:directory/Groups/:id",
    route(async (c, d) => {
      const ops = readPatch(await body(c))
      return groupEdited(c, d, (current) =>
        patchGroup(current.row.resource, current.members, ops, current.row.id),
      )
    }),
  )

  app.delete(
    "/:directory/Groups/:id",
    route(async (c, d) => {
      const s = c.get("scim")
      const id = param(c, "id")
      const done = await d.store.deleteGroup(
        s.tenantId,
        s.directory.id,
        id,
        event(c, "scim.group.deleted"),
      )
      if (!done) throw notFound("The group")
      await d.schedule(s.tenantId, done.outbox)
      return c.body(null, 204)
    }),
  )

  // ── What we do not do ──

  for (const path of ["Bulk", "Me", ".search", "Users/.search", "Groups/.search"])
    app.all(
      `/:directory/${path}`,
      route(async () => {
        throw new ScimError(501, `${path} is not supported.`)
      }),
    )

  app.all(
    "/:directory/*",
    route(async () => {
      throw new ScimError(404, "There is nothing at that path.")
    }),
  )

  return app
}
