import type { Hono } from "hono"
import { PROPERTY_KEY } from "../../console/marketing.js"
import type { ConsoleDeps } from "./deps.js"
import {
  asIdArray,
  asNullableString,
  isRecord,
  notFound,
  readJson,
  validation,
} from "./http.js"

/**
 * Who a broadcast can go to: contacts, the properties that describe them, the
 * segments that group them and the topics they subscribe to.
 *
 * ⚠ NOTHING HERE EVER RE-SUBSCRIBES SOMEBODY. Re-adding a contact by hand, or
 * re-importing last quarter's CSV, must not undo an opt-out — their choice
 * outlives our imports. The rule is enforced in the store, in the one
 * `onConflictDoUpdate` that deliberately omits `unsubscribed`; these routes must
 * not find a way around it.
 */
export function mountAudience(app: Hono, d: ConsoleDeps): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Contacts
  //
  // ⚠ A CONTACT IS GLOBAL TO THE TENANT AND UNIQUE BY ADDRESS, so these are
  // top-level routes rather than nested under a list. See db/core.ts.
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/contacts", async (c) => {
    const { tenantId } = c.get("auth")
    const q = c.req.query()
    return c.json(
      await d.marketing.listContacts(tenantId, {
        ...(q.search ? { search: q.search.slice(0, 200) } : {}),
        ...(q.segment_id ? { segmentId: q.segment_id } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      }),
    )
  })

  app.post("/contacts", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const email = typeof body?.email === "string" ? body.email.trim() : ""
    if (!email.includes("@")) return c.json(validation("`email` is required."), 422)

    /*
     * ⚠ AN UPSERT, AND IT RETURNS 200 RATHER THAN 201 WHEN IT MATCHED. Adding
     * somebody who is already a contact is what a person does when they are not
     * sure — and a 409 there would be an error message for a non-error. The
     * status has to tell the truth about which happened, though: 201 claims a
     * resource came into existence, and a client that creates one row and gets
     * five 201s has been told it has five contacts. What this does NOT do is
     * resubscribe them; see `upsertContact`.
     */
    const { contact, created } = await d.marketing.upsertContact(tenantId, {
      email,
      firstName: asNullableString(body?.first_name),
      lastName: asNullableString(body?.last_name),
      unsubscribed: body?.unsubscribed === true,
      properties: isRecord(body?.properties) ? body.properties : null,
    })

    return created ? c.json(contact, 201) : c.json(contact, 200)
  })

  app.get("/contacts/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const contact = await d.marketing.getContact(tenantId, c.req.param("id"))
    return contact ? c.json(contact) : c.json(notFound("No contact with that id."), 404)
  })

  app.patch("/contacts/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    const updated = await d.marketing.updateContact(tenantId, c.req.param("id"), {
      ...(body?.first_name !== undefined
        ? { firstName: asNullableString(body.first_name) }
        : {}),
      ...(body?.last_name !== undefined
        ? { lastName: asNullableString(body.last_name) }
        : {}),
      ...(typeof body?.unsubscribed === "boolean"
        ? { unsubscribed: body.unsubscribed }
        : {}),
      ...(body?.properties !== undefined
        ? { properties: isRecord(body.properties) ? body.properties : null }
        : {}),
    })

    return updated ? c.json(updated) : c.json(notFound("No contact with that id."), 404)
  })

  app.delete("/contacts/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const removed = await d.marketing.deleteContacts(tenantId, [c.req.param("id")])
    return removed
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound("No contact with that id."), 404)
  })

  app.post("/contacts/bulk-delete", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const ids = asIdArray(body?.ids)
    // ⚠ BOUNDED. An unbounded `IN` list is a statement whose size the caller
    // chooses, and Postgres binds one parameter per element.
    if (ids.length === 0 || ids.length > 500) {
      return c.json(validation("`ids` must hold between 1 and 500 ids."), 422)
    }
    return c.json({ deleted: await d.marketing.deleteContacts(tenantId, ids) })
  })

  /**
   * CSV import.
   *
   * ⚠ THE BODY IS READ AS TEXT AND CAPPED, BECAUSE THE PARSER IS NOT A STREAM.
   * `parseContactCsv` builds the whole file in memory — the right trade for a
   * contacts export and the wrong one for a gigabyte. The cap is enforced here
   * so the refusal is an HTTP status with a message rather than an
   * out-of-memory kill.
   */
  app.post("/contacts/import", async (c) => {
    const { tenantId } = c.get("auth")
    const MAX_BYTES = 20 * 1024 * 1024

    const tooBig = {
      statusCode: 413 as const,
      name: "validation_error" as const,
      message: "That file is larger than 20 MB. Split it and import in parts.",
    }

    // ⚠ THE STREAMING CAP ABOVE IS THE REAL CONTROL — see `csvBodyLimit`. These
    // two checks stay because they produce the message that names the limit and
    // tells somebody what to do about it, and because a route that states its
    // own bound does not silently lose it if the middleware is ever reordered.
    const declared = Number(c.req.header("content-length") ?? "0")
    if (declared > MAX_BYTES) return c.json(tooBig, 413)

    const csv = await c.req.text()
    // ⚠ CHECKED AGAIN AFTER READING. `Content-Length` is a claim, not a fact —
    // a chunked request carries none at all, so the header check is an early
    // out rather than the control.
    if (csv.length > MAX_BYTES) return c.json(tooBig, 413)

    return c.json(await d.marketing.importContacts(tenantId, csv))
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Contact properties
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/contact-properties", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.marketing.listProperties(tenantId) })
  })

  app.post("/contact-properties", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const key = typeof body?.key === "string" ? body.key.trim() : ""

    // ⚠ THE SAME SHAPE THE MERGE-TAG SYNTAX CAN ADDRESS. A key with a space or
    // a brace in it can be stored and can never be referenced from a template,
    // so it is refused at the door rather than becoming a field that silently
    // does nothing.
    if (!PROPERTY_KEY.test(key)) {
      return c.json(
        validation("`key` must be 1-50 characters of letters, digits or underscore."),
        422,
      )
    }

    const type = body?.type
    if (type !== "string" && type !== "number" && type !== "boolean") {
      return c.json(validation('`type` must be "string", "number" or "boolean".'), 422)
    }

    const created = await d.marketing.createProperty(tenantId, {
      key,
      type,
      fallbackValue: asNullableString(body?.fallback_value),
    })

    return "conflict" in created
      ? c.json(
          {
            statusCode: 409,
            name: "property_already_exists" as const,
            message: "A property with that key already exists.",
          },
          409,
        )
      : c.json(created, 201)
  })

  app.delete("/contact-properties/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const ok = await d.marketing.deleteProperty(tenantId, c.req.param("id"))
    return ok ? c.json({ id: c.req.param("id"), deleted: true }) : c.json(notFound(), 404)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Segments
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/segments", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.marketing.listSegments(tenantId) })
  })

  app.post("/segments", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    return c.json(
      await d.marketing.createSegment(tenantId, {
        name,
        description: asNullableString(body?.description),
      }),
      201,
    )
  })

  app.patch("/segments/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const ok = await d.marketing.updateSegment(tenantId, c.req.param("id"), {
      ...(typeof body?.name === "string" ? { name: body.name } : {}),
      ...(body?.description !== undefined
        ? { description: asNullableString(body.description) }
        : {}),
    })
    return ok ? c.json({ id: c.req.param("id"), updated: true }) : c.json(notFound(), 404)
  })

  app.delete("/segments/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const removed = await d.marketing.deleteSegments(tenantId, [c.req.param("id")])
    return removed
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound(), 404)
  })

  app.post("/segments/:id/contacts", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const ids = asIdArray(body?.contact_ids)
    if (ids.length === 0 || ids.length > 500) {
      return c.json(validation("`contact_ids` must hold between 1 and 500 ids."), 422)
    }
    const added = await d.marketing.addToSegment(tenantId, c.req.param("id"), ids)
    // ⚠ `null` IS "NO SUCH SEGMENT HERE", WHICH IS A 404 RATHER THAN AN `added:
    // 0`. Reporting zero would tell the console the button worked.
    if (added === null) return c.json(notFound("No segment with that id."), 404)
    return c.json({ added })
  })

  app.post("/segments/:id/contacts/remove", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const ids = asIdArray(body?.contact_ids)
    if (ids.length === 0 || ids.length > 500) {
      return c.json(validation("`contact_ids` must hold between 1 and 500 ids."), 422)
    }
    return c.json({
      removed: await d.marketing.removeFromSegment(tenantId, c.req.param("id"), ids),
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Topics
  // ───────────────────────────────────────────────────────────────────────────

  app.get("/topics", async (c) => {
    const { tenantId } = c.get("auth")
    return c.json({ data: await d.marketing.listTopics(tenantId) })
  })

  app.post("/topics", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return c.json(validation("`name` is required."), 422)

    const defaultSubscription = body?.default_subscription
    if (defaultSubscription !== "opt_in" && defaultSubscription !== "opt_out") {
      return c.json(
        validation('`default_subscription` must be "opt_in" or "opt_out".'),
        422,
      )
    }

    const visibility = body?.visibility === "private" ? "private" : "public"

    return c.json(
      await d.marketing.createTopic(tenantId, {
        name,
        description: asNullableString(body?.description),
        defaultSubscription,
        visibility,
      }),
      201,
    )
  })

  app.patch("/topics/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)

    /*
     * ⚠ `default_subscription` IS REFUSED RATHER THAN IGNORED. Flipping a topic
     * from opt-out to opt-in would retroactively subscribe everybody who never
     * answered — marketing mail to people who did not ask for it, because of a
     * dropdown. Silently dropping the field would let a caller believe it
     * worked; a 422 says what the rule is.
     */
    if (body?.default_subscription !== undefined) {
      return c.json(
        validation(
          "`default_subscription` cannot be changed after a topic is created — " +
            "it would retroactively change what every contact has agreed to. " +
            "Create a new topic instead.",
        ),
        422,
      )
    }

    const ok = await d.marketing.updateTopic(tenantId, c.req.param("id"), {
      ...(typeof body?.name === "string" ? { name: body.name } : {}),
      ...(body?.description !== undefined
        ? { description: asNullableString(body.description) }
        : {}),
      ...(body?.visibility === "private" || body?.visibility === "public"
        ? { visibility: body.visibility }
        : {}),
    })

    return ok ? c.json({ id: c.req.param("id"), updated: true }) : c.json(notFound(), 404)
  })

  app.delete("/topics/:id", async (c) => {
    const { tenantId } = c.get("auth")
    const ok = await d.marketing.deleteTopic(tenantId, c.req.param("id"))
    return ok ? c.json({ id: c.req.param("id"), deleted: true }) : c.json(notFound(), 404)
  })

  app.put("/contacts/:id/topics/:topicId", async (c) => {
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    if (typeof body?.subscribed !== "boolean") {
      return c.json(validation("`subscribed` must be true or false."), 422)
    }

    const set = await d.marketing.setTopicSubscription(
      tenantId,
      c.req.param("id"),
      c.req.param("topicId"),
      body.subscribed,
    )
    if (!set) {
      return c.json(notFound("No contact or topic with that id."), 404)
    }
    return c.json({ subscribed: body.subscribed })
  })
}
