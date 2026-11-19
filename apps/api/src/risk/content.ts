import { sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import type { ContentStore } from "../content/object-store.js"
import { restoreContent } from "../content/packs.js"
import { restoreBodies } from "../content/restore.js"
import { classify, trustMark } from "../content/trust.js"
import { ALLOWLISTED, fingerprint, linkHosts, type Fingerprint } from "./fingerprint.js"
import type { TrustSource } from "./trusted.js"

/**
 * What the content-store job records about content (#170, #171): fingerprints,
 * link hosts, and the farm tripwire.
 *
 * ⚠ FROM STORED BODIES, OFF THE SEND PATH. This used to run in the API after
 * every accept - a MinHash per message on the event loop that serves
 * everybody's password resets. #171's rule is that nothing beyond a hash runs
 * on the send path, so the content-store job now reads bodies it has not
 * fingerprinted (`fingerprinted_at`) every five minutes, and the tripwire
 * fires at that latency instead of at accept.
 *
 * ⚠ RECORDED AND STAMPED IN ONE TRANSACTION. A body counted into the daily
 * rows is marked in the same commit, so a crash between the two can neither
 * lose a sighting nor count one twice.
 *
 * ⚠ THE TRIPWIRE IS A PROMPT, NOT A VERDICT. Redis keeps, per fingerprint and
 * per MinHash band, the set of workspaces that sent it in the last 48 hours.
 * When one reaches `threshold` distinct workspaces, those workspaces are
 * re-scored now instead of at the next hour - and the score, with the precise
 * `fingerprint_peers` comparison and the linking features, decides. A band
 * collision between unrelated mail costs one extra re-score and nothing else.
 *
 * ⚠ TRUSTED CONTENT IS RECORDED BUT NEVER TRIPS THE WIRE (#222). A message
 * that IS known boilerplate or one of the workspace's approved templates is
 * fingerprinted with `trusted_by` set, so the definers leave it out of every
 * cross-workspace comparison, and it is kept out of the Redis sets - fifty
 * workspaces sending Clerk's reset email is not a farm. Its link hosts are
 * still recorded and checked like any other mail's.
 */
export interface TripwirePipeline {
  sadd(key: string, member: string): TripwirePipeline
  expire(key: string, seconds: number): TripwirePipeline
  scard(key: string): TripwirePipeline
  exec(): Promise<[Error | null, unknown][] | null>
}

export interface TripwireRedis {
  pipeline(): TripwirePipeline
  smembers(key: string): Promise<string[]>
  set(
    key: string,
    value: string,
    mode: "EX",
    seconds: number,
    nx: "NX",
  ): Promise<unknown>
}

export interface ContentDeps {
  db: Database
  redis?: TripwireRedis
  threshold: number
  rescore?: (tenantIds: string[], trigger: string) => void
  /** Boilerplate and approved templates (#222). Absent: nothing is trusted. */
  trust?: TrustSource
}

const WINDOW_SECONDS = 48 * 3600
/**
 * One message's content. `messageId` and `createdAt` are the stored body's
 * key: when present the body is stamped `fingerprinted_at` in the same
 * transaction, and its sightings are counted on the day it was accepted.
 */
export interface ContentItem {
  subject: string
  html?: unknown
  text?: unknown
  messageId?: string
  /** Postgres's own text for the partition key, never a JS Date. */
  createdAt?: string
}

/**
 * ⚠ A STORED BODY IS COUNTED ONLY BY THE CALL THAT STAMPS IT. Two writers
 * record content: this job's five-minute pass and the worker's pre-send screen
 * (content/screen.ts), and both can meet the same unstamped body at once. The
 * stamp is taken first, guarded on `fingerprinted_at is null`, and only the
 * bodies it won are counted, so a body is counted once whoever gets there.
 */
export async function recordContent(
  tenantId: string,
  items: readonly ContentItem[],
  deps: ContentDeps,
): Promise<void> {
  const trust = deps.trust
    ? await deps.trust.forTenant(tenantId).catch(() => null)
    : null
  const today = new Date().toISOString().slice(0, 10)
  const seen: {
    item: ContentItem
    day: string
    print: Fingerprint | null
    trustedBy: string | null
    hosts: string[]
  }[] = []
  for (const p of items) {
    const html = typeof p.html === "string" ? p.html : null
    const text = typeof p.text === "string" ? p.text : null
    const fp: Fingerprint | null = fingerprint(p.subject, html, text)
    const print = fp && !ALLOWLISTED.has(fp.exact) ? fp : null
    const found =
      print && trust && trust.entries.length > 0
        ? await classify({ html, text }, trust.entries, trust.ctx).catch(() => null)
        : null
    seen.push({
      item: p,
      day: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : today,
      print,
      trustedBy: found ? trustMark(found.entry) : null,
      hosts: linkHosts(html, text),
    })
  }
  const stamped = items.filter((i) => i.messageId && i.createdAt)
  if (stamped.length === 0 && seen.every((x) => !x.print && x.hosts.length === 0))
    return

  // Keyed by day as well: a body is counted on the day it was accepted.
  const prints = new Map<
    string,
    {
      day: string
      exact: string
      bands: string[]
      messages: number
      trustedBy: string | null
    }
  >()
  await withTenant(deps.db, tenantId, async (tx) => {
    const won = new Set<string>()
    if (stamped.length > 0) {
      const refs = stamped.map(
        (i) => sql`(${i.messageId}::uuid, ${i.createdAt}::timestamptz)`,
      )
      const rows = (await tx.execute(sql`
        update core.message_bodies b set fingerprinted_at = now()
          from (values ${sql.join(refs, sql`, `)}) as v (message_id, created_at)
         where b.message_id = v.message_id and b.created_at = v.created_at
           and b.fingerprinted_at is null
        returning b.message_id
      `)) as unknown as { message_id: string }[]
      for (const r of rows) won.add(String(r.message_id))
    }
    const counted = seen.filter(
      ({ item }) => !item.messageId || !item.createdAt || won.has(item.messageId),
    )

    const hosts = new Map<string, { day: string; host: string; messages: number }>()
    for (const { day, print, trustedBy, hosts: linked } of counted) {
      if (print) {
        const key = `${day}|${print.exact}`
        const before = prints.get(key)
        prints.set(key, {
          day,
          exact: print.exact,
          bands: print.bands,
          messages: (before?.messages ?? 0) + 1,
          // ⚠ FAILS CLOSED: one message with this fingerprint that did not fit
          // makes the fingerprint count.
          trustedBy: before && before.trustedBy !== trustedBy ? null : trustedBy,
        })
      }
      for (const h of linked) {
        const key = `${day}|${h}`
        const before = hosts.get(key)
        hosts.set(key, { day, host: h, messages: (before?.messages ?? 0) + 1 })
      }
    }

    for (const { day, exact, bands, messages, trustedBy } of prints.values()) {
      // ⚠ THE MARK SURVIVES ONLY WHILE EVERY SIGHTING AGREES. A row first
      // seen untrusted stays untrusted for the day; a trusted row seen once
      // without the same mark loses it.
      await tx.execute(sql`
        insert into core.content_fingerprints (tenant_id, day, exact, bands, messages, trusted_by)
        values (${tenantId}::uuid, ${day}::date, ${exact}, ${`{${bands.join(",")}}`}::text[], ${messages}, ${trustedBy})
        on conflict (tenant_id, day, exact)
        do update set messages = core.content_fingerprints.messages + excluded.messages,
                      last_seen_at = now(),
                      trusted_by = case
                        when core.content_fingerprints.trusted_by = excluded.trusted_by
                        then core.content_fingerprints.trusted_by
                      end
      `)
    }
    for (const { day, host, messages } of [...hosts.values()].slice(0, 200)) {
      await tx.execute(sql`
        insert into core.link_hosts (tenant_id, day, host, messages)
        values (${tenantId}::uuid, ${day}::date, ${host}, ${messages})
        on conflict (tenant_id, day, host)
        do update set messages = core.link_hosts.messages + excluded.messages
      `)
    }
  })

  const redis = deps.redis
  if (!redis || !deps.rescore) return
  /*
   * ⚠ ONE PIPELINE FOR THE WHOLE BATCH. Nine keys per fingerprint, three
   * commands per key, awaited one by one, would be dozens of round trips per
   * workspace; pipelined it is one.
   */
  const keys = [...prints.values()]
    .filter(({ trustedBy }) => trustedBy === null)
    .flatMap(({ exact, bands }) => [
      `risk:fp:x:${exact}`,
      ...bands.map((b) => `risk:fp:b:${b}`),
    ])
  if (keys.length === 0) return
  const pipe = redis.pipeline()
  for (const key of keys)
    pipe.sadd(key, tenantId).expire(key, WINDOW_SECONDS).scard(key)
  const replies = (await pipe.exec()) ?? []
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    const n = Number(replies[i * 3 + 2]?.[1] ?? 0)
    if (n < deps.threshold) continue
    // ⚠ ONCE PER KEY PER HOUR. A farm sending all day would otherwise
    // re-score its whole cluster on every single pass.
    const first = await redis.set(`${key}:tripped`, "1", "EX", 3600, "NX")
    if (first === null) continue
    deps.rescore(await redis.smembers(key), "farm-tripwire")
  }
}

export interface FingerprintDeps extends ContentDeps {
  now?: Date
  /** Where data-URI images moved to (#168); needed only once any have. */
  store?: ContentStore | null
  /** Bodies per workspace per pass. */
  limit?: number
}

/**
 * Fingerprints one workspace's bodies that have not been, oldest first.
 *
 * ⚠ ANY STATUS, NOT ONLY FINISHED. Accept fingerprinted every message the
 * moment it was written, scheduled or not; the farm check reads sightings, not
 * deliveries, and a farm queueing its mail for tonight is still a farm.
 *
 * ⚠ RESTORED FIRST: a body compaction already took apart is a template plus
 * values, and a fingerprint of the values alone would match nothing.
 */
export async function fingerprintStored(
  tenantId: string,
  deps: FingerprintDeps,
): Promise<number> {
  const now = deps.now ?? new Date()
  const restored = await withTenant(deps.db, tenantId, async (tx) => {
    const raw = (await tx.execute(sql`
      select b.message_id, b.created_at::text as created_at, m.subject, b.html, b.text,
             b.template_id, b.template_values, b.inline_objects, b.pack_id, b.pack_offset, b.pack_length, b.body_key
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.fingerprinted_at is null
         and b.created_at > ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz
       order by b.created_at
       limit ${deps.limit ?? 500}
    `)) as unknown as {
      message_id: string
      created_at: string
      subject: string
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
  if (restored.length === 0) return 0
  // Packed bodies (#188) and images (#168) back in: the tripwire reads what
  // was sent.
  const rows = await restoreContent(
    deps.db,
    deps.store ?? null,
    tenantId,
    restored.map((r) => ({
      ...r,
      messageId: r.message_id,
      inlineObjects: r.inline_objects,
      packId: r.pack_id,
      packOffset: r.pack_offset,
      packLength: r.pack_length,
      bodyKey: r.body_key,
    })),
  )
  await recordContent(
    tenantId,
    rows.map((r) => ({
      subject: r.subject,
      html: r.html,
      text: r.text,
      messageId: r.message_id,
      createdAt: String(r.created_at),
    })),
    deps,
  )
  return rows.length
}
