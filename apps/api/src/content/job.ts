import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { fingerprint, htmlToText } from "../risk/fingerprint.js"
import type { TrustSource } from "../risk/trusted.js"
import type { Embedder } from "./embed.js"
import { classify, trustMark } from "./trust.js"
import {
  compactable,
  derive,
  joinBody,
  skeletonHash,
  staticBytes,
  type Template,
} from "./templates.js"
import { embeddedAlready, storeContentVectors } from "./vectors.js"

/**
 * The content job, per workspace, off the send path (#169, #170, #171).
 *
 * One pass over the workspace's recently FINISHED mail does three things with
 * one read:
 *   1. matches each body to a template the workspace already has, or derives a
 *      new one from two near-duplicate bodies (MinHash bands pick candidates);
 *   2. compacts bodies that fit an established template - static skeleton
 *      once, values per message - after a byte-exact check;
 *   3. embeds content it has not embedded yet, into pgvector;
 *   4. credits bodies that ARE one of the workspace's approved templates or
 *      known boilerplate (#222), and marks their vectors so the similarity
 *      definers leave them out.
 *
 * ⚠ ONLY FINISHED MESSAGES. Sent, failed or canceled - never queued or
 * sending, so nothing the worker might still read is rewritten under it.
 *
 * ⚠ BOUNDED PER RUN: `limit` bodies and `embedLimit` embeddings per workspace
 * per hour. A backlog drains over several runs; no run can blow the job's
 * memory or its hour.
 */
export interface ContentJobDeps {
  db: Database
  embedder?: Embedder
  now?: Date
  limit?: number
  embedLimit?: number
  /** Matches a template needs before bodies are compacted against it. */
  promoteAt?: number
  /** Boilerplate and approved templates (#222). Absent: nothing is trusted. */
  trust?: TrustSource
  /** Adds credited messages to each approved template's count. */
  creditTemplates?: (counts: ReadonlyMap<string, number>) => Promise<void>
  log?: { warn?: (o: object, m: string) => void }
}

export interface ContentJobResult {
  scanned: number
  matched: number
  derived: number
  compacted: number
  bytesSaved: number
  embedded: number
  /** Bodies newly credited to an approved template. */
  trusted: number
}

interface Body {
  /** Set when an earlier run linked it to a template not yet established. */
  linkedTo: string | null
  messageId: string
  createdAt: string
  subject: string
  html: string | null
  text: string | null
  bands: string[]
  exact: string | null
  /** Set when an earlier run credited it to an approved template. */
  trustedTemplateId: string | null
  /** `template:<id>` or `boilerplate:<id>` when it fits one this run. */
  trustedBy: string | null
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

export async function processContent(
  tenantId: string,
  deps: ContentJobDeps,
): Promise<ContentJobResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const limit = deps.limit ?? 300
  const promoteAt = deps.promoteAt ?? 3
  const result: ContentJobResult = {
    scanned: 0,
    matched: 0,
    derived: 0,
    compacted: 0,
    bytesSaved: 0,
    embedded: 0,
    trusted: 0,
  }

  const [rows, known] = await withTenant(db, tenantId, async (tx) => {
    const bodies = (await tx.execute(sql`
      select b.message_id, b.created_at::text as created_at, m.subject, b.html, b.text, b.template_id,
             b.trusted_template_id
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.compacted_at is null
         and b.created_at > ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz
         and m.status in ('sent', 'failed', 'canceled')
         and (b.html is not null or b.text is not null)
       order by b.created_at
       limit ${limit}
    `)) as unknown as {
      message_id: string
      created_at: string | Date
      subject: string
      html: string | null
      text: string | null
      template_id: string | null
      trusted_template_id: string | null
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

  const bodies: Body[] = rows.map((r) => {
    const fp = fingerprint(r.subject, r.html, r.text)
    return {
      linkedTo: r.template_id,
      messageId: r.message_id,
      // ⚠ POSTGRES'S OWN TEXT, NOT A JS DATE. `created_at` is the partition key
      // and has microseconds; a Date keeps milliseconds, and an UPDATE keyed on
      // the rounded value matches nothing - which is exactly how the first
      // version of this job silently linked and compacted no body at all.
      createdAt: String(r.created_at),
      subject: r.subject,
      html: r.html,
      text: r.text,
      bands: fp?.bands ?? [],
      exact: fp?.exact ?? null,
      trustedTemplateId: r.trusted_template_id,
      trustedBy: null,
    }
  })
  result.scanned = bodies.length

  // ── 0. Trusted content (#222), before anything is compacted ──
  //
  // ⚠ THE SAME MATCHER AS ACCEPT, ON THE STORED BODY. Here the verdict
  // callback may spend the Web Risk budget, so a hole's link the accept path
  // could not vouch for yet gets its answer.
  const trust =
    deps.trust && bodies.length > 0
      ? await deps.trust.forTenant(tenantId).catch((error: unknown) => {
          deps.log?.warn?.({ err: error, tenantId }, "could not load trusted content")
          return null
        })
      : null
  const credits = new Map<string, number>()
  if (trust && trust.entries.length > 0) {
    const toCredit: Body[] = []
    for (const body of bodies) {
      const found = await classify(body, trust.entries, trust.ctx).catch(() => null)
      if (!found) continue
      body.trustedBy = trustMark(found.entry)
      if (
        found.entry.kind === "template" &&
        body.trustedTemplateId !== found.entry.id
      ) {
        body.trustedTemplateId = found.entry.id
        toCredit.push(body)
      }
    }
    if (toCredit.length > 0) {
      await withTenant(db, tenantId, async (tx) => {
        for (const b of toCredit) {
          await tx.execute(sql`
            update core.message_bodies set trusted_template_id = ${b.trustedTemplateId}::uuid
             where message_id = ${b.messageId}::uuid and created_at = ${b.createdAt}::timestamptz
          `)
          credits.set(
            b.trustedTemplateId!,
            (credits.get(b.trustedTemplateId!) ?? 0) + 1,
          )
        }
      })
      result.trusted = toCredit.length
    }
  }

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
  for (let i = 0; i < unmatched.length; i++) {
    const b = unmatched[i]!
    if (fits.has(b.messageId)) continue
    const partner = unmatched.find(
      (o, j) => j < i && !fits.has(o.messageId) && shared(o.bands, b.bands) >= 2,
    )
    if (!partner) continue
    const ja = joinBody(partner)
    const jb = joinBody(b)
    if (ja === null || jb === null) continue
    const template = derive(ja, jb)
    if (!template) continue
    const hash = skeletonHash(template)
    const t: KnownTemplate =
      templates.find((x) => x.hash === hash) ??
      (templates.push({ id: null, template, bands: b.bands, messages: 0, hash }),
      templates[templates.length - 1]!)
    result.derived++
    for (const o of unmatched) {
      if (fits.has(o.messageId)) continue
      const values = compactable(t.template, o)
      if (values) fits.set(o.messageId, { t, values, body: o })
    }
  }
  result.matched = fits.size

  // ── 2. Link new matches once; compact what fits an established template ──
  //
  // ⚠ A MATCH IS COUNTED ONCE. A newly matched body is LINKED (template and
  // values recorded, original kept) and counted; later runs see it linked and
  // do not count it again. It is COMPACTED - original released - only once its
  // template has `promoteAt` matches, so one coincidence never rewrites mail.
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
                ${`{${t.bands.join(",")}}`}::text[], ${staticBytes(t.template)},
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
      const promote = t.messages >= promoteAt
      // ⚠ THE GUARD IS THE ORIGINAL BYTES: the update only lands if the row
      // still holds exactly what was checked. Anything else changed it since.
      const updated = (await tx.execute(sql`
        update core.message_bodies
           set template_id = ${t.id}::uuid,
               template_values = ${JSON.stringify(values)}::jsonb,
               html = case when ${promote} then null else html end,
               text = case when ${promote} then null else text end,
               compacted_at = case when ${promote} then now() else null end
         where message_id = ${body.messageId}::uuid
           and created_at = ${body.createdAt}::timestamptz
           and compacted_at is null
           and html is not distinct from ${body.html}
           and text is not distinct from ${body.text}
        returning message_id
      `)) as unknown as unknown[]
      if (updated.length > 0 && promote) {
        result.compacted++
        result.bytesSaved +=
          (body.html?.length ?? 0) +
          (body.text?.length ?? 0) -
          JSON.stringify(values).length
      }
    }
  })

  // ── 3. Embed what has no vector yet ──
  if (deps.embedder) {
    const embedder = deps.embedder
    const distinct = new Map<string, Body>()
    // ⚠ A VECTOR IS TRUSTED ONLY IF EVERY BODY WITH ITS FINGERPRINT FITTED
    // THE SAME ENTRY - the accept path's rule, so the two never disagree.
    const marks = new Map<string, string | null>()
    for (const b of bodies) {
      if (!b.exact) continue
      if (!distinct.has(b.exact)) distinct.set(b.exact, b)
      const prev = marks.get(b.exact)
      marks.set(
        b.exact,
        prev === undefined || prev === b.trustedBy ? b.trustedBy : null,
      )
    }
    const have = await embeddedAlready(db, tenantId, embedder.model, [
      ...distinct.keys(),
    ])
    const todo = [...distinct.values()]
      .filter((b) => !have.has(b.exact!))
      .slice(0, deps.embedLimit ?? 25)
    if (todo.length > 0) {
      const texts = todo.map((b) =>
        `${b.subject}\n${b.text ?? (b.html ? htmlToText(b.html) : "")}`
          .replace(/\s+/g, " ")
          .slice(0, 2_000),
      )
      try {
        const vectors = await embedder.embed(texts)
        result.embedded = await storeContentVectors(
          db,
          tenantId,
          embedder.model,
          todo.map((b, i) => ({
            day: new Date(b.createdAt).toISOString().slice(0, 10),
            exact: b.exact!,
            embedding: vectors[i]!,
            trustedBy: marks.get(b.exact!) ?? null,
          })),
        )
      } catch (error) {
        deps.log?.warn?.({ err: error, tenantId }, "could not embed content")
      }
    }
  }
  if (credits.size > 0 && deps.creditTemplates) await deps.creditTemplates(credits)
  return result
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
