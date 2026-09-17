import type { Hono } from "hono"
import type { BroadcastInput } from "../../console/marketing.js"
import type { ConsoleDeps } from "./deps.js"
import { asNullableString, notFound, parseDate, readJson, validation } from "./http.js"

/**
 * Broadcasts and the templates they are written from.
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
    // topic it was pointed at is not this workspace's. See `assertOwned` — a
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
  // Templates
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/templates", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.marketing.listTemplates(tenantId) })
  })

  app.post("/templates", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    const created = await d.marketing.createTemplate(tenantId, {
      name,
      folder: asNullableString(body?.folder),
    })

    return "conflict" in created
      ? c.json(
          {
            statusCode: 409,
            name: "template_already_exists" as const,
            message: "A template with that name already exists.",
          },
          409,
        )
      : c.json(created, 201)
  })

  app.get("/templates/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const found = await d.marketing.getTemplate(tenantId, c.req.param("id"))
    return found ? c.json(found) : c.json(notFound("No template with that id."), 404)
  })

  app.patch("/templates/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const updated = await d.marketing.updateTemplate(tenantId, c.req.param("id"), {
      ...(typeof body?.name === "string" ? { name: body.name } : {}),
      ...(body?.folder !== undefined ? { folder: asNullableString(body.folder) } : {}),
      ...(body?.subject !== undefined
        ? { subject: asNullableString(body.subject) }
        : {}),
      ...(body?.html !== undefined ? { html: asNullableString(body.html) } : {}),
      ...(body?.text !== undefined ? { text: asNullableString(body.text) } : {}),
    })
    return updated
      ? c.json(updated)
      : c.json(notFound("No template with that id."), 404)
  })

  /**
   * ⚠ PUBLISHING IS A SEPARATE ACT FROM SAVING, AND THAT IS THE WHOLE DESIGN OF
   * THIS RESOURCE. A template is referenced by id from production code that is
   * sending mail right now; editing it must not change what goes out mid-
   * sentence. `html` is what the editor shows and `published_html` is what a
   * send renders, and this is the one operation that copies one to the other.
   */
  app.post("/templates/:id/publish", async (c) => {
    const { tenantId } = c.get("auth")
    const published = await d.marketing.publishTemplate(tenantId, c.req.param("id"))
    return published
      ? c.json(published)
      : c.json(notFound("No template with that id."), 404)
  })

  app.delete("/templates/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const ok = await d.marketing.deleteTemplate(tenantId, c.req.param("id"))
    return ok
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound(), 404)
  })
}

/**
 * The wire body of a broadcast, mapped onto the store's field names.
 *
 * ⚠ THE RETURN TYPE IS ANNOTATED, AND THAT IS NOT DECORATION — IT IS THE ONLY
 * THING THAT CATCHES THIS CLASS OF BUG. Without it this function returned
 * `{ audienceId }` while `BroadcastInput` has `segmentId`, and `topic_id` was
 * never mapped at all: a broadcast's targeting was silently dropped on every
 * write, the API answered 200, and the UI showed a success toast. TypeScript
 * did not complain because excess-property checking does not apply to a value
 * that is SPREAD into an argument — `createBroadcast(tenantId, { name, ...patch })`
 * type-checks cleanly however wrong `patch` is. An explicit
 * `Partial<BroadcastInput>` here is where the wire names and the column names
 * are forced to meet.
 */
/**
 * ⚠ THE MESSAGE NAMES THE FIELD AND NOTHING ELSE. It must not say whether the
 * id exists somewhere else in the cluster — that would make this endpoint an
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
    // topics — see db/core.ts — and `audience` is the older vocabulary this
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
