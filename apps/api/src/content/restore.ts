import { inArray } from "drizzle-orm"
import { contentTemplates } from "../db/core.js"
import { restore, type Template } from "./templates.js"

/**
 * Rebuilding bodies stored as a template plus values (#171).
 *
 * ⚠ EVERY READER OF `message_bodies` GOES THROUGH HERE: the worker's claim,
 * `GET /emails/:id`, the console's email detail, and the risk engine's content
 * sampler. A reader that skipped it would show an empty email for every
 * compacted message, silently - which is why there is one function and not
 * four copies of the join.
 *
 * ⚠ IN THE CALLER'S TRANSACTION, so the template is read under the same
 * `app.tenant_id` as the body and RLS guarantees it is this workspace's own.
 */
export interface StoredBody {
  html: string | null
  text: string | null
  templateId?: string | null
  templateValues?: unknown
}

interface Tx {
  select: (fields: {
    id: typeof contentTemplates.id
    segments: typeof contentTemplates.segments
  }) => {
    from: (t: typeof contentTemplates) => {
      where: (
        w: ReturnType<typeof inArray>,
      ) => Promise<{ id: string; segments: unknown }[]>
    }
  }
}

export async function restoreBodies<T extends StoredBody>(
  tx: unknown,
  rows: T[],
): Promise<T[]> {
  // ⚠ ONLY COMPACTED ROWS - both originals released. A row merely LINKED to a
  // template still holds its own bytes, and those are the truth.
  const compacted = (r: StoredBody) =>
    Boolean(r.templateId) && r.html === null && r.text === null
  const ids = [...new Set(rows.filter(compacted).map((r) => r.templateId) as string[])]
  if (ids.length === 0) return rows
  const templates = await (tx as Tx)
    .select({ id: contentTemplates.id, segments: contentTemplates.segments })
    .from(contentTemplates)
    .where(inArray(contentTemplates.id, ids))
  const byId = new Map(
    templates.map((t) => [
      t.id,
      { segments: t.segments as string[] } satisfies Template,
    ]),
  )
  return rows.map((row) => {
    if (!compacted(row)) return row
    const template = byId.get(row.templateId!)
    const values = Array.isArray(row.templateValues)
      ? (row.templateValues as string[])
      : null
    if (!template || !values) {
      // ⚠ LOUD, NOT EMPTY. A compacted row whose template is gone is data loss
      // we must see; rendering it as an empty email would hide it for ever.
      throw new Error(
        `message body references template ${row.templateId}, which cannot be read`,
      )
    }
    const { html, text } = restore(template, values)
    return { ...row, html, text }
  })
}
