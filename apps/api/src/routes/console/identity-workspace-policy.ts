import type { Context, Hono } from "hono"
import { z } from "zod"
import type { ConsoleDeps } from "./deps.js"
import { notWired, readJson, validation } from "./http.js"
import { requireFreshAuth } from "../../middleware/session.js"
import { can, type Permission } from "../../console/roles.js"
import {
  MAX_RANGES,
  clientAddress,
  formatAddress,
  inRanges,
  normaliseRanges,
  readRanges,
} from "../../identity/network.js"
import {
  IDLE_TIMEOUT_SECONDS_LIMIT,
  IDLE_TIMEOUT_SECONDS_MIN,
  MAX_SESSION_SECONDS_LIMIT,
  MAX_SESSION_SECONDS_MIN,
  type WorkspaceGate,
} from "../../identity/workspace-policy.js"
import type { WorkspacePolicyStore } from "../../identity/ports.js"

/**
 * The workspace's session policy, second-factor rule and IP allowlist (#345,
 * sso.md 2.5 and 2.11). The screens are a later slice; these are the routes.
 *
 *   GET /identity/session-policy        the limits, and the bounds they must sit in
 *   PUT /identity/session-policy        { maxSessionSeconds, idleTimeoutSeconds } (owner, step-up)
 *   GET /identity/second-factor-policy  whether members outside SSO need a second factor
 *   PUT /identity/second-factor-policy  { required } (owner, step-up)
 *   GET /identity/ip-allowlist          the ranges, the switches, and the caller's address
 *   PUT /identity/ip-allowlist          { console, apiKeys, ranges, confirmLockout? } (owner, step-up)
 *
 * ⚠ READING IS AN ADMIN'S (`sso:manage`), CHANGING IS AN OWNER'S WITH STEP-UP,
 * every change audited with the actor and what it was before and after. These
 * decide who can reach the workspace at all, so they sit with the other
 * settings an admin must not be able to loosen (sso.md 2.14).
 *
 * ⚠ AN OWNER CANNOT LOCK THEMSELVES OUT. Saving a console allowlist that
 * leaves out the saver's current address is refused with 422 `would_lock_out`
 * unless they confirm; and even then the saver's own address stays allowed for
 * ten minutes (`GRACE_MS`), so the session that saved the list can still undo
 * it. An address we cannot determine counts as not listed.
 */

/** How long a confirmed lockout still lets the saving owner's address in. */
export const GRACE_MS = 10 * 60 * 1000

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const SessionBody = z
  .object({
    maxSessionSeconds: z
      .number()
      .int()
      .min(MAX_SESSION_SECONDS_MIN)
      .max(MAX_SESSION_SECONDS_LIMIT)
      .nullable(),
    idleTimeoutSeconds: z
      .number()
      .int()
      .min(IDLE_TIMEOUT_SECONDS_MIN)
      .max(IDLE_TIMEOUT_SECONDS_LIMIT)
      .nullable(),
  })
  .strict()

const FactorBody = z.object({ required: z.boolean() }).strict()

const NetworkBody = z
  .object({
    console: z.boolean(),
    apiKeys: z.boolean(),
    ranges: z.array(z.string().max(64)).max(MAX_RANGES),
    confirmLockout: z.boolean().optional(),
  })
  .strict()

export interface WorkspacePolicyConsoleDeps {
  store: WorkspacePolicyStore
  /** The gate's cache, dropped when the policy changes. */
  gate: Pick<WorkspaceGate, "forgetTenant">
  /** `CLIENT_CONTEXT_SECRET`, for the saving owner's address. */
  contextSecret: string | undefined
}

export function mountIdentityWorkspacePolicy(app: Hono, d: ConsoleDeps): void {
  const allowed = async (c: Context, permission: Permission) => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return Boolean(d.roles && (await can(d.roles.store, tenantId, userId, permission)))
  }

  /** The policy deps after the permission check, or the response that says why not. */
  const load = async (c: Context, permission: Permission) => {
    const id = d.identity
    if (!id?.workspacePolicy)
      return { error: c.json(notWired("Workspace session and network policies"), 501) }
    if (!(await allowed(c, permission)))
      return {
        error: c.json(
          forbidden(
            permission === "owners:manage"
              ? "Only an owner can change these settings."
              : "Only an admin can see these settings.",
          ),
          403,
        ),
      }
    return { id, wp: id.workspacePolicy, tenantId: c.get("auth").tenantId }
  }

  // ── Session policy ─────────────────────────────────────────────────────

  app.get("/identity/session-policy", async (c) => {
    const loaded = await load(c, "sso:manage")
    if ("error" in loaded) return loaded.error
    const policy = await loaded.wp.store.policy(loaded.tenantId)
    return c.json({
      maxSessionSeconds: policy.maxSessionSeconds,
      idleTimeoutSeconds: policy.idleTimeoutSeconds,
      bounds: {
        maxSessionSeconds: {
          min: MAX_SESSION_SECONDS_MIN,
          max: MAX_SESSION_SECONDS_LIMIT,
        },
        idleTimeoutSeconds: {
          min: IDLE_TIMEOUT_SECONDS_MIN,
          max: IDLE_TIMEOUT_SECONDS_LIMIT,
        },
      },
    })
  })

  app.put("/identity/session-policy", requireFreshAuth, async (c) => {
    const loaded = await load(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const parsed = SessionBody.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(
          `Give maxSessionSeconds (${MAX_SESSION_SECONDS_MIN} to ${MAX_SESSION_SECONDS_LIMIT}) and idleTimeoutSeconds (${IDLE_TIMEOUT_SECONDS_MIN} to ${IDLE_TIMEOUT_SECONDS_LIMIT}), each a whole number of seconds or null for no limit.`,
        ),
        422,
      )
    const done = await loaded.wp.store.update(loaded.tenantId, c.get("user").userId, {
      kind: "session",
      ...parsed.data,
    })
    loaded.wp.gate.forgetTenant(loaded.tenantId)
    return c.json({
      maxSessionSeconds: done.after.maxSessionSeconds,
      idleTimeoutSeconds: done.after.idleTimeoutSeconds,
    })
  })

  // ── Second factor ──────────────────────────────────────────────────────

  app.get("/identity/second-factor-policy", async (c) => {
    const loaded = await load(c, "sso:manage")
    if ("error" in loaded) return loaded.error
    const policy = await loaded.wp.store.policy(loaded.tenantId)
    return c.json({ required: policy.requireSecondFactor })
  })

  app.put("/identity/second-factor-policy", requireFreshAuth, async (c) => {
    const loaded = await load(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const parsed = FactorBody.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(validation("required must be true or false."), 422)
    const done = await loaded.wp.store.update(loaded.tenantId, c.get("user").userId, {
      kind: "second_factor",
      required: parsed.data.required,
    })
    loaded.wp.gate.forgetTenant(loaded.tenantId)
    return c.json({ required: done.after.requireSecondFactor })
  })

  // ── IP allowlist ───────────────────────────────────────────────────────

  const loadNetwork = async (
    c: Context,
    loaded: { wp: WorkspacePolicyConsoleDeps; tenantId: string },
  ) => ({
    policy: await loaded.wp.store.policy(loaded.tenantId),
    address: clientAddress(c.req.raw.headers, loaded.wp.contextSecret),
  })

  app.get("/identity/ip-allowlist", async (c) => {
    const loaded = await load(c, "sso:manage")
    if ("error" in loaded) return loaded.error
    const { policy, address } = await loadNetwork(c, loaded)
    const here = address ? inRanges(address, readRanges(policy.network.ranges)) : false
    return c.json({
      console: policy.network.console,
      apiKeys: policy.network.apiKeys,
      ranges: policy.network.ranges,
      maxRanges: MAX_RANGES,
      yourAddress: address ? formatAddress(address) : null,
      yourAddressListed: here,
      // The grace is the saver's own: nobody else is told it exists.
      graceUntil:
        policy.network.grace?.userId === c.get("user").userId
          ? policy.network.grace.until
          : null,
    })
  })

  app.put("/identity/ip-allowlist", requireFreshAuth, async (c) => {
    const loaded = await load(c, "owners:manage")
    if ("error" in loaded) return loaded.error
    const { wp, tenantId } = loaded
    const parsed = NetworkBody.safeParse((await readJson(c)) ?? {})
    if (!parsed.success)
      return c.json(
        validation(
          `Give console and apiKeys (true or false) and ranges, at most ${MAX_RANGES} CIDR ranges or addresses.`,
        ),
        422,
      )
    const body = parsed.data
    const normal = normaliseRanges(body.ranges)
    if (!normal.ok)
      return c.json(
        validation(
          normal.error === "too_many"
            ? `A workspace can list at most ${MAX_RANGES} ranges.`
            : `Range ${(normal.index ?? 0) + 1} is not a valid IPv4 or IPv6 address or CIDR range (a /0 is not allowed).`,
        ),
        422,
      )
    if ((body.console || body.apiKeys) && normal.ranges.length === 0)
      return c.json(
        validation(
          "Add at least one range before turning the allowlist on, or nobody could reach the workspace.",
        ),
        422,
      )

    const { userId } = c.get("user")
    const address = clientAddress(c.req.raw.headers, wp.contextSecret)
    let grace: { userId: string; address: string; until: Date } | null = null
    let lockoutConfirmed = false
    if (body.console && !(address && inRanges(address, readRanges(normal.ranges)))) {
      // ⚠ THE GUARD: this list would end the saver's own session.
      if (body.confirmLockout !== true)
        return c.json(
          {
            statusCode: 422,
            name: "would_lock_out",
            message:
              "Your current address is not in this list, so saving it would lock you out of the console. Add your address, or confirm that you want to continue.",
            yourAddress: address ? formatAddress(address) : null,
          },
          422,
        )
      lockoutConfirmed = true
      if (address)
        grace = {
          userId,
          address: formatAddress(address),
          until: new Date(Date.now() + GRACE_MS),
        }
    }
    const done = await wp.store.update(tenantId, userId, {
      kind: "network",
      console: body.console,
      apiKeys: body.apiKeys,
      ranges: normal.ranges,
      grace,
      lockoutConfirmed,
    })
    wp.gate.forgetTenant(tenantId)
    return c.json({
      console: done.after.network.console,
      apiKeys: done.after.network.apiKeys,
      ranges: done.after.network.ranges,
      graceUntil: done.after.network.grace?.until ?? null,
    })
  })
}
