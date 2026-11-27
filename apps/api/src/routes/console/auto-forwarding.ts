import type { Context, Hono } from "hono"
import { setAutoForwardingSchema } from "@repo/contracts"
import { freshAuthRefusal } from "../../middleware/session.js"
import type { ConsoleDeps } from "./deps.js"
import { notWired, readJson, validation } from "./http.js"

/**
 * Per-workspace automatic forwarding policy (#526):
 *
 *   GET   /workspace/auto-forwarding   read current mode (owners and admins)
 *   PATCH /workspace/auto-forwarding   change mode (owners and admins, step-up, audited)
 *
 * ⚠ REFUSAL ORDER: role first, then step-up, then body validation. A member
 * must receive 403 `forbidden` without being prompted for step-up, and an admin
 * with a stale session must be asked to step up before the body is inspected.
 */

const forbidden = (message: string) =>
  ({ statusCode: 403, name: "forbidden" as const, message }) as const

const actorOf = (c: Context) => ({
  tenantId: c.get("auth").tenantId,
  userId: c.get("user").userId,
})

export function mountAutoForwarding(app: Hono, d: ConsoleDeps): void {
  app.get("/workspace/auto-forwarding", async (c) => {
    const forwarding = d.autoForwarding
    if (!forwarding) return c.json(notWired("Automatic forwarding"), 501)

    const { tenantId, userId } = actorOf(c)
    if (!(await forwarding.isAdmin(tenantId, userId))) {
      return c.json(
        forbidden("Only an owner or admin can view automatic forwarding settings."),
        403,
      )
    }

    return c.json({ mode: await forwarding.store.get(tenantId) })
  })

  app.patch("/workspace/auto-forwarding", async (c) => {
    const forwarding = d.autoForwarding
    if (!forwarding) return c.json(notWired("Automatic forwarding"), 501)

    const { tenantId, userId } = actorOf(c)
    if (!(await forwarding.isAdmin(tenantId, userId))) {
      return c.json(
        forbidden("Only an owner or admin can change automatic forwarding settings."),
        403,
      )
    }

    const stepUp = await freshAuthRefusal(c)
    if (stepUp) return stepUp

    const parsed = setAutoForwardingSchema.safeParse(await readJson(c))
    if (!parsed.success) {
      return c.json(
        validation(
          parsed.error.issues[0]?.message ??
            "mode must be one of workspace, workspace_and_members, anywhere or off.",
        ),
        422,
      )
    }

    const done = await forwarding.store.set(tenantId, userId, parsed.data.mode)
    return c.json({ mode: done.after })
  })
}
