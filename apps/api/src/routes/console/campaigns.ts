import type { Hono } from "hono"
import type { BroadcastInput } from "../../console/marketing.js"
import type { ConsoleDeps } from "./deps.js"
import { presentTrustedTemplate } from "../trusted-templates.js"
import {
  asNullableString,
  isRecord,
  notFound,
  notWired,
  parseDate,
  readJson,
  validation,
} from "./http.js"

/**
 * Broadcasts, and templates submitted for staff review. The workspace's own
 * templates are mounted by ./templates.ts.
 *
 * ⚠ A BROADCAST IS A DRAFT UNTIL SOMETHING ELSE SENDS IT. Nothing on this
 * surface puts mail in the queue: the routes here write the row and the
 * recipient list, and sending is a separate, metered act. That separation is
 * what makes it safe for the editor to save on every keystroke.
 */
export function mountCampaigns(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Broadcasts
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/broadcasts", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.marketing.listBroadcasts(tenantId) })
  })

  app.post("/broadcasts", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    const created = await d.marketing.createBroadcast(tenantId, {
      name,
      ...broadcastPatch(body),
    })
    // ⚠ 422 NAMING THE FIELD, NOT 404. The broadcast is fine; the segment or
    // topic it was pointed at is not this workspace's. See `assertOwned` - a
    // foreign key accepts it, because an FK check bypasses row security.
    if ("unknown" in created) return c.json(unknownTarget(created.unknown), 422)
    return c.json(created, 201)
  })

  app.get("/broadcasts/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const found = await d.marketing.getBroadcast(tenantId, c.req.param("id"))
    return found ? c.json(found) : c.json(notFound("No broadcast with that id."), 404)
  })

  app.patch("/broadcasts/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const updated = await d.marketing.updateBroadcast(
      tenantId,
      c.req.param("id"),
      broadcastPatch(body),
    )
    if (updated && "unknown" in updated) {
      return c.json(unknownTarget(updated.unknown), 422)
    }
    return updated
      ? c.json(updated)
      : c.json(
          {
            statusCode: 409,
            name: "broadcast_not_editable" as const,
            message:
              "That broadcast is no longer a draft, or does not exist. A broadcast " +
              "cannot be edited once it has started sending.",
          },
          409,
        )
  })

  app.delete("/broadcasts/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const ok = await d.marketing.deleteBroadcast(tenantId, c.req.param("id"))
    return ok
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(
          {
            statusCode: 409,
            name: "broadcast_not_deletable" as const,
            message: "A sent broadcast is a record and cannot be deleted.",
          },
          409,
        )
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Templates submitted for review (#222)
  //
  // ⚠ THE SAME STORE AS `/trusted-templates`, so a submission from the console
  // and one from the API are the same thing, limited and audited the same way.
  // Staff decide in risk-admin; nothing here can approve.
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/trusted-templates", async (c) => {
    if (!d.trustedTemplates) return c.json(notWired("Reviewed templates"), 501)
    const { tenantId } = c.get("auth")
    const rows = await d.trustedTemplates.list(tenantId)
    return c.json({ data: rows.map(presentTrustedTemplate) })
  })

  app.post("/trusted-templates", async (c) => {
    if (!d.trustedTemplates) return c.json(notWired("Reviewed templates"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name : ""
    const holes: Record<string, number> = {}
    if (isRecord(body?.holes)) {
      for (const [k, v] of Object.entries(body.holes)) {
        const n = typeof v === "number" ? v : Number(v)
        if (!Number.isFinite(n))
          return c.json(validation(`The limit for {{${k}}} must be a number.`), 422)
        holes[k] = n
      }
    }
    const r = await d.trustedTemplates.submit(
      tenantId,
      {
        name,
        html: asNullableString(body?.html),
        text: asNullableString(body?.text),
        holes,
      },
      `user:${c.get("user").userId}`,
    )
    if ("error" in r) {
      return r.code === "duplicate"
        ? c.json(
            {
              statusCode: 409,
              name: "template_already_submitted" as const,
              message: r.error,
            },
            409,
          )
        : c.json(validation(r.error), 422)
    }
    return c.json(presentTrustedTemplate(r.template), 201)
  })

  app.get("/trusted-templates/:id", async (c) => {
    if (!d.trustedTemplates) return c.json(notWired("Reviewed templates"), 501)
    const { tenantId } = c.get("auth")
    const found = await d.trustedTemplates.get(tenantId, c.req.param("id"))
    return found
      ? c.json(presentTrustedTemplate(found))
      : c.json(notFound("No submission with that id."), 404)
  })

  app.delete("/trusted-templates/:id", async (c) => {
    if (!d.trustedTemplates) return c.json(notWired("Reviewed templates"), 501)
    const { tenantId } = c.get("auth")
    const done = await d.trustedTemplates.withdraw(
      tenantId,
      c.req.param("id"),
      `user:${c.get("user").userId}`,
    )
    return done
      ? c.json(presentTrustedTemplate(done))
      : c.json(notFound("No pending or approved submission with that id."), 404)
  })
}

/**
 * The wire body of a broadcast, mapped onto the store's field names.
 *
 * ⚠ THE RETURN TYPE IS ANNOTATED, AND THAT IS NOT DECORATION - IT IS THE ONLY
 * THING THAT CATCHES THIS CLASS OF BUG. Without it this function returned
 * `{ audienceId }` while `BroadcastInput` has `segmentId`, and `topic_id` was
 * never mapped at all: a broadcast's targeting was silently dropped on every
 * write, the API answered 200, and the UI showed a success toast. TypeScript
 * did not complain because excess-property checking does not apply to a value
 * that is SPREAD into an argument - `createBroadcast(tenantId, { name, ...patch })`
 * type-checks cleanly however wrong `patch` is. An explicit
 * `Partial<BroadcastInput>` here is where the wire names and the column names
 * are forced to meet.
 */
/**
 * ⚠ THE MESSAGE NAMES THE FIELD AND NOTHING ELSE. It must not say whether the
 * id exists somewhere else in the cluster - that would make this endpoint an
 * oracle for enumerating other tenants' segment ids, which is the smaller half
 * of the problem `assertOwned` exists to close.
 */
const unknownTarget = (field: "segment_id" | "topic_id") => ({
  statusCode: 422 as const,
  name: "validation_error" as const,
  message: `No ${field === "segment_id" ? "segment" : "topic"} with that id.`,
})

export function broadcastPatch(
  body: Record<string, unknown> | null,
): Partial<BroadcastInput> {
  if (!body) return {}
  return {
    // ⚠ `segment_id`, NOT `audience_id`. The model is contacts + segments +
    // topics - see db/core.ts - and `audience` is the older vocabulary this
    // product deliberately does not use.
    ...(body.segment_id !== undefined
      ? { segmentId: asNullableString(body.segment_id) }
      : {}),
    ...(body.topic_id !== undefined
      ? { topicId: asNullableString(body.topic_id) }
      : {}),
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.from === "string" ? { from: body.from } : {}),
    ...(Array.isArray(body.reply_to)
      ? { replyTo: body.reply_to.filter((v): v is string => typeof v === "string") }
      : {}),
    ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
    ...(body.preview_text !== undefined
      ? { previewText: asNullableString(body.preview_text) }
      : {}),
    ...(body.html !== undefined ? { html: asNullableString(body.html) } : {}),
    ...(body.text !== undefined ? { text: asNullableString(body.text) } : {}),
    ...(body.scheduled_at !== undefined
      ? { scheduledAt: parseDate(asNullableString(body.scheduled_at) ?? undefined) }
      : {}),
  }
}
