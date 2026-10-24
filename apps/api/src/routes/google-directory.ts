import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { safeError } from "../identity/directory.js"
import type { DirectoryStore } from "../identity/directory-ports.js"
import { hashSecret, sameHash } from "../identity/model.js"
import type { AuditEvent, Logger } from "../identity/ports.js"
import { fixedWindow, trustedClientIp, type Limit } from "../identity/rate-limit.js"

/**
 * Receiver for Google Workspace Admin SDK `users.watch` push notifications
 * (#343), mounted at `/google/directory` (`POST /google/directory/notify`).
 *
 * ⚠ AUTHENTICATED BY CHANNEL ID PLUS CONSTANT-TIME SECRET HASH, AND THE BODY
 * IS NEVER TRUSTED. Google signs nothing on Admin SDK push channels; the whole
 * proof is the per-channel secret we generated at `users.watch` time and sent
 * back in `X-Goog-Channel-Token`, kept only as a SHA-256 hex digest in
 * `identity.directory_watch_channels`. A valid notification never reads its
 * JSON payload - it only enqueues a pull for the channel's directory.
 */

export interface GoogleDirectoryRouteDeps {
  store: Pick<DirectoryStore, "watchChannelById" | "directory">
  schedulePull(tenantId: string, directoryId: string): Promise<void>
  record(tenantId: string, event: AuditEvent): Promise<void>
  take: ReturnType<typeof fixedWindow>
  contextSecret: string | undefined
  limits?: Partial<{ perIp: Limit; authFailures: Limit; perDirectory: Limit }>
  log: Pick<Logger, "warn" | "error">
  now?: () => Date
}

export const NOTIFY_PER_IP: Limit = { max: 600, windowSeconds: 60 }
export const NOTIFY_AUTH_FAILURES: Limit = { max: 30, windowSeconds: 60 }
export const NOTIFY_PER_DIRECTORY: Limit = { max: 120, windowSeconds: 60 }

const channelIdHeader = z.uuid()
const channelTokenHeader = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7E]+$/)
const resourceStateHeader = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]*$/)
  .optional()

const DUMMY_HASH = hashSecret("google-directory-dummy-channel-token")

export function createGoogleDirectoryRoutes(deps?: GoogleDirectoryRouteDeps) {
  const app = new Hono()
  const now = () => (deps?.now ?? (() => new Date()))()
  const limits = {
    perIp: deps?.limits?.perIp ?? NOTIFY_PER_IP,
    authFailures: deps?.limits?.authFailures ?? NOTIFY_AUTH_FAILURES,
    perDirectory: deps?.limits?.perDirectory ?? NOTIFY_PER_DIRECTORY,
  }

  const tooMany = (c: Context, retryAfter: number) => {
    c.header("Retry-After", String(retryAfter))
    return c.json(
      {
        statusCode: 429,
        name: "rate_limit_exceeded" as const,
        message: "Too many notifications.",
      },
      429,
    )
  }

  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json(
          {
            statusCode: 413,
            name: "validation_error" as const,
            message: "Notification body is too large.",
          },
          413,
        ),
    }),
  )

  app.post("/notify", async (c) => {
    if (!deps) {
      return c.json(
        {
          statusCode: 501,
          name: "not_implemented" as const,
          message: "Google directory sync is not configured.",
        },
        501,
      )
    }

    try {
      const ip = trustedClientIp(c.req.raw.headers, deps.contextSecret)
      if (ip) {
        const verdict = await deps.take(`google-notify:ip:${ip}`, limits.perIp)
        if (!verdict.ok) return tooMany(c, verdict.retryAfter)
      }

      const refuse = async (
        status: 401 | 403 | 404,
        message: string,
        reason: string,
        known?: { tenantId: string; directoryId: string; channelId: string },
      ) => {
        const verdict = await deps.take(
          `google-notify:fail:${ip ?? "unknown"}`,
          limits.authFailures,
        )
        if (!verdict.ok) return tooMany(c, verdict.retryAfter)
        if (known) {
          await deps.record(known.tenantId, {
            type: "directory.notify_failed",
            reason,
            data: {
              directoryId: known.directoryId,
              channelId: known.channelId,
            },
          })
        }
        return c.json(
          {
            statusCode: status,
            name:
              status === 401
                ? ("invalid_access" as const)
                : status === 403
                  ? ("forbidden" as const)
                  : ("not_found" as const),
            message,
          },
          status,
        )
      }

      const parsedId = channelIdHeader.safeParse(c.req.header("x-goog-channel-id"))
      if (!parsedId.success) {
        return refuse(401, "Invalid notification channel.", "malformed_channel")
      }

      const channel = await deps.store.watchChannelById(parsedId.data)
      if (!channel) {
        sameHash(DUMMY_HASH, hashSecret(c.req.header("x-goog-channel-token") ?? ""))
        return refuse(401, "Invalid notification channel.", "unknown_channel")
      }

      const known = {
        tenantId: channel.tenantId,
        directoryId: channel.directoryId,
        channelId: channel.id,
      }

      const parsedToken = channelTokenHeader.safeParse(
        c.req.header("x-goog-channel-token"),
      )
      const presentedHash = hashSecret(parsedToken.success ? parsedToken.data : "")
      const tokenMatches =
        parsedToken.success && sameHash(channel.tokenHash, presentedHash)
      if (!tokenMatches) {
        return refuse(401, "Invalid notification token.", "invalid_token", known)
      }

      if (channel.expiresAt.getTime() <= now().getTime()) {
        return refuse(
          401,
          "Notification channel has expired.",
          "channel_expired",
          known,
        )
      }

      const directory = await deps.store.directory(
        channel.tenantId,
        channel.directoryId,
      )
      if (!directory || directory.provider !== "google") {
        return refuse(404, "Directory not found.", "no_directory", known)
      }
      if (!directory.enabled) {
        return refuse(403, "Directory is disabled.", "directory_disabled", known)
      }

      const dirVerdict = await deps.take(
        `google-notify:dir:${directory.id}`,
        limits.perDirectory,
      )
      if (!dirVerdict.ok) return tooMany(c, dirVerdict.retryAfter)

      const parsedState = resourceStateHeader.safeParse(
        c.req.header("x-goog-resource-state"),
      )
      if (!parsedState.success) {
        return c.json(
          {
            statusCode: 400,
            name: "validation_error" as const,
            message: "Invalid resource state header.",
          },
          400,
        )
      }

      // Google's initial handshake notification carries `sync`; the pull that
      // registered the channel has already run.
      if (parsedState.data?.toLowerCase() !== "sync") {
        await deps.schedulePull(channel.tenantId, directory.id)
      }

      return c.body(null, 204)
    } catch (error) {
      deps.log.error(
        { ...safeError(error), route: c.req.routePath, method: c.req.method },
        "google directory notification failed",
      )
      c.header("Retry-After", "5")
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable" as const,
          message: "The service is temporarily unavailable.",
        },
        503,
      )
    }
  })

  return app
}
