import { objectKey, type ObjectStore } from "./object-store.js"

/**
 * Data-URI images inside stored HTML, moved to R2 by content hash (#168).
 *
 * A body like `<img src="data:image/png;base64,iVBORw0...">` carries its image
 * in the HTML itself - often the same 40 KB logo in every message a workspace
 * sends. The content-store job, after the send, lifts each such payload out of
 * the STORED body into R2 (per workspace, `<tenant>/sha256/<hex>`, the same
 * objects attachments use) and leaves a reference in its place:
 *
 *   data:image/png;base64,<U+0003><sha256><U+0003>
 *
 * ⚠ ONLY THE PAYLOAD IS REPLACED; THE `data:...;base64,` PREFIX STAYS. So the
 * mime type, and any parameters, are the original bytes, and restoring is one
 * substitution per reference.
 *
 * ⚠ NEVER ON WHAT IS SENT (#188, #189). This runs on finished messages only,
 * and every reader restores before it looks: the worker (a retry), `GET
 * /emails/:id`, the console, and the risk passes.
 *
 * ⚠ BYTE-EXACT BY REFUSAL. A payload is extracted only if re-encoding its
 * decoded bytes gives back the identical string - no line breaks, no
 * whitespace, standard alphabet, canonical padding. Anything else stays inline,
 * because the reference restores the canonical encoding, and a body that
 * restored "equivalent" base64 would not be the body that was sent. A body
 * that already contains U+0003 is left alone entirely, so a reference can
 * never be confused with the customer's own text.
 *
 * ⚠ THE REFERENCE SURVIVES TEMPLATE COMPACTION UNCHANGED. Extraction runs
 * first, so a template's skeleton - or a message's values - hold references,
 * not base64; restoring a compacted body rebuilds the references first
 * (content/restore.ts) and then this fills them in. The body row keeps the list
 * of hashes it references (`inline_objects`), which is what the object sweep
 * counts, however the body is stored.
 */

export const MARK = "\u0003"

/** Payloads smaller than this cost more as an object than they save. */
export const MIN_PAYLOAD_CHARS = 1_024

const DATA_URI =
  /(data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9.+=_-]+)*;base64,)([A-Za-z0-9+/]+={0,2})/g
const REFERENCE = new RegExp(`${MARK}([0-9a-f]{64})${MARK}`, "g")

const sha256Hex = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

export interface Extracted {
  html: string
  /** By hash: the decoded bytes and the mime type from the URI. */
  objects: Map<string, { bytes: Uint8Array; type: string }>
}

/** The body with its large, canonical data-URI payloads replaced, or null. */
export function extractDataUris(html: string): Extracted | null {
  if (html.includes(MARK)) return null
  const objects: Extracted["objects"] = new Map()
  const out = html.replace(DATA_URI, (whole, prefix: string, payload: string) => {
    if (payload.length < MIN_PAYLOAD_CHARS) return whole
    const bytes = Buffer.from(payload, "base64")
    if (bytes.toString("base64") !== payload) return whole
    const sha256 = sha256Hex(bytes)
    const type = prefix.slice(5, prefix.indexOf(";"))
    objects.set(sha256, { bytes, type })
    return `${prefix}${MARK}${sha256}${MARK}`
  })
  if (objects.size === 0) return null
  // ⚠ CHECKED ANYWAY. By construction the substitution reverses exactly; this
  // is the last gate before the original is released, as in templates.ts.
  const back = fill(out, (sha) =>
    Buffer.from(objects.get(sha)!.bytes).toString("base64"),
  )
  return back === html ? { html: out, objects } : null
}

/** The hashes a stored body references. */
export function inlineReferences(html: string | null): string[] {
  if (!html || !html.includes(MARK)) return []
  return [...new Set([...html.matchAll(REFERENCE)].map((m) => m[1]!))]
}

function fill(html: string, base64: (sha256: string) => string): string {
  return html.replace(REFERENCE, (_, sha: string) => base64(sha))
}

export interface InlineRow {
  html: string | null
  inlineObjects?: string[] | null
}

/**
 * Puts the images back into bodies read from storage, AFTER `restoreBodies`.
 *
 * ⚠ LOUD WHEN IT CANNOT. A body with references and no store to read them
 * from is a body we cannot show or resend as it was sent; an empty image would
 * hide that for ever. Rows without references pass through untouched, and no
 * store is needed for them.
 *
 * ⚠ ONE READ PER OBJECT PER CALL. Fifty compacted receipts with the same logo
 * fetch it once.
 */
export async function restoreInline<T extends InlineRow>(
  store: ObjectStore | null,
  tenantId: string,
  rows: T[],
): Promise<T[]> {
  const needed = rows.filter((r) => r.html && (r.inlineObjects?.length ?? 0) > 0)
  if (needed.length === 0) return rows
  if (!store) {
    throw new Error(
      "message body has images in the content store, and no content store is configured",
    )
  }
  const cache = new Map<string, Promise<string>>()
  const read = (sha: string) => {
    let hit = cache.get(sha)
    if (!hit) {
      hit = store
        .get(objectKey(tenantId, sha))
        .then((b) => Buffer.from(b).toString("base64"))
      cache.set(sha, hit)
    }
    return hit
  }
  return Promise.all(
    rows.map(async (row) => {
      if (!row.html || !(row.inlineObjects?.length ?? 0)) return row
      const refs = inlineReferences(row.html)
      const payloads = new Map(
        await Promise.all(refs.map(async (s) => [s, await read(s)] as const)),
      )
      return { ...row, html: fill(row.html, (sha) => payloads.get(sha)!) }
    }),
  )
}
