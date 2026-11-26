import type { Context, Hono } from "hono"
import { mailboxAddressSchema } from "@repo/contracts"
import type { DeviceViewer } from "../../mail-devices/service.js"
import type { ConsoleDeps } from "./deps.js"
import { notFound, notWired, readJson, validation } from "./http.js"
import { isWorkspaceAdmin } from "./mailboxes.js"

/**
 * Mail devices in the console (#383 PR 5):
 *
 *   GET    /mail-devices?scope=mine|workspace&address=&cursor=
 *   DELETE /mail-devices/:id
 *   POST   /mail-devices/revoke-all   { address? }
 *
 * ⚠ WHO SEES AND REVOKES WHAT IS mail-devices/service.ts's. A member reaches
 * only their own devices; an owner or admin any of the workspace's. Anything
 * else is a 404 that says nothing, as mailboxes.ts answers.
 *
 * ⚠ NO `requireFreshAuth` HERE, ON PURPOSE. A revoke only removes access, and
 * someone who has just lost a phone must not be asked to prove themselves
 * again first.
 */

const NOT_FOUND = notFound("No such mail device here.")

export function mountMailDevices(app: Hono, d: ConsoleDeps): void {
  const viewerOf = async (c: Context): Promise<DeviceViewer> => {
    const { tenantId } = c.get("auth")
    const { userId } = c.get("user")
    return {
      userId,
      tenantId,
      isAdmin: (await isWorkspaceAdmin(d, tenantId, userId)) === true,
    }
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

    const outcome = await d.mailDevices.list(await viewerOf(c), {
      scope: rawScope,
      ...(address ? { address: address.data } : {}),
      ...(cursor ? { cursor } : {}),
    })
    if (outcome.status === "not_found") return c.json(NOT_FOUND, 404)
    if (outcome.status === "invalid") return c.json(validation(outcome.message), 422)
    return c.json(outcome.page)
  })

  app.post("/mail-devices/revoke-all", async (c) => {
    if (!d.mailDevices) return c.json(notWired("Mail devices"), 501)
    const body = (await readJson(c)) ?? {}
    let address: string | undefined
    if (body.address !== undefined && body.address !== null) {
      const parsed = mailboxAddressSchema.safeParse(body.address)
      if (!parsed.success) return c.json(NOT_FOUND, 404)
      address = parsed.data
    }
    const outcome = await d.mailDevices.revokeAll(await viewerOf(c), address)
    if (outcome.status === "not_found") return c.json(NOT_FOUND, 404)
    return c.json({ object: "mail_devices_revoked", revoked: outcome.revoked })
  })

  app.delete("/mail-devices/:id", async (c) => {
    if (!d.mailDevices) return c.json(notWired("Mail devices"), 501)
    const gone = await d.mailDevices.revoke(await viewerOf(c), c.req.param("id"))
    return gone ? c.json({ deleted: true, id: gone.id }) : c.json(NOT_FOUND, 404)
  })
}
