import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { fingerprint } from "../risk/fingerprint.js"
import { putObjects } from "./attachments.js"
import { extractDataUris } from "./inline.js"
import type { ObjectStore } from "./object-store.js"
import {
  compactable,
  derive,
  joinBody,
  restore,
  skeletonHash,
  staticBytes,
  type Template,
} from "./templates.js"

/**
 * Template compaction, per workspace, in the content-store job (#169, #171).
 *
 * One pass does three things:
 *   1. EXAMINE the workspace's finished bodies it has not looked at yet: match
 *      each to a template the workspace already has, or derive a new one from
 *      two near-duplicates - in this batch, or one examined earlier.
 *   2. LINK what fits: template and values recorded, the original kept, and
 *      the template's count raised once.
 *   3. PROMOTE: compact every linked body whose template has now been seen
 *      `promoteAt` times - static skeleton once, values per message - after a
 *      byte-exact check.
 *
 * ⚠ EVERY PASS MAKES PROGRESS, AND THAT IS THE BUG THIS REPLACES. The old pass
 * read the oldest uncompacted bodies of the last week. Unique mail is never
 * compacted and nothing recorded that it had been looked at, so once a
 * workspace had `limit` unique finished bodies, every run re-read exactly
 * those and never reached newer mail. Now every body read is stamped
 * `examined_at`, and the next pass starts after it.
 *
 * ⚠ AND STAMPING MUST NOT COST THE PAIRING. A template is derived from TWO
 * near-duplicates. A unique body is examined once and never read again, so it
 * keeps its MinHash bands in `content_bands`; its twin, arriving in a later
 * pass, finds it through the GIN index and reads only the handful of bodies
 * that share a band.
 *
 * ⚠ PROMOTION IS BY TEMPLATE, NOT BY RESCAN. A body linked while its template
 * was below `promoteAt` is compacted when a later pass pushes the template
 * over, found through the linked-body index - not by re-reading everything.
 *
 * ⚠ ONLY FINISHED MESSAGES. Sent, failed or canceled - never queued or
 * sending, so nothing the worker might still read is rewritten under it.
 *
 * ⚠ NOT A RISK FEATURE. It runs whether RISK_ENABLED is on or off, for every
 * workspace including our own system tenant, whose sign-in codes are the most
 * templated mail we send.
 */
export interface CompactDeps {
  db: Database
  /**
   * Where data-URI images go (#168). Absent: they stay in the html, and
   * compaction runs exactly as before.
   */
  store?: ObjectStore | null
  now?: Date
  /** Unexamined bodies per workspace per pass. */
  limit?: number
  /** Linked bodies compacted per workspace per pass. */
  promoteLimit?: number
  /** Matches a template needs before bodies are compacted against it. */
  promoteAt?: number
  /** How far back a body is still worth examining. */
  windowDays?: number
  log?: { warn?: (o: object, m: string) => void }
}

export interface CompactResult {
  /** Bodies examined, whatever the outcome. */
  scanned: number
  /** Bodies whose data-URI images moved to R2 this pass (#168). */
  extracted: number
  /** Base64 characters that left the html. */
  inlineBytes: number
  /** Bodies newly linked to a template. */
  matched: number
  derived: number
  compacted: number
  bytesSaved: number
}

/** Matches before a template compacts, unless a caller says otherwise. */
export const PROMOTE_AT = 3
/** A body older than this is left as it is. */
export const WINDOW_DAYS = 7

interface Body {
  /** Set when an earlier pass linked it to a template not yet established. */
  linkedTo: string | null
  messageId: string
  createdAt: string
  html: string | null
  text: string | null
  bands: string[]
  /** Read from an earlier pass as a pairing partner, not examined now. */
  partner?: boolean
}

interface KnownTemplate {
  id: string | null
  template: Template
  bands: string[]
  messages: number
  hash: string
}

const shared = (a: readonly string[], b: readonly string[]) =>
  a.filter((x) => b.includes(x)).length

const arrayLiteral = (xs: readonly string[]) => `{${xs.join(",")}}`

export async function compactContent(
  tenantId: string,
  deps: CompactDeps,
): Promise<CompactResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const promoteAt = deps.promoteAt ?? PROMOTE_AT
  const since = new Date(
    now.getTime() - (deps.windowDays ?? WINDOW_DAYS) * 86_400_000,
  ).toISOString()
  const result: CompactResult = {
    scanned: 0,
    extracted: 0,
    inlineBytes: 0,
    matched: 0,
    derived: 0,
    compacted: 0,
    bytesSaved: 0,
  }

  const [rows, known] = await withTenant(db, tenantId, async (tx) => {
    const bodies = (await tx.execute(sql`
      select b.message_id, b.created_at::text as created_at, m.subject, b.html, b.text,
             b.template_id
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.examined_at is null
         and b.compacted_at is null
         and b.created_at > ${since}::timestamptz
         and m.status in ('sent', 'failed', 'canceled')
       order by b.created_at
       limit ${deps.limit ?? 300}
    `)) as unknown as {
      message_id: string
      created_at: string
      subject: string
      html: string | null
      text: string | null
      template_id: string | null
    }[]
    const templates = (await tx.execute(sql`
      select id, segments, bands, messages, skeleton_hash from core.content_templates
       where tenant_id = ${tenantId}::uuid
       order by last_seen_at desc limit 200
    `)) as unknown as {
      id: string
      segments: string[]
      bands: string[]
      messages: number
      skeleton_hash: string
    }[]
    return [bodies, templates] as const
  })

  // ── 0. Data-URI images to R2, BEFORE matching (#168) ──
  //
  // ⚠ FIRST, SO A TEMPLATE IS BUILT FROM REFERENCES. A logo inlined in every
  // receipt then becomes part of the skeleton as a 70-byte reference, stored
  // once as an object, instead of 40 KB of base64 in the skeleton - and two
  // receipts whose images differ still share one template, the image hash
  // being a value like any other.
  if (deps.store) {
    for (const r of rows) {
      if (!r.html) continue
      const extracted = extractDataUris(r.html)
      if (!extracted) continue
      try {
        await putObjects(tenantId, extracted.objects, { db, store: deps.store })
        // ⚠ GUARDED ON THE ORIGINAL, like every rewrite here.
        const done = (await withTenant(db, tenantId, (tx) =>
          tx.execute(sql`
            update core.message_bodies
               set html = ${extracted.html},
                   inline_objects = ${arrayLiteral([...extracted.objects.keys()])}::text[]
             where message_id = ${r.message_id}::uuid
               and created_at = ${r.created_at}::timestamptz
               and compacted_at is null
               and html = ${r.html}
            returning message_id
          `),
        )) as unknown as unknown[]
        if (done.length === 0) continue
        result.extracted++
        result.inlineBytes += r.html.length - extracted.html.length
        r.html = extracted.html
      } catch (error) {
        // ⚠ THE BODY STAYS WHOLE, which is a correct state; next pass retries
        // only if it is still unexamined, so a dead bucket costs the saving,
        // never the mail.
        deps.log?.warn?.(
          { err: error, tenantId, messageId: r.message_id },
          "could not move a body's inline images",
        )
      }
    }
  }

  const bodies: Body[] = rows.map((r) => ({
    linkedTo: r.template_id,
    messageId: r.message_id,
    // ⚠ POSTGRES'S OWN TEXT, NOT A JS DATE. `created_at` is the partition key
    // and has microseconds; a Date keeps milliseconds, and an UPDATE keyed on
    // the rounded value matches nothing - which is exactly how the first
    // version of this job silently linked and compacted no body at all.
    createdAt: String(r.created_at),
    html: r.html,
    text: r.text,
    bands: fingerprint(r.subject, r.html, r.text)?.bands ?? [],
  }))
  result.scanned = bodies.length

  const templates: KnownTemplate[] = known.map((t) => ({
    id: t.id,
    template: { segments: t.segments },
    bands: t.bands,
    messages: t.messages,
    hash: t.skeleton_hash,
  }))

  // ── 1. Match, or derive from a near-duplicate pair ──
  const fits = new Map<string, { t: KnownTemplate; values: string[]; body: Body }>()
  const unmatched: Body[] = []
  for (const body of bodies) {
    const linked = body.linkedTo
      ? templates.find((t) => t.id === body.linkedTo)
      : undefined
    const linkedValues = linked ? compactable(linked.template, body) : null
    const found =
      linked && linkedValues
        ? { t: linked, values: linkedValues }
        : matchAny(body, templates)
    if (found) fits.set(body.messageId, { ...found, body })
    else unmatched.push(body)
  }

  const adopt = (template: Template, bands: string[]): KnownTemplate => {
    const hash = skeletonHash(template)
    const existing = templates.find((x) => x.hash === hash)
    if (existing) return existing
    const t: KnownTemplate = { id: null, template, bands, messages: 0, hash }
    templates.push(t)
    return t
  }
  const fitAll = (t: KnownTemplate, pool: readonly Body[]) => {
    for (const o of pool) {
      if (fits.has(o.messageId)) continue
      const values = compactable(t.template, o)
      if (values) fits.set(o.messageId, { t, values, body: o })
    }
  }

  // In this batch first: the cheap case, and the common one for a burst.
  for (let i = 0; i < unmatched.length; i++) {
    const b = unmatched[i]!
    if (fits.has(b.messageId)) continue
    const partner = unmatched.find(
      (o, j) => j < i && !fits.has(o.messageId) && shared(o.bands, b.bands) >= 2,
    )
    const template = partner ? pairTemplate(partner, b) : null
    if (!template) continue
    result.derived++
    fitAll(adopt(template, b.bands), unmatched)
  }

  // Then against bodies an earlier pass examined and left unmatched.
  const lonely = unmatched.filter((b) => !fits.has(b.messageId) && b.bands.length > 0)
  const earlier =
    lonely.length > 0 ? await candidates(tenantId, lonely, since, deps) : []
  for (const b of lonely) {
    if (fits.has(b.messageId)) continue
    const partner = earlier.find(
      (o) => !fits.has(o.messageId) && shared(o.bands, b.bands) >= 2,
    )
    const template = partner ? pairTemplate(partner, b) : null
    if (!template) continue
    result.derived++
    const t = adopt(template, b.bands)
    fitAll(t, unmatched)
    fitAll(t, earlier)
  }

  // ── 2. Link new matches once, and stamp everything examined ──
  //
  // ⚠ A MATCH IS COUNTED ONCE. A newly matched body is LINKED (template and
  // values recorded, original kept) and counted; a body an earlier pass had
  // already linked is not counted again.
  const perTemplate = new Map<string, number>()
  for (const f of fits.values()) {
    if (f.body.linkedTo) continue
    perTemplate.set(f.t.hash, (perTemplate.get(f.t.hash) ?? 0) + 1)
  }

  await withTenant(db, tenantId, async (tx) => {
    for (const t of templates) {
      const added = perTemplate.get(t.hash) ?? 0
      if (added === 0) continue
      const [row] = (await tx.execute(sql`
        insert into core.content_templates
          (tenant_id, skeleton_hash, segments, bands, static_bytes, holes, messages, last_seen_at)
        values (${tenantId}::uuid, ${t.hash}, ${JSON.stringify(t.template.segments)}::jsonb,
                ${arrayLiteral(t.bands)}::text[], ${staticBytes(t.template)},
                ${t.template.segments.length - 1}, ${added}, now())
        on conflict (tenant_id, skeleton_hash)
        do update set messages = core.content_templates.messages + excluded.messages,
                      last_seen_at = now()
        returning id, messages
      `)) as unknown as { id: string; messages: number }[]
      t.id = row!.id
      t.messages = row!.messages
    }

    for (const { t, values, body } of fits.values()) {
      if (!t.id) continue
      // ⚠ THE GUARD IS THE ORIGINAL BYTES: the update only lands if the row
      // still holds exactly what was checked. Anything else changed it since.
      const linked = (await tx.execute(sql`
        update core.message_bodies
           set template_id = ${t.id}::uuid,
               template_values = ${JSON.stringify(values)}::jsonb,
               examined_at = coalesce(examined_at, now()),
               content_bands = null
         where message_id = ${body.messageId}::uuid
           and created_at = ${body.createdAt}::timestamptz
           and compacted_at is null
           and html is not distinct from ${body.html}
           and text is not distinct from ${body.text}
        returning message_id
      `)) as unknown as unknown[]
      if (linked.length > 0 && !body.linkedTo) result.matched++
    }

    for (const body of bodies) {
      if (fits.has(body.messageId)) continue
      // ⚠ THE BANDS STAY BEHIND so a twin in a later pass can pair with it.
      await tx.execute(sql`
        update core.message_bodies
           set examined_at = now(),
               content_bands = ${body.bands.length > 0 ? arrayLiteral(body.bands) : null}::text[]
         where message_id = ${body.messageId}::uuid
           and created_at = ${body.createdAt}::timestamptz
           and examined_at is null
      `)
    }
  })

  // ── 3. Compact every linked body whose template is now established ──
  const promoted = await promote(tenantId, promoteAt, deps)
  result.compacted = promoted.compacted
  result.bytesSaved = promoted.bytesSaved
  return result
}

/** The template two bodies share, or null. */
function pairTemplate(a: Body, b: Body): Template | null {
  const ja = joinBody(a)
  const jb = joinBody(b)
  if (ja === null || jb === null) return null
  return derive(ja, jb)
}

/**
 * Earlier-examined, still-unmatched bodies sharing a band with any of these.
 *
 * ⚠ THE GIN INDEX DOES THE SEARCH; ONLY THE HITS ARE READ. A body can be
 * large, and reading every unmatched body of the week to find one twin is the
 * rescan this design exists to avoid.
 */
async function candidates(
  tenantId: string,
  lonely: readonly Body[],
  since: string,
  { db }: CompactDeps,
): Promise<Body[]> {
  const bands = [...new Set(lonely.flatMap((b) => b.bands))]
  const exclude = new Set(lonely.map((b) => b.messageId))
  const rows = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select message_id, created_at::text as created_at, html, text, content_bands
        from core.message_bodies
       where tenant_id = ${tenantId}::uuid
         and content_bands && ${arrayLiteral(bands)}::text[]
         and template_id is null
         and compacted_at is null
         and created_at > ${since}::timestamptz
       order by created_at desc
       limit ${Math.min(50, lonely.length * 5)}
    `),
  )) as unknown as {
    message_id: string
    created_at: string
    html: string | null
    text: string | null
    content_bands: string[] | null
  }[]
  return rows
    .filter((r) => !exclude.has(r.message_id))
    .map((r) => ({
      linkedTo: null,
      messageId: r.message_id,
      createdAt: String(r.created_at),
      html: r.html,
      text: r.text,
      bands: r.content_bands ?? [],
      partner: true,
    }))
}

/**
 * Releases the originals of linked bodies whose template has `promoteAt`
 * matches.
 *
 * ⚠ THE LAST GATE BEFORE A BYTE IS RELEASED: the stored values are rendered
 * through the template and compared with the original, byte for byte. A body
 * that no longer reconstructs is UNLINKED rather than left pending, so one bad
 * row cannot sit at the head of this query for ever.
 */
async function promote(
  tenantId: string,
  promoteAt: number,
  { db, promoteLimit }: CompactDeps,
): Promise<{ compacted: number; bytesSaved: number }> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      select b.message_id, b.created_at::text as created_at, b.html, b.text,
             b.template_values, t.segments
        from core.message_bodies b
        join core.content_templates t on t.id = b.template_id
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.template_id is not null
         and b.compacted_at is null
         and t.messages >= ${promoteAt}
         and m.status in ('sent', 'failed', 'canceled')
       order by b.created_at
       limit ${promoteLimit ?? 500}
    `)) as unknown as {
      message_id: string
      created_at: string
      html: string | null
      text: string | null
      template_values: unknown
      segments: string[]
    }[]
    let compacted = 0
    let bytesSaved = 0
    for (const r of rows) {
      const values = Array.isArray(r.template_values)
        ? (r.template_values as string[])
        : null
      const back = values ? restore({ segments: r.segments }, values) : null
      const exact = back !== null && back.html === r.html && back.text === r.text
      if (!exact) {
        await tx.execute(sql`
          update core.message_bodies set template_id = null, template_values = null
           where message_id = ${r.message_id}::uuid
             and created_at = ${r.created_at}::timestamptz
             and compacted_at is null
        `)
        continue
      }
      const done = (await tx.execute(sql`
        update core.message_bodies
           set html = null, text = null, compacted_at = now()
         where message_id = ${r.message_id}::uuid
           and created_at = ${r.created_at}::timestamptz
           and compacted_at is null
           and html is not distinct from ${r.html}
           and text is not distinct from ${r.text}
        returning message_id
      `)) as unknown as unknown[]
      if (done.length === 0) continue
      compacted++
      bytesSaved +=
        (r.html?.length ?? 0) + (r.text?.length ?? 0) - JSON.stringify(values).length
    }
    return { compacted, bytesSaved }
  })
}

/** The first known template a body fits, trying band-sharing candidates first. */
function matchAny(body: Body, templates: readonly KnownTemplate[]) {
  const ranked = [...templates].sort(
    (a, b) => shared(b.bands, body.bands) - shared(a.bands, body.bands),
  )
  for (const t of ranked.slice(0, 10)) {
    const values = compactable(t.template, body)
    if (values) return { t, values }
  }
  return null
}
