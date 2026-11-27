import type { Context, Hono } from "hono"
import { mailboxAddressSchema } from "@repo/contracts"
import { ownMailboxRefusal } from "../../mail-devices/gate.js"
import type { DeviceViewer } from "../../mail-devices/service.js"
import { NO_TENANT } from "../../middleware/tenant.js"
import type { ConsoleDeps } from "./deps.js"
import { asId, isRecord, notFound, notWired, validation } from "./http.js"
import { isWorkspaceAdmin } from "./mailboxes.js"

/**
 * Mail devices in the console (#383 PR 5, PR 5b):
 *
 *   GET    /mail-devices?scope=mine|workspace&address=&cursor=
 *   DELETE /mail-devices/:id
 *   POST   /mail-devices/revoke-all   { address? }
 *
 * ⚠ WHO SEES AND REVOKES WHAT IS mail-devices/service.ts's. A member reaches
 * only their own devices; an owner or admin any of the workspace's. Anything
 * else is a 404 that says nothing, as mailboxes.ts answers.
 *
 * ⚠ WORKSPACE-OPTIONAL FOR OWN DEVICES, GATED BY THE MAILBOX'S WORKSPACE.
 * These routes run with any workspace open or none, so own-scope list, revoke
 * and revoke-all run the person's mailbox workspace's console policies (SSO,
 * second factor, IP allowlist, session age) whenever that workspace is not the
 * open one (`requireTenant` already ran them for the open workspace).
 *
 * ⚠ NO `requireFreshAuth` HERE, ON PURPOSE. A revoke only removes access, and
 * someone who has just lost a phone must not be asked to prove themselves
 * again first.
 */

const NOT_FOUND = notFound("No such mail device here.")

export function mountMailDevices(app: Hono, d: ConsoleDeps): void {
  const withViewer = async <T>(
    c: Context,
    run: (viewer: DeviceViewer) => Promise<T>,
  ): Promise<{ refused: Response } | { result: T }> => {
    const { tenantId: rawTenantId } = c.get("auth")
    const { userId } = c.get("user")
    const tenantId = rawTenantId === NO_TENANT ? null : rawTenantId
    const isAdmin =
      tenantId !== null && (await isWorkspaceAdmin(d, tenantId, userId)) === true
    let refused: Response | null = null
    let checked = false
    const allowOwn = async (): Promise<boolean> => {
      if (!checked) {
        checked = true
        refused = await ownMailboxRefusal(c, d.mailDevices!, userId, tenantId)
      }
      return refused === null
    }
    const result = await run({ userId, tenantId, isAdmin, allowOwn })
    return refused ? { refused } : { result }
  }

  app.get("/mail-devices", async (c) => {
    if (!d.mailDevices) return c.json(notWired("Mail devices"), 501)
    const rawScope = c.req.query("scope") ?? "mine"
    if (rawScope !== "mine" && rawScope !== "workspace")
      return c.json(validation("scope must be mine or workspace."), 422)
    const rawAddress = c.req.query("address")
    const address =
      rawAddress === undefined ? undefined : mailboxAddressSchema.safeParse(rawAddress)
    if (address && !address.success) return c.json(NOT_FOUND, 404)
    const cursor = c.req.query("cursor")

    const call = await withViewer(c, (viewer) =>
      d.mailDevices!.list(viewer, {
        scope: rawScope,
        ...(address ? { address: address.data } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    )
    if ("refused" in call) return call.refused
    const outcome = call.result
    if (outcome.status === "not_found") return c.json(NOT_FOUND, 404)
    if (outcome.status === "invalid") return c.json(validation(outcome.message), 422)
    return c.json(outcome.page)
  })

  app.post("/mail-devices/revoke-all", async (c) => {
    if (!d.mailDevices) return c.json(notWired("Mail devices"), 501)
    let body: Record<string, unknown> = {}
    const raw = (await c.req.raw.clone().text()).trim()
    if (raw.length > 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return c.json(validation("Request body must be a JSON object."), 422)
      }
      if (!isRecord(parsed)) {
        return c.json(validation("Request body must be a JSON object."), 422)
      }
      body = parsed
    }
    let address: string | undefined
    if (body.address !== undefined && body.address !== null) {
      const parsed = mailboxAddressSchema.safeParse(body.address)
      if (!parsed.success) return c.json(NOT_FOUND, 404)
      address = parsed.data
    }
    const call = await withViewer(c, (viewer) =>
      d.mailDevices!.revokeAll(viewer, address),
    )
    if ("refused" in call) return call.refused
    const outcome = call.result
    if (outcome.status === "not_found") return c.json(NOT_FOUND, 404)
    return c.json({ object: "mail_devices_revoked", revoked: outcome.revoked })
  })

  app.delete("/mail-devices/:id", async (c) => {
    if (!d.mailDevices) return c.json(notWired("Mail devices"), 501)
    const id = asId(c.req.param("id"))
    if (!id) return c.json(NOT_FOUND, 404)
    const call = await withViewer(c, (viewer) => d.mailDevices!.revoke(viewer, id))
    if ("refused" in call) return call.refused
    const gone = call.result
    return gone ? c.json({ deleted: true, id: gone.id }) : c.json(NOT_FOUND, 404)
  })
}
