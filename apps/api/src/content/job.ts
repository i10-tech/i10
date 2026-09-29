import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { fingerprint, htmlToText } from "../risk/fingerprint.js"
import type { TrustSource } from "../risk/trusted.js"
import type { Embedder } from "./embed.js"
import type { ContentStore } from "./object-store.js"
import { restoreContent } from "./packs.js"
import { restoreBodies } from "./restore.js"
import { classify, trustMark } from "./trust.js"
import { embeddedAlready, storeContentVectors } from "./vectors.js"

/**
 * The risk half of the content job, per workspace, in the hourly risk run
 * (#170, #222).
 *
 * One pass over the workspace's recently FINISHED mail does two things with one
 * read:
 *   1. credits bodies that ARE one of the workspace's approved templates or
 *      known boilerplate (#222), and marks their vectors so the similarity
 *      definers leave them out;
 *   2. embeds content it has not embedded yet, into pgvector.
 *
 * ⚠ TEMPLATE COMPACTION IS NOT HERE ANY MORE (#171). It moved to the
 * content-store job (content/compact.ts), which runs every five minutes, for
 * every workspace, whether RISK_ENABLED is on or off. Riding the risk run
 * meant switching risk off stopped compaction, the system tenant - exempt from
 * scoring - never compacted, and only active workspaces were visited.
 *
 * ⚠ EVERY PASS MAKES PROGRESS, BY `analysed_at`. Every body read is stamped,
 * except those whose embedding was deferred by `embedLimit` or failed: those
 * are first in line next hour. Without the stamp this pass re-read the same
 * oldest bodies every hour, the starvation #171's compaction had.
 *
 * ⚠ BODIES ARE RESTORED FIRST. Compaction has usually run by the time this
 * does, so a body is a template plus values; the trust matcher compares exact
 * bytes and must see what was sent.
 *
 * ⚠ ONLY FINISHED MESSAGES, and BOUNDED PER RUN: `limit` bodies and
 * `embedLimit` embeddings per workspace per hour. A backlog drains over
 * several runs; no run can blow the job's memory or its hour.
 */
export interface ContentJobDeps {
  db: Database
  /** Where data-URI images moved to (#168); needed only once any have. */
  store?: ContentStore | null
  embedder?: Embedder
  now?: Date
  limit?: number
  embedLimit?: number
  /** Boilerplate and approved templates (#222). Absent: nothing is trusted. */
  trust?: TrustSource
  /** Adds credited messages to each approved template's count. */
  creditTemplates?: (counts: ReadonlyMap<string, number>) => Promise<void>
  log?: { warn?: (o: object, m: string) => void }
}

export interface ContentJobResult {
  scanned: number
  embedded: number
  /** Bodies newly credited to an approved template. */
  trusted: number
}

interface Body {
  messageId: string
  createdAt: string
  subject: string
  html: string | null
  text: string | null
  exact: string | null
  /** Set when an earlier run credited it to an approved template. */
  trustedTemplateId: string | null
  /** `template:<id>` or `boilerplate:<id>` when it fits one this run. */
  trustedBy: string | null
}

export async function analyseContent(
  tenantId: string,
  deps: ContentJobDeps,
): Promise<ContentJobResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const result: ContentJobResult = { scanned: 0, embedded: 0, trusted: 0 }

  const stored = await withTenant(db, tenantId, async (tx) => {
    const raw = (await tx.execute(sql`
      select b.message_id, b.created_at::text as created_at, m.subject, b.html, b.text,
             b.template_id, b.template_values, b.trusted_template_id, b.inline_objects, b.pack_id, b.pack_offset, b.pack_length, b.body_key
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.analysed_at is null
         and b.created_at > ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz
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
      template_values: unknown
      trusted_template_id: string | null
      inline_objects: string[] | null
      pack_id: string | null
      pack_offset: string | number | null
      pack_length: number | null
      body_key: string | null
    }[]
    return restoreBodies(
      tx,
      raw.map((r) => ({
        ...r,
        templateId: r.template_id,
        templateValues: r.template_values,
      })),
    )
  })

  // ⚠ PACKED BODIES AND IMAGES BACK IN TOO (#168, #188): the trust matcher
  // compares exact bytes.
  const rows = await restoreContent(
    deps.store ?? null,
    tenantId,
    stored.map((r) => ({
      ...r,
      messageId: r.message_id,
      inlineObjects: r.inline_objects,
      packId: r.pack_id,
      packOffset: r.pack_offset,
      packLength: r.pack_length,
      bodyKey: r.body_key,
    })),
  )
  const bodies: Body[] = rows.map((r) => ({
    messageId: r.message_id,
    // ⚠ POSTGRES'S OWN TEXT, NOT A JS DATE: the partition key has microseconds.
    createdAt: String(r.created_at),
    subject: r.subject,
    html: r.html,
    text: r.text,
    exact: fingerprint(r.subject, r.html, r.text)?.exact ?? null,
    trustedTemplateId: r.trusted_template_id,
    trustedBy: null,
  }))
  result.scanned = bodies.length
  if (bodies.length === 0) return result

  // ── 1. Trusted content (#222) ──
  //
  // ⚠ THE SAME MATCHER AS THE FINGERPRINT PASS, ON THE STORED BODY. Here the
  // verdict callback may spend the Web Risk budget, so a hole's link the
  // five-minute pass could not vouch for yet gets its answer.
  const trust = deps.trust
    ? await deps.trust.forTenant(tenantId).catch((error: unknown) => {
        deps.log?.warn?.({ err: error, tenantId }, "could not load trusted content")
        return null
      })
    : null
  const credits = new Map<string, number>()
  const toCredit: Body[] = []
  if (trust && trust.entries.length > 0) {
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
  }

  // ── 2. Embed what has no vector yet ──
  const deferred = new Set<string>()
  if (deps.embedder) {
    const embedder = deps.embedder
    const distinct = new Map<string, Body>()
    // ⚠ A VECTOR IS TRUSTED ONLY IF EVERY BODY WITH ITS FINGERPRINT FITTED
    // THE SAME ENTRY - the fingerprint pass's rule, so the two never disagree.
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
    const missing = [...distinct.values()].filter((b) => !have.has(b.exact!))
    const todo = missing.slice(0, deps.embedLimit ?? 25)
    for (const b of missing.slice(todo.length)) deferred.add(b.exact!)
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
        // ⚠ LEFT UNSTAMPED, SO NEXT HOUR TRIES AGAIN. The window bounds how
        // long a broken embedder can hold them: past a week they fall out.
        for (const b of todo) deferred.add(b.exact!)
        deps.log?.warn?.({ err: error, tenantId }, "could not embed content")
      }
    }
  }

  // ── 3. Credit and stamp, in one transaction ──
  await withTenant(db, tenantId, async (tx) => {
    for (const b of toCredit) {
      await tx.execute(sql`
        update core.message_bodies set trusted_template_id = ${b.trustedTemplateId}::uuid
         where message_id = ${b.messageId}::uuid and created_at = ${b.createdAt}::timestamptz
      `)
      credits.set(b.trustedTemplateId!, (credits.get(b.trustedTemplateId!) ?? 0) + 1)
    }
    for (const b of bodies) {
      if (b.exact && deferred.has(b.exact)) continue
      await tx.execute(sql`
        update core.message_bodies set analysed_at = now()
         where message_id = ${b.messageId}::uuid and created_at = ${b.createdAt}::timestamptz
      `)
    }
  })
  result.trusted = toCredit.length
  if (credits.size > 0 && deps.creditTemplates) await deps.creditTemplates(credits)
  return result
}
