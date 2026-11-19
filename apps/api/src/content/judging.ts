import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import {
  ALLOWLISTED,
  fingerprint,
  htmlToText,
  type Fingerprint,
} from "../risk/fingerprint.js"
import type { JudgeEmail } from "../risk/judge/contract.js"
import type { ContentJudge } from "../risk/judge/judge.js"
import type { JudgementStore } from "../risk/judge/store.js"
import type { TrustSource } from "../risk/trusted.js"
import type { ContentStore } from "./object-store.js"
import { restoreContent } from "./packs.js"
import { restoreBodies } from "./restore.js"
import { classify, trustMark } from "./trust.js"

/**
 * The content judge's pass, per workspace, in the hourly content job
 * (content/job.ts; docs/decisions/risk.md, "The content judge").
 *
 * ⚠ ONCE PER DISTINCT CONTENT. Bodies are grouped by exact fingerprint, and a
 * content judged before under the same model costs nothing; a template sent
 * ten thousand times is one call.
 *
 * ⚠ ANY STATUS, NEWEST FIRST. Like the fingerprint pass (risk/content.ts),
 * mail queued or scheduled is judged before it goes; and newest first, so a
 * workspace sending more distinct content than its budget has its latest mail
 * judged, not last week's. Unsent bodies are never compacted or packed, so
 * reading them costs nothing extra.
 *
 * ⚠ TRUSTED CONTENT IS NEVER JUDGED. A body that IS an approved template or
 * known boilerplate (the trust matcher, as in the other passes) is already
 * vouched for, and judging it would spend the budget on the mail least likely
 * to be abuse. It fails closed: one body with the fingerprint that did not
 * fit makes the content judged.
 *
 * ⚠ A BODY IS STAMPED `judged_at` ONCE ITS CONTENT IS RESOLVED: judged, judged
 * before, trusted, or too short to fingerprint. Content left unjudged (a spent
 * budget, a failing provider) stays unstamped and is tried next hour; past the
 * 7-day window it falls out.
 *
 * The pre-send screen (content/screen.ts) judges the same way from the same
 * pieces below, so a body gets the identical judge input on either path.
 */
export interface JudgeDeps {
  db: Database
  judge: ContentJudge
  judgements: JudgementStore
  store?: ContentStore | null
  /** Already loaded by the caller for its own pass; null: nothing is trusted. */
  trust?: Trust | null
  /** Distinct contents the day has seen and capped, deduplicated across passes. */
  seenRedis?: SeenRedis
  now?: Date
  /** Bodies read per pass. */
  limit?: number
  /** Judge calls per pass. */
  calls?: number
  log?: { warn?: (o: object, m: string) => void }
}

export type Trust = Awaited<ReturnType<TrustSource["forTenant"]>>

export interface SeenRedis {
  sadd(key: string, ...members: string[]): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

export interface JudgeResult {
  /** Distinct contents judged now. */
  judged: number
  /** Distinct contents this workspace's spent daily budget left unjudged. */
  capped: number
  /** Distinct contents left for a later pass: global budget, outage or failure. */
  deferred: number
}

export const JUDGE_SCAN_LIMIT = 300
export const JUDGE_CALLS_PER_PASS = 25

/** What both judging paths read of one body: the mail as it is sent. */
export interface JudgeSource {
  subject: string
  from: string
  replyTo: readonly string[] | null
  to: readonly string[]
  html: string | null
  text: string | null
}

/** One body as the judge sees it. */
export interface JudgeCandidate {
  /** Null when the body is too short to fingerprint. */
  print: Fingerprint | null
  /** The trust entry the body fits, or null. */
  trustedBy: string | null
  email: JudgeEmail
}

/** One distinct content: the first body seen with this exact fingerprint. */
export interface DistinctContent {
  exact: string
  bands: string[]
  email: JudgeEmail
  /** Set only while every body with this fingerprint fitted the same entry. */
  trustedBy: string | null
}

/** `"Name" <a@b.example>` or `a@b.example`: the display name and the domain. */
export function parseSender(address: string): {
  name: string | null
  domain: string | null
} {
  const angle = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(address)
  const raw = angle ? angle[2]! : address.trim()
  const name = angle ? angle[1]!.replace(/^"(.*)"$/, "$1").trim() || null : null
  const at = raw.lastIndexOf("@")
  return { name, domain: at >= 0 ? raw.slice(at + 1).toLowerCase() || null : null }
}

/** A body's fingerprint, trust mark and judge input. A failing matcher trusts nothing. */
export async function judgeCandidate(
  body: JudgeSource,
  trust: Trust | null,
): Promise<JudgeCandidate> {
  const sender = parseSender(body.from)
  const replyTo = (body.replyTo ?? [])
    .map((a) => parseSender(a).domain)
    .find((d) => d && d !== sender.domain)
  const found =
    trust && trust.entries.length > 0
      ? await classify(
          { html: body.html, text: body.text },
          trust.entries,
          trust.ctx,
        ).catch(() => null)
      : null
  return {
    print: fingerprint(body.subject, body.html, body.text),
    trustedBy: found ? trustMark(found.entry) : null,
    email: {
      subject: body.subject,
      text: body.text ?? (body.html ? htmlToText(body.html) : ""),
      senderName: sender.name,
      senderDomain: sender.domain,
      replyToDomain: replyTo ?? null,
      html: body.html,
      recipientDomain: body.to[0] ? parseSender(body.to[0]).domain : null,
    },
  }
}

/**
 * One entry per distinct content, the first body seen standing for it. Bodies
 * too short to fingerprint and our docs' examples have none.
 */
export function distinctContents(
  bodies: readonly JudgeCandidate[],
): Map<string, DistinctContent> {
  const distinct = new Map<string, DistinctContent>()
  for (const b of bodies) {
    if (!b.print || ALLOWLISTED.has(b.print.exact)) continue
    const seen = distinct.get(b.print.exact)
    if (!seen)
      distinct.set(b.print.exact, {
        exact: b.print.exact,
        bands: b.print.bands,
        email: b.email,
        trustedBy: b.trustedBy,
      })
    else if (seen.trustedBy !== b.trustedBy) seen.trustedBy = null
  }
  return distinct
}

/**
 * Adds a pass's counts to the workspace's day.
 *
 * ⚠ DISTINCT PER DAY ACROSS PASSES: a content seen every hour, or by the
 * screen and then the hourly pass, is one.
 */
export async function countDay(
  deps: Pick<JudgeDeps, "judgements" | "seenRedis">,
  tenantId: string,
  now: Date,
  counts: { seen: readonly string[]; judged: number; capped: readonly string[] },
): Promise<void> {
  const day = now.toISOString().slice(0, 10)
  const fresh = async (kind: string, members: readonly string[]) => {
    const redis = deps.seenRedis
    if (!redis || members.length === 0) return 0
    const key = `risk:judge:${kind}:${tenantId}:${day}`
    try {
      const added = await redis.sadd(key, ...members)
      await redis.expire(key, 2 * 86_400)
      return added
    } catch {
      return 0
    }
  }
  await deps.judgements.addDay(tenantId, day, {
    seen: await fresh("seen", counts.seen),
    judged: counts.judged,
    capped: await fresh("capped", counts.capped),
  })
}

/** Stamps bodies `judged_at`, in one statement. `createdAt` is the partition key's own value. */
export async function stampJudged(
  db: Database,
  tenantId: string,
  bodies: readonly { messageId: string; createdAt: string }[],
): Promise<void> {
  if (bodies.length === 0) return
  const rows = bodies.map(
    (b) => sql`(${b.messageId}::uuid, ${b.createdAt}::timestamptz)`,
  )
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      update core.message_bodies b set judged_at = now()
        from (values ${sql.join(rows, sql`, `)}) as v (message_id, created_at)
       where b.message_id = v.message_id and b.created_at = v.created_at
    `),
  )
}

export async function judgeContent(
  tenantId: string,
  deps: JudgeDeps,
): Promise<JudgeResult> {
  const now = deps.now ?? new Date()
  const result: JudgeResult = { judged: 0, capped: 0, deferred: 0 }

  const stored = await withTenant(deps.db, tenantId, async (tx) => {
    const raw = (await tx.execute(sql`
      select b.message_id, b.created_at::text as created_at, m.subject, m.from_address, m.reply_to, m.to_addresses,
             b.html, b.text, b.template_id, b.template_values, b.inline_objects,
             b.pack_id, b.pack_offset, b.pack_length, b.body_key
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.judged_at is null
         and b.created_at > ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz
       order by b.created_at desc
       limit ${deps.limit ?? JUDGE_SCAN_LIMIT}
    `)) as unknown as {
      message_id: string
      created_at: string
      subject: string
      from_address: string
      reply_to: string[] | null
      to_addresses: string[]
      html: string | null
      text: string | null
      template_id: string | null
      template_values: unknown
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
  if (stored.length === 0) return result
  const rows = await restoreContent(
    deps.db,
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

  const trust = deps.trust ?? null
  const bodies: (JudgeCandidate & { messageId: string; createdAt: string })[] = []
  for (const r of rows) {
    const candidate = await judgeCandidate(
      {
        subject: r.subject,
        from: r.from_address,
        replyTo: r.reply_to,
        to: r.to_addresses,
        html: r.html,
        text: r.text,
      },
      trust,
    )
    bodies.push({
      ...candidate,
      messageId: r.message_id,
      createdAt: String(r.created_at),
    })
  }

  const distinct = distinctContents(bodies)
  const untrusted = [...distinct.values()]
    .filter((d) => d.trustedBy === null)
    .map((d) => d.exact)
  const have = await deps.judgements.judged(tenantId, deps.judge.key, untrusted)
  const unresolved = new Set<string>()
  const capped: string[] = []
  let calls = deps.calls ?? JUDGE_CALLS_PER_PASS
  for (const exact of untrusted) {
    if (have.has(exact)) continue
    if (calls <= 0) {
      unresolved.add(exact)
      continue
    }
    const content = distinct.get(exact)!
    const outcome = await deps.judge.judge(tenantId, content.email)
    if (outcome.status === "judged") {
      calls--
      if (
        await deps.judgements.save(
          tenantId,
          exact,
          outcome.judgement,
          now,
          content.bands,
        )
      )
        result.judged++
      continue
    }
    unresolved.add(exact)
    if (outcome.status === "capped") capped.push(exact)
    // An outage or a spent global budget will say the same for the rest.
    else calls = 0
  }
  result.capped = capped.length
  result.deferred = unresolved.size - capped.length

  await countDay(deps, tenantId, now, {
    seen: untrusted,
    judged: result.judged,
    capped,
  })
  await stampJudged(
    deps.db,
    tenantId,
    bodies.filter((b) => !(b.print && unresolved.has(b.print.exact))),
  )
  return result
}
