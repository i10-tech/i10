import { Hono, type Context } from "hono"
import { z } from "zod"
import { startLogin, type BridgeDeps } from "../identity/bridge.js"
import {
  SETUP_STATUSES,
  hashSecret,
  readSecret,
  readSetupToken,
  safeReturnTo,
  sameHash,
  type Connection,
} from "../identity/model.js"
import type { SsoPolicyStore } from "../identity/ports.js"
import {
  PER_IP,
  fixedWindow,
  trustedClientIp,
  type Limit,
} from "../identity/rate-limit.js"
import type { ConsoleDeps } from "./console/deps.js"
import { readJson } from "./console/http.js"
import {
  oidcSetupView,
  putOidcSecret,
  putOidcSettings,
  type SettingsActor,
} from "./console/identity-oidc.js"
import {
  addSamlCertificate,
  putSamlSettings,
  samlSetupView,
} from "./console/identity-saml.js"

/**
 * Setup links (#340, sso.md 2.10): what a customer's IT contact can do with
 * the link an admin gave them, and nothing else.
 *
 *   GET  /sso/setup/:token                     the connection's non-secret settings and our SP values
 *   PUT  /sso/setup/:token/oidc                its IdP settings (as the console's)
 *   PUT  /sso/setup/:token/oidc/secret         its client secret, write-only
 *   PUT  /sso/setup/:token/saml                its IdP settings (as the console's)
 *   POST /sso/setup/:token/saml/certificates   an IdP certificate
 *   POST /sso/setup/:token/test                { binding, returnTo } -> start a test run
 *
 * ⚠ THE TOKEN IS THE WHOLE CREDENTIAL, so the link serves one connection and
 * only while it is `draft` or `testing`: never activating it, its enforcement,
 * its domains, its bypass list, or any secret read back. The writes are the
 * console's own functions (identity-oidc.ts, identity-saml.ts), with the same
 * validation, the egress guard and the audit, the actor being the link.
 *
 * ⚠ RATE LIMITED PER BROWSER ADDRESS AND PER LINK, every method, before the
 * token is looked up. The per-link key is the token's hash, never the token.
 *
 * ⚠ THE TOKEN IS IN THE PATH, which our request log never records (it keeps
 * route patterns and only for API keys), but a proxy's access log might.
 */

/** Requests one setup link may make a minute, from everybody together. */
export const PER_LINK: Limit = { max: 120, windowSeconds: 60 }

export interface SetupRouteDeps {
  links: Pick<SsoPolicyStore, "setupLinkByHash" | "markSetupLinkUsed">
  /** The console's identity half: the store, the audit log, and the engines' setup parts. */
  identity: NonNullable<ConsoleDeps["identity"]>
  bridge: Pick<BridgeDeps, "store" | "engines" | "log" | "now">
  /** Where a finished test run may send the browser. */
  returnOrigins: readonly string[]
  take: ReturnType<typeof fixedWindow>
  contextSecret: string | undefined
  limits?: Partial<{ perIp: Limit; perLink: Limit }>
  now?: () => Date
}

type Env = {
  Variables: {
    setup: { linkId: string; tenantId: string; connection: Connection }
  }
}

const notValid = (c: Context) =>
  c.json(
    {
      statusCode: 404,
      name: "not_found",
      message: "This setup link is not valid. Ask your contact for a new one.",
    },
    404,
  )

const unavailable = (c: Context) => {
  c.header("Retry-After", "5")
  return c.json(
    {
      statusCode: 503,
      name: "service_unavailable",
      message: "Setup is temporarily unavailable. Try again in a moment.",
    },
    503,
  )
}

const TestBody = z
  .object({
    binding: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    returnTo: z.string().max(2048).nullable().optional(),
  })
  .strict()

export function createSetupRoutes(d: SetupRouteDeps) {
  const app = new Hono<Env>()
  const now = () => (d.now ?? (() => new Date()))()
  const limits = {
    perIp: d.limits?.perIp ?? PER_IP,
    perLink: d.limits?.perLink ?? PER_LINK,
  }

  app.onError((error, c) => {
    d.identity.log.error(
      { err: error instanceof Error ? error.name : "unknown", route: c.req.routePath },
      "a setup link request failed",
    )
    return unavailable(c)
  })

  const authenticate = async (c: Context<Env>, next: () => Promise<void>) => {
    const tooMany = (retryAfter: number) => {
      c.header("Retry-After", String(retryAfter))
      return c.json(
        {
          statusCode: 429,
          name: "rate_limit_exceeded",
          message: "Too many requests. Wait a minute and try again.",
        },
        429,
      )
    }
    const ip = trustedClientIp(c.req.raw.headers, d.contextSecret)
    if (ip) {
      const verdict = await d.take(`setup:ip:${ip}`, limits.perIp)
      if (!verdict.ok) return tooMany(verdict.retryAfter)
    }
    const token = readSetupToken(c.req.param("token"))
    if (!token) return notValid(c)
    const hash = hashSecret(token)
    const perLink = await d.take(`setup:link:${hash}`, limits.perLink)
    if (!perLink.ok) return tooMany(perLink.retryAfter)

    const row = await d.links.setupLinkByHash(hash)
    if (!row || !sameHash(row.tokenHash, hash)) return notValid(c)
    const at = now()
    const refuse = async (reason: string) => {
      await d.identity.store.record(row.tenantId, {
        type: "setup_link.refused",
        connectionId: row.connectionId,
        reason,
        data: { setupLinkId: row.id },
      })
      return notValid(c)
    }
    if (row.revokedAt) return refuse("revoked")
    if (row.expiresAt.getTime() <= at.getTime()) return refuse("expired")
    const connection = await d.identity.store.connection(row.tenantId, row.connectionId)
    if (!connection) return notValid(c)
    if (!SETUP_STATUSES.includes(connection.status))
      return refuse("connection_left_setup")
    if (await d.links.markSetupLinkUsed(row.tenantId, row.id, at))
      await d.identity.store.record(row.tenantId, {
        type: "setup_link.used",
        connectionId: row.connectionId,
        data: { setupLinkId: row.id },
      })
    c.set("setup", { linkId: row.id, tenantId: row.tenantId, connection })
    await next()
  }
  app.use("/:token", authenticate)
  app.use("/:token/*", authenticate)

  const actorOf = (c: Context<Env>): SettingsActor => ({
    userId: null,
    setupLinkId: c.get("setup").linkId,
  })

  /**
   * ⚠ ASKED AGAIN AT THE WRITE, NOT ONLY AT THE DOOR: an owner may have
   * activated the connection since this request was let in, and from then on
   * its trust settings are an owner's.
   */
  const stillInSetup = (c: Context<Env>) => async () => {
    const { tenantId, connection } = c.get("setup")
    const current = await d.identity.store.connection(tenantId, connection.id)
    if (current && SETUP_STATUSES.includes(current.status)) return null
    return notValid(c)
  }

  app.get("/:token", async (c) => {
    const { connection } = c.get("setup")
    const { oidc, saml } = d.identity
    return c.json({
      connection: {
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        provider: connection.provider,
        status: connection.status,
      },
      oidc:
        connection.protocol === "oidc" && oidc ? oidcSetupView(connection, oidc) : null,
      saml:
        connection.protocol === "saml" && saml
          ? await samlSetupView(connection, saml)
          : null,
    })
  })

  const oidcTarget = (c: Context<Env>) => {
    const { tenantId, connection } = c.get("setup")
    const oidc = d.identity.oidc
    return connection.protocol === "oidc" && oidc
      ? { id: d.identity, oidc, connection, tenantId }
      : null
  }
  const samlTarget = (c: Context<Env>) => {
    const { tenantId, connection } = c.get("setup")
    const saml = d.identity.saml
    return connection.protocol === "saml" && saml
      ? { id: d.identity, saml, connection, tenantId }
      : null
  }

  app.put("/:token/oidc", async (c) => {
    const target = oidcTarget(c)
    if (!target) return notValid(c)
    return putOidcSettings(
      c,
      target,
      (await readJson(c)) ?? {},
      actorOf(c),
      stillInSetup(c),
    )
  })

  app.put("/:token/oidc/secret", async (c) => {
    const target = oidcTarget(c)
    if (!target) return notValid(c)
    return putOidcSecret(
      c,
      target,
      (await readJson(c)) ?? {},
      actorOf(c),
      stillInSetup(c),
    )
  })

  app.put("/:token/saml", async (c) => {
    const target = samlTarget(c)
    if (!target) return notValid(c)
    return putSamlSettings(
      c,
      target,
      (await readJson(c)) ?? {},
      actorOf(c),
      stillInSetup(c),
    )
  })

  app.post("/:token/saml/certificates", async (c) => {
    const target = samlTarget(c)
    if (!target) return notValid(c)
    return addSamlCertificate(
      c,
      target,
      (await readJson(c)) ?? {},
      actorOf(c),
      stillInSetup(c),
    )
  })

  app.post("/:token/test", async (c) => {
    const { tenantId, connection, linkId } = c.get("setup")
    const parsed = TestBody.safeParse((await readJson(c)) ?? {})
    const binding = parsed.success ? readSecret(parsed.data.binding) : null
    if (!parsed.success || !binding)
      return c.json(
        { statusCode: 422, name: "validation_error", message: "binding is required." },
        422,
      )
    const started = await startLogin(d.bridge, {
      connectionId: connection.id,
      purpose: "test_run",
      binding,
      returnTo: safeReturnTo(parsed.data.returnTo, d.returnOrigins),
    })
    if (started.outcome === "refused")
      return c.json(
        {
          statusCode: 409,
          name: "sso_refused",
          reason: started.reason,
          message:
            started.reason === "connection_inactive"
              ? "Move the connection to testing before running a test sign-in."
              : "This connection cannot run a test sign-in yet.",
        },
        409,
      )
    await d.identity.store.record(tenantId, {
      type: "setup_link.test_started",
      connectionId: connection.id,
      data: { setupLinkId: linkId },
    })
    return c.json({ redirectUrl: started.redirectUrl, protocol: started.protocol })
  })

  return app
}
