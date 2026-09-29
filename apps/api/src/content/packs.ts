import { sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { restoreInline, type InlineRow } from "./inline.js"
import { packKey, type ContentStore, type ObjectStore } from "./object-store.js"
import { openBody, sealBody, type Body } from "./seal.js"

/**
 * Message bodies to R2, in packs (#188). The design is docs/decisions/
 * storage.md, "Bodies to R2".
 *
 * The lifecycle of one body:
 *   1. Accept writes it inline, as always. Nothing touches R2 before the 202.
 *   2. The worker sends from the row.
 *   3. Compaction examines it (#171). Near-duplicates become a template plus
 *      values and STAY IN POSTGRES: they are small, and a write each would cost
 *      more than they save.
 *   4. `packBodies`, an hour or more later, takes what is still a full body,
 *      seals each one (content/seal.ts), appends them to one object per
 *      workspace, uploads it, reads it back, and only then clears the bodies
 *      from Postgres and points each row at its bytes.
 *   5. Readers restore through `restoreContent`: one ranged GET per body,
 *      cached in the API.
 *   6. Retention deletes the row, and the body key with it; `sweepPacks`
 *      deletes a pack once no row points into it.
 *
 * ⚠ R2 IS NEVER THE ONLY COPY UNTIL IT HAS PROVED IT HOLDS THE BYTES. The pack
 * is uploaded, read back whole and compared byte for byte before a single row
 * is cleared, in one transaction after that. An R2 that fails, times out or
 * returns anything else leaves every body in Postgres, and the next run tries
 * again - a bad day at Cloudflare costs Postgres space, never mail.
 *
 * ⚠ BATCHED, BECAUSE R2 BILLS PER WRITE. One PUT carries up to
 * `maxPackBytes` of bodies, and a workspace ships only when enough is waiting
 * (`targetBytes`) or the oldest has waited `maxWaitHours` - so a quiet
 * workspace still leaves Postgres within hours, and a busy one costs a handful
 * of writes a day.
 */

export interface PackDeps {
  db: Database
  store: ContentStore
  now?: Date
  /** A body younger than this is left alone: its twin may still pair with it. */
  minAgeMinutes?: number
  /** Bytes waiting that make a write worth it. */
  targetBytes: number
  /** A body waiting this long past `minAgeMinutes` ships whatever the volume. */
  maxWaitHours: number
  /** Bytes of bodies per pack, before sealing. */
  maxPackBytes?: number
  /** Packs per workspace per run. */
  maxPacks?: number
  /**
   * Wait for the risk passes (fingerprint, analyse) to have read a body
   * first, up to a day, so they read it from Postgres and not from R2.
   */
  awaitRisk?: boolean
  /** Linked to a template that never established: packed after this. */
  linkWaitHours?: number
  /** How far back compaction looks; older bodies need not be examined. */
  windowDays?: number
  log?: { warn?: (o: object, m: string) => void }
}

export interface PackResult {
  packs: number
  bodies: number
  /** Bytes the bodies took in Postgres. */
  rawBytes: number
  /** Bytes written to R2. */
  sealedBytes: number
  /** True when bodies were ready but too few to be worth a write yet. */
  waiting: boolean
  errors: number
}

const MIB = 1024 * 1024

interface Candidate {
  message_id: string
  created_at: string
  bytes: string | number
}

/** Packs one workspace's finished full bodies into R2. */
export async function packBodies(
  tenantId: string,
  deps: PackDeps,
): Promise<PackResult> {
  const result: PackResult = {
    packs: 0,
    bodies: 0,
    rawBytes: 0,
    sealedBytes: 0,
    waiting: false,
    errors: 0,
  }
  if (!deps.store.keys) return result
  const now = (deps.now ?? new Date()).getTime()
  const at = (ms: number) => new Date(now - ms).toISOString()
  const minAge = (deps.minAgeMinutes ?? 60) * 60_000
  const ready = at(minAge)
  const shipAnyway = now - minAge - deps.maxWaitHours * 3_600_000
  const maxPackBytes = deps.maxPackBytes ?? 16 * MIB

  const rows = (await withTenant(deps.db, tenantId, (tx) =>
    tx.execute(sql`
      select b.message_id, b.created_at::text as created_at,
             (coalesce(octet_length(b.html), 0) + coalesce(octet_length(b.text), 0))::bigint as bytes
        from core.message_bodies b
        join core.messages m on m.id = b.message_id and m.created_at = b.created_at
       where b.tenant_id = ${tenantId}::uuid
         and b.pack_id is null
         and b.compacted_at is null
         and (b.html is not null or b.text is not null)
         and b.created_at < ${ready}::timestamptz
         and m.status in ('sent', 'failed', 'canceled')
         -- ⚠ COMPACTION FIRST. A body it has not examined may be a receipt that
         -- belongs in a template; packing it would store it whole for good.
         -- Past compaction's window nothing will examine it, so it goes.
         and (b.examined_at is not null
              or b.created_at < ${at((deps.windowDays ?? 7) * 86_400_000)}::timestamptz)
         -- ⚠ A LINKED BODY IS WAITING FOR ITS TEMPLATE TO ESTABLISH. One whose
         -- template never did is unlinked and packed like unique mail.
         and (b.template_id is null
              or b.created_at < ${at((deps.linkWaitHours ?? 24) * 3_600_000)}::timestamptz)
         and (${!deps.awaitRisk}::boolean
              or (b.analysed_at is not null and b.fingerprinted_at is not null)
              or b.created_at < ${at(86_400_000)}::timestamptz)
       order by b.created_at
       limit 20000
    `),
  )) as unknown as Candidate[]
  if (rows.length === 0) return result

  // ── Into packs, oldest first; each ships only if worth the write ──
  const chunks: Candidate[][] = []
  let chunk: Candidate[] = []
  let size = 0
  for (const r of rows) {
    chunk.push(r)
    size += Number(r.bytes)
    if (size >= maxPackBytes) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }
  }
  if (chunk.length > 0) chunks.push(chunk)

  // ⚠ FEW PACKS PER RUN. The job has four minutes for every workspace; a
  // backlog drains over several runs, and a run cut short mid-pack loses
  // nothing (the rows are released only by the last step).
  for (const c of chunks.slice(0, deps.maxPacks ?? 4)) {
    const bytes = c.reduce((n, r) => n + Number(r.bytes), 0)
    const oldest = Date.parse(c[0]!.created_at)
    if (bytes < deps.targetBytes && oldest > shipAnyway) {
      // ⚠ NOT YET. Oldest first, so nothing after this chunk is older.
      result.waiting = true
      break
    }
    try {
      const packed = await packOne(tenantId, c, deps)
      if (!packed) continue
      result.packs++
      result.bodies += packed.bodies
      result.rawBytes += packed.rawBytes
      result.sealedBytes += packed.sealedBytes
    } catch (error) {
      result.errors++
      // ⚠ THE BODIES STAY IN POSTGRES, a correct state. The pack row, if one
      // was written, points at nothing and is swept after its grace.
      deps.log?.warn?.({ err: error, tenantId }, "could not pack bodies")
      break
    }
  }
  return result
}

const md5 = (s: string | null) =>
  s === null ? null : new Bun.CryptoHasher("md5").update(s).digest("hex")

const keyList = (rows: readonly { message_id: string; created_at: string }[]): SQL =>
  sql.join(
    rows.map((r) => sql`(${r.message_id}::uuid, ${r.created_at}::timestamptz)`),
    sql`, `,
  )

async function packOne(
  tenantId: string,
  chunk: readonly Candidate[],
  { db, store }: PackDeps,
) {
  const keys = store.keys!
  const bodies = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select message_id, created_at::text as created_at, html, text
        from core.message_bodies
       where tenant_id = ${tenantId}::uuid
         and (message_id, created_at) in (${keyList(chunk)})
         and pack_id is null
         and compacted_at is null
    `),
  )) as unknown as {
    message_id: string
    created_at: string
    html: string | null
    text: string | null
  }[]
  if (bodies.length === 0) return null

  // ── Seal, each on its own key, and lay them end to end ──
  const parts: Buffer[] = []
  const placed: {
    message_id: string
    created_at: string
    offset: number
    length: number
    key: string
    html: string | null
    text: string | null
  }[] = []
  let offset = 0
  let rawBytes = 0
  for (const b of bodies) {
    const sealed = sealBody(
      keys,
      { tenantId, messageId: b.message_id },
      { html: b.html, text: b.text },
    )
    parts.push(sealed.record)
    placed.push({
      message_id: b.message_id,
      created_at: b.created_at,
      offset,
      length: sealed.record.byteLength,
      key: sealed.wrappedKey,
      html: b.html,
      text: b.text,
    })
    offset += sealed.record.byteLength
    rawBytes += Buffer.byteLength(b.html ?? "") + Buffer.byteLength(b.text ?? "")
  }
  const pack = Buffer.concat(parts)

  // ── The row first, so a pack that uploads and never commits is swept ──
  const [row] = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      insert into core.content_packs (tenant_id, size, bodies, raw_size)
      values (${tenantId}::uuid, ${pack.byteLength}, ${placed.length}, ${rawBytes})
      returning id
    `),
  )) as unknown as { id: string }[]
  const packId = String(row!.id)
  const key = packKey(tenantId, packId)

  await store.put(key, pack, "application/octet-stream")
  // ⚠ READ BACK WHOLE BEFORE ANYTHING IS RELEASED. A PUT that "succeeded" is a
  // promise; these bytes coming back identical is the proof.
  const back = await store.get(key)
  if (!pack.equals(Buffer.from(back.buffer, back.byteOffset, back.byteLength))) {
    throw new Error(`pack ${packId} did not read back as written`)
  }

  // ── Release, guarded on the bodies being exactly what was sealed ──
  let moved = 0
  await withTenant(db, tenantId, async (tx) => {
    for (let i = 0; i < placed.length; i += 500) {
      const batch = placed.slice(i, i + 500)
      const values = sql.join(
        batch.map(
          (p) =>
            sql`(${p.message_id}::uuid, ${p.created_at}::timestamptz, ${p.offset}::bigint, ${p.length}::integer, ${p.key}::text, ${md5(p.html)}::text, ${md5(p.text)}::text)`,
        ),
        sql`, `,
      )
      const done = (await tx.execute(sql`
        update core.message_bodies b
           set html = null,
               text = null,
               pack_id = ${packId}::uuid,
               pack_offset = v.pack_offset,
               pack_length = v.pack_length,
               body_key = v.body_key,
               packed_at = now(),
               -- ⚠ UNLINKED: a template that never established is not how
               -- this body is stored any more, and a compacted-looking row
               -- (template set, html null) would be rebuilt from it.
               template_id = null,
               template_values = null,
               content_bands = null
          from (values ${values}) as v(message_id, created_at, pack_offset, pack_length, body_key, html_md5, text_md5)
         where b.tenant_id = ${tenantId}::uuid
           and b.message_id = v.message_id
           and b.created_at = v.created_at
           and b.pack_id is null
           and b.compacted_at is null
           and md5(b.html) is not distinct from v.html_md5
           and md5(b.text) is not distinct from v.text_md5
        returning b.message_id
      `)) as unknown as unknown[]
      moved += done.length
    }
  })
  return { bodies: moved, rawBytes, sealedBytes: pack.byteLength }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface PackedRow {
  messageId: string
  html: string | null
  text: string | null
  packId?: string | null
  packOffset?: number | string | null
  packLength?: number | null
  bodyKey?: string | null
}

/**
 * Bodies read back from their packs, for rows `restoreBodies` has already
 * seen. Rows that are not packed pass through untouched.
 *
 * ⚠ ONE RANGED GET PER BODY: that body's bytes, never the whole pack. Opening
 * one email out of a million costs the same as out of ten.
 *
 * ⚠ LOUD WHEN IT CANNOT. A packed body with no store, no key or a pack that
 * will not open is mail we cannot show or resend as it was sent; an empty body
 * would hide that for ever.
 */
export async function restorePacked<T extends PackedRow>(
  store: ContentStore | null,
  tenantId: string,
  rows: T[],
): Promise<T[]> {
  if (!rows.some((r) => r.packId)) return rows
  if (!store?.keys) {
    throw new Error(
      "message body is packed in the content store, and no content store or CONTENT_KEYS is configured",
    )
  }
  const keys = store.keys
  return Promise.all(
    rows.map(async (row) => {
      if (!row.packId) return row
      const cacheKey = `${tenantId}/${row.messageId}`
      const hit = store.cache?.get(cacheKey)
      if (hit) return { ...row, ...hit }
      if (!row.bodyKey) {
        // ⚠ THE KEY IS GONE: the body was deleted (crypto-shredded).
        throw new Error(`message ${row.messageId}'s body was deleted`)
      }
      const record = await store.getRange(
        packKey(tenantId, row.packId),
        Number(row.packOffset),
        Number(row.packLength),
      )
      const body = openBody(
        keys,
        { tenantId, messageId: row.messageId },
        record,
        row.bodyKey,
      )
      store.cache?.set(cacheKey, body)
      return { ...row, ...body }
    }),
  )
}

/**
 * Every body back as it was sent, after `restoreBodies` (templates): packed
 * bodies from R2, then data-URI images (#168).
 */
export async function restoreContent<T extends PackedRow & InlineRow>(
  store: ContentStore | null,
  tenantId: string,
  rows: T[],
): Promise<T[]> {
  return restoreInline(store, tenantId, await restorePacked(store, tenantId, rows))
}

/**
 * Recently opened bodies, in the API process: opening an email twice reads R2
 * once.
 *
 * ⚠ BOUNDED BY SIZE AND AGE. Least recently used goes first past `maxBytes`,
 * and nothing is served older than `ttlMs`. In memory only - never Redis,
 * which would put plaintext mail in a second place.
 */
export class BodyCache {
  private entries = new Map<string, { body: Body; size: number; at: number }>()
  private size = 0

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs = 15 * 60_000,
  ) {}

  get(key: string): Body | null {
    const e = this.entries.get(key)
    if (!e) return null
    if (Date.now() - e.at > this.ttlMs) {
      this.drop(key)
      return null
    }
    // Most recently used moves to the end.
    this.entries.delete(key)
    this.entries.set(key, e)
    return e.body
  }

  set(key: string, body: Body) {
    const size = (body.html?.length ?? 0) * 2 + (body.text?.length ?? 0) * 2
    if (size > this.maxBytes / 4) return
    this.drop(key)
    this.entries.set(key, { body, size, at: Date.now() })
    this.size += size
    for (const k of this.entries.keys()) {
      if (this.size <= this.maxBytes) break
      this.drop(k)
    }
  }

  private drop(key: string) {
    const e = this.entries.get(key)
    if (!e) return
    this.size -= e.size
    this.entries.delete(key)
  }
}

// ─── Sweeping ────────────────────────────────────────────────────────────────

/**
 * Deletes one workspace's packs no body points into any more, past the grace.
 *
 * ⚠ THE BODY ROWS ARE THE REFERENCE, as for objects. Retention deletes a row
 * and its body key together, so the email is unreadable from that moment; the
 * pack goes here once the last row that points into it has gone.
 *
 * ⚠ R2 FIRST, THEN THE ROW, as `sweepObjects` does and for the same reason:
 * a delete that lands with a commit that fails is simply repeated.
 */
export async function sweepPacks(
  tenantId: string,
  deps: { db: Database; store: ObjectStore; graceHours: number; limit?: number },
): Promise<number> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const doomed = (await tx.execute(sql`
      select p.id from core.content_packs p
       where p.tenant_id = ${tenantId}::uuid
         and p.created_at < now() - make_interval(hours => ${deps.graceHours})
         and not exists (
           select 1 from core.message_bodies b
            where b.tenant_id = ${tenantId}::uuid and b.pack_id = p.id
         )
       order by p.created_at
       limit ${deps.limit ?? 200}
       for update skip locked
    `)) as unknown as { id: string }[]
    for (const { id } of doomed) {
      await deps.store.delete(packKey(tenantId, String(id)))
      await tx.execute(sql`delete from core.content_packs where id = ${id}::uuid`)
    }
    return doomed.length
  })
}
