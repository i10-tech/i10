import { sql } from "drizzle-orm"
import type { SendEmail } from "@repo/contracts"
import { withTenant, type Database } from "../db/client.js"
import { classify, trustMark } from "../content/trust.js"
import { ALLOWLISTED, fingerprint, linkHosts, type Fingerprint } from "./fingerprint.js"
import type { TrustSource } from "./trusted.js"

/**
 * What accept records about content (#170): fingerprints, link hosts, and the
 * farm tripwire.
 *
 * ⚠ AFTER THE MESSAGES ARE WRITTEN AND NEVER AWAITED BY THE REQUEST. The
 * caller fires this and moves on; a Redis or Postgres hiccup here costs a
 * fingerprint, never a send, and never a millisecond of somebody's password
 * reset.
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
 * ⚠ BOUNDED WORK PER REQUEST. A batch of 500 personalised copies of one
 * template is one fingerprint after normalising; a batch of 500 different
 * bodies is a batch that deserves sampling, not 500 signatures on the event
 * loop that serves everybody's password resets.
 */
export const MAX_FINGERPRINTS_PER_REQUEST = 25

export async function recordContent(
  tenantId: string,
  payloads: readonly SendEmail[],
  deps: ContentDeps,
): Promise<void> {
  const prints = new Map<
    string,
    { bands: string[]; messages: number; trustedBy: string | null }
  >()
  const hosts = new Map<string, number>()
  const trust = deps.trust
    ? await deps.trust.forTenant(tenantId).catch(() => null)
    : null
  let computed = 0
  for (const p of payloads) {
    const html = typeof p.html === "string" ? p.html : null
    const text = typeof p.text === "string" ? p.text : null
    if (computed < MAX_FINGERPRINTS_PER_REQUEST) {
      const fp: Fingerprint | null = fingerprint(p.subject, html, text)
      computed++
      if (fp && !ALLOWLISTED.has(fp.exact)) {
        const found =
          trust && trust.entries.length > 0
            ? await classify({ html, text }, trust.entries, trust.ctx).catch(() => null)
            : null
        const mark = found ? trustMark(found.entry) : null
        const seen = prints.get(fp.exact)
        prints.set(fp.exact, {
          bands: fp.bands,
          messages: (seen?.messages ?? 0) + 1,
          // ⚠ FAILS CLOSED: one message with this fingerprint that did not fit
          // makes the fingerprint count.
          trustedBy: seen && seen.trustedBy !== mark ? null : mark,
        })
      }
    }
    for (const h of linkHosts(html, text)) hosts.set(h, (hosts.get(h) ?? 0) + 1)
  }
  if (prints.size === 0 && hosts.size === 0) return

  const day = new Date().toISOString().slice(0, 10)
  await withTenant(deps.db, tenantId, async (tx) => {
    for (const [exact, { bands, messages, trustedBy }] of prints) {
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
    for (const [host, messages] of [...hosts].slice(0, 200)) {
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
   * ⚠ ONE PIPELINE FOR THE WHOLE REQUEST. Nine keys per fingerprint, three
   * commands per key, awaited one by one, would be dozens of round trips per
   * accepted request; pipelined it is one.
   */
  const keys = [...prints]
    .filter(([, { trustedBy }]) => trustedBy === null)
    .flatMap(([exact, { bands }]) => [
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
    // re-score its whole cluster on every single request.
    const first = await redis.set(`${key}:tripped`, "1", "EX", 3600, "NX")
    if (first === null) continue
    deps.rescore(await redis.smembers(key), "farm-tripwire")
  }
}
