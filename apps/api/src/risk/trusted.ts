import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { trustedTemplateEvents, trustedTemplates } from "../db/core.js"
import {
  parseSubmission,
  trustMark,
  type Hole,
  type Skeleton,
  type SubmissionInput,
  type TrustContext,
  type TrustEntry,
  type Verdict,
} from "../content/trust.js"
import { registrable } from "./rules.js"

/**
 * Trusted content (#222): the staff-kept boilerplate list, the templates
 * workspaces submit for review, and what the accept path and the hourly job
 * need from both.
 *
 * ⚠ ONE DOOR PER CHANGE, EACH AUDITED IN THE SAME TRANSACTION. A submission,
 * a decision, a revocation and a withdrawal each write their event beside the
 * row; the boilerplate list is changed only through its definers, which do
 * the same.
 *
 * ⚠ TAKING TRUST AWAY TAKES IT AWAY FROM THE PAST TOO. A revoked or withdrawn
 * template, or a removed boilerplate entry, has its marks cleared from the
 * fingerprints and vectors it excused, so the next score counts that mail in
 * full. Trust granted is never retroactive the other way: new marks are only
 * ever written as new mail is seen.
 */

export type TrustedStatus =
  "pending" | "approved" | "rejected" | "revoked" | "withdrawn"

export interface TrustedTemplate {
  id: string
  tenantId: string
  name: string
  status: TrustedStatus
  html: string | null
  text: string | null
  holes: Hole[]
  segments: string[]
  staticHosts: string[]
  matched: number
  submittedBy: string
  submittedAt: Date
  decidedBy: string | null
  decidedAt: Date | null
  decisionReason: string | null
}

/** Live submissions (pending or approved) a workspace may have at once. */
export const MAX_LIVE_TEMPLATES = 50
/** Pending ones, so one workspace cannot bury the review queue. */
export const MAX_PENDING_TEMPLATES = 10

export type SubmitResult =
  | { template: TrustedTemplate }
  | { error: string; code: "invalid" | "duplicate" | "limit" }

type Row = typeof trustedTemplates.$inferSelect

const present = (r: Row): TrustedTemplate => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  status: r.status as TrustedStatus,
  html: r.html,
  text: r.text,
  holes: r.holes as Hole[],
  segments: r.segments as string[],
  staticHosts: r.staticHosts,
  matched: r.matched,
  submittedBy: r.submittedBy,
  submittedAt: r.submittedAt,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  decisionReason: r.decisionReason,
})

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]

/** Clears the marks one template put on this workspace's fingerprints and vectors. */
async function clearMarks(tx: Tx, tenantId: string, templateId: string) {
  const mark = trustMark({ kind: "template", id: templateId })
  await tx.execute(sql`
    update core.content_fingerprints set trusted_by = null
     where tenant_id = ${tenantId}::uuid and trusted_by = ${mark}
  `)
  await tx.execute(sql`
    update core.content_vectors set trusted_by = null
     where tenant_id = ${tenantId}::uuid and trusted_by = ${mark}
  `)
}

export interface TrustedTemplateStore {
  list(tenantId: string): Promise<TrustedTemplate[]>
  get(tenantId: string, id: string): Promise<TrustedTemplate | null>
  submit(
    tenantId: string,
    input: SubmissionInput & { name: string },
    by: string,
  ): Promise<SubmitResult>
  /** A pending decision, by staff. Null when it is not pending. */
  decide(
    tenantId: string,
    id: string,
    decision: "approve" | "reject",
    by: string,
    reason: string,
  ): Promise<TrustedTemplate | null>
  /** Takes an approval away. Null when it was not approved. */
  revoke(
    tenantId: string,
    id: string,
    by: string,
    reason: string,
    detail?: Record<string, unknown>,
  ): Promise<TrustedTemplate | null>
  /** Every approval of the workspace, on a staff abuse verdict. */
  revokeAll(tenantId: string, by: string, reason: string): Promise<TrustedTemplate[]>
  /** The workspace takes back a pending or approved submission. */
  withdraw(tenantId: string, id: string, by: string): Promise<TrustedTemplate | null>
  /** Approved templates, as the matcher reads them. */
  approved(tenantId: string): Promise<TrustEntry[]>
  /** Adds newly credited messages to each template's count. */
  credit(tenantId: string, counts: ReadonlyMap<string, number>): Promise<void>
  events(
    tenantId: string,
    id: string,
  ): Promise<(typeof trustedTemplateEvents.$inferSelect)[]>
}

export function trustedTemplateStore(db: Database): TrustedTemplateStore {
  const t = trustedTemplates

  async function transition(
    tenantId: string,
    id: string,
    from: TrustedStatus[],
    to: TrustedStatus,
    raw: { action: string; by: string; reason: string | null; detail?: unknown },
    decision: boolean,
  ) {
    const event = { ...raw, reason: raw.reason?.trim() || null }
    return withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .update(t)
        .set({
          status: to,
          // ⚠ THE DATABASE'S CLOCK, NOT THIS PROCESS'S. `decided_at` is compared
          // with `risk_labels.labeled_at` (an abuse label after an approval
          // revokes it), and two clocks milliseconds apart would decide which
          // came first.
          updatedAt: sql`now()`,
          ...(decision
            ? {
                decidedBy: event.by,
                decidedAt: sql`now()`,
                decisionReason: event.reason,
              }
            : {}),
        })
        .where(and(eq(t.tenantId, tenantId), eq(t.id, id), inArray(t.status, from)))
        .returning()
      if (!row) return null
      await tx.insert(trustedTemplateEvents).values({
        tenantId,
        templateId: id,
        action: event.action,
        setBy: event.by,
        reason: event.reason,
        detail: event.detail ?? null,
      })
      if (to === "revoked" || to === "withdrawn") await clearMarks(tx, tenantId, id)
      return present(row)
    })
  }

  const store: TrustedTemplateStore = {
    async list(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(t)
          .where(eq(t.tenantId, tenantId))
          .orderBy(desc(t.submittedAt))
          .limit(200),
      )
      return rows.map(present)
    },

    async get(tenantId, id) {
      if (!isUuid(id)) return null
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(t)
          .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
          .limit(1),
      )
      return row ? present(row) : null
    },

    async submit(tenantId, input, by) {
      const name = input.name.trim()
      if (!name || name.length > 100)
        return { error: "`name` is required, at most 100 characters.", code: "invalid" }
      const parsed = parseSubmission(input)
      if ("error" in parsed) return { error: parsed.error, code: "invalid" }
      return withTenant(db, tenantId, async (tx): Promise<SubmitResult> => {
        const [counts] = (await tx.execute(sql`
          select count(*) filter (where status in ('pending', 'approved'))::int as live,
                 count(*) filter (where status = 'pending')::int as pending
            from core.trusted_templates where tenant_id = ${tenantId}::uuid
        `)) as unknown as { live: number; pending: number }[]
        if (Number(counts?.live ?? 0) >= MAX_LIVE_TEMPLATES)
          return {
            error: `A workspace may have ${MAX_LIVE_TEMPLATES} pending or approved templates.`,
            code: "limit",
          }
        if (Number(counts?.pending ?? 0) >= MAX_PENDING_TEMPLATES)
          return {
            error: `A workspace may have ${MAX_PENDING_TEMPLATES} templates waiting for review.`,
            code: "limit",
          }
        const [dup] = await tx
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              eq(t.tenantId, tenantId),
              eq(t.skeletonHash, parsed.skeletonHash),
              inArray(t.status, ["pending", "approved"]),
            ),
          )
          .limit(1)
        if (dup)
          return {
            error: "This template is already waiting for review or approved.",
            code: "duplicate",
          }
        const [row] = await tx
          .insert(t)
          .values(rowFor(tenantId, name, input, parsed, by))
          .returning()
        await tx.insert(trustedTemplateEvents).values({
          tenantId,
          templateId: row!.id,
          action: "submit",
          setBy: by,
          reason: null,
          detail: { holes: parsed.holes.length, staticBytes: parsed.staticBytes },
        })
        return { template: present(row!) }
      })
    },

    decide: (tenantId, id, decision, by, reason) =>
      transition(
        tenantId,
        id,
        ["pending"],
        decision === "approve" ? "approved" : "rejected",
        { action: decision, by, reason },
        true,
      ),

    revoke: (tenantId, id, by, reason, detail) =>
      transition(
        tenantId,
        id,
        ["approved"],
        "revoked",
        { action: "revoke", by, reason, ...(detail ? { detail } : {}) },
        true,
      ),

    async revokeAll(tenantId, by, reason) {
      const out: TrustedTemplate[] = []
      for (const a of (await store.list(tenantId)).filter(
        (x) => x.status === "approved",
      )) {
        const r = await store.revoke(tenantId, a.id, by, reason)
        if (r) out.push(r)
      }
      return out
    },

    withdraw: (tenantId, id, by) =>
      isUuid(id)
        ? transition(
            tenantId,
            id,
            ["pending", "approved"],
            "withdrawn",
            { action: "withdraw", by, reason: null },
            false,
          )
        : Promise.resolve(null),

    async approved(tenantId) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: t.id, name: t.name, segments: t.segments, holes: t.holes })
          .from(t)
          .where(and(eq(t.tenantId, tenantId), eq(t.status, "approved"))),
      )
      return rows.map((r) => ({
        kind: "template" as const,
        id: r.id,
        name: r.name,
        template: { segments: r.segments as string[] },
        limits: (r.holes as Hole[]).map((h) => h.max),
      }))
    },

    async credit(tenantId, counts) {
      if (counts.size === 0) return
      await withTenant(db, tenantId, async (tx) => {
        for (const [id, n] of counts) {
          await tx
            .update(t)
            .set({ matched: sql`${t.matched} + ${n}` })
            .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))
        }
      })
    },

    async events(tenantId, id) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(trustedTemplateEvents)
          .where(
            and(
              eq(trustedTemplateEvents.tenantId, tenantId),
              eq(trustedTemplateEvents.templateId, id),
            ),
          )
          .orderBy(trustedTemplateEvents.occurredAt),
      )
    },
  }
  return store
}

function rowFor(
  tenantId: string,
  name: string,
  input: SubmissionInput,
  parsed: Skeleton,
  by: string,
) {
  return {
    tenantId,
    name,
    html: input.html || null,
    text: input.text || null,
    skeletonHash: parsed.skeletonHash,
    segments: parsed.template.segments,
    holes: parsed.holes,
    bands: parsed.bands,
    staticHosts: parsed.staticHosts,
    submittedBy: by,
  }
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

// ─── The boilerplate list ────────────────────────────────────────────────────

export interface BoilerplateEntry {
  id: string
  name: string
  skeletonHash: string
  segments: string[]
  holeLimits: number[]
  bands: string[]
  staticBytes: number
  holes: number
  model: string | null
  reason: string
  addedBy: string
  addedAt: Date
}

export interface BoilerplateStore {
  list(): Promise<BoilerplateEntry[]>
  add(input: {
    name: string
    skeleton: Skeleton
    model: string | null
    embedding: number[] | null
    reason: string
    by: string
  }): Promise<string>
  remove(id: string, reason: string, by: string): Promise<boolean>
  history(limit: number): Promise<Record<string, unknown>[]>
  /** The entry this workspace's unexcused recent mail reads closest to. */
  nearest(
    tenantId: string,
    model: string,
    since: string,
  ): Promise<{ name: string; similarity: number } | null>
}

const vectorLiteral = (v: readonly number[]) =>
  `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`

export function boilerplateStore(db: Database): BoilerplateStore {
  return {
    async list() {
      const rows = (await db.execute(
        sql`select * from core.risk_boilerplate_list()`,
      )) as unknown as Record<string, unknown>[]
      return rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        skeletonHash: String(r.skeleton_hash),
        segments: r.segments as string[],
        holeLimits: r.hole_limits as number[],
        bands: (r.bands as string[]) ?? [],
        staticBytes: Number(r.static_bytes),
        holes: Number(r.holes),
        model: (r.model as string | null) ?? null,
        reason: String(r.reason),
        addedBy: String(r.added_by),
        addedAt: new Date(r.added_at as string),
      }))
    },

    async add({ name, skeleton, model, embedding, reason, by }) {
      const rows = (await db.execute(sql`
        select core.risk_boilerplate_add(
          ${name}, ${skeleton.skeletonHash}, ${JSON.stringify(skeleton.template.segments)}::jsonb,
          ${JSON.stringify(skeleton.holes.map((h) => h.max))}::jsonb,
          ${`{${skeleton.bands.join(",")}}`}::text[], ${skeleton.staticBytes},
          ${skeleton.holes.length}, ${model}, ${embedding ? vectorLiteral(embedding) : null},
          ${reason}, ${by}
        ) as id
      `)) as unknown as { id: string }[]
      return String(rows[0]!.id)
    },

    async remove(id, reason, by) {
      if (!isUuid(id)) return false
      const rows = (await db.execute(
        sql`select core.risk_boilerplate_remove(${id}::uuid, ${reason}, ${by}) as ok`,
      )) as unknown as { ok: boolean }[]
      return rows[0]?.ok === true
    },

    async history(limit) {
      return (await db.execute(
        sql`select * from core.risk_boilerplate_history(${limit})`,
      )) as unknown as Record<string, unknown>[]
    },

    async nearest(tenantId, model, since) {
      const rows = (await db.execute(sql`
        select * from core.risk_boilerplate_nearest(${tenantId}::uuid, ${model}, ${since}::date)
      `)) as unknown as { name: string; similarity: number }[]
      const r = rows[0]
      return r ? { name: String(r.name), similarity: Number(r.similarity) } : null
    },
  }
}

// ─── What the accept path and the job match against ──────────────────────────

export interface TrustSource {
  /** The entries a workspace's mail may match, and the context to fence holes with. */
  forTenant(tenantId: string): Promise<{ entries: TrustEntry[]; ctx: TrustContext }>
}

/**
 * The lists, cached per process.
 *
 * ⚠ CACHED FOR A MINUTE, SO A CHANGE TAKES A MINUTE. The accept path runs this
 * for every request that fingerprints mail; a query per request for a list
 * that changes a few times a month would be the wrong trade. Approval and
 * boilerplate additions are not urgent; revocations clear their marks in the
 * database at once, and a minute of stale credit on new mail is the cost.
 */
export function trustSource(
  db: Database,
  {
    verdict,
    ttlMs = 60_000,
    maxTenants = 5_000,
    templates = trustedTemplateStore(db),
    boilerplate = boilerplateStore(db),
    now = () => Date.now(),
  }: {
    verdict: (host: string) => Promise<Verdict>
    ttlMs?: number
    maxTenants?: number
    templates?: Pick<TrustedTemplateStore, "approved">
    boilerplate?: Pick<BoilerplateStore, "list">
    now?: () => number
  },
): TrustSource {
  let global: { at: number; entries: TrustEntry[] } | null = null
  const perTenant = new Map<
    string,
    { at: number; entries: TrustEntry[]; parents: Set<string> }
  >()

  const boilerplateEntries = async () => {
    if (global && now() - global.at < ttlMs) return global.entries
    const entries = (await boilerplate.list()).map((b) => ({
      kind: "boilerplate" as const,
      id: b.id,
      name: b.name,
      template: { segments: b.segments },
      limits: b.holeLimits,
    }))
    global = { at: now(), entries }
    return entries
  }

  return {
    async forTenant(tenantId) {
      let mine = perTenant.get(tenantId)
      if (!mine || now() - mine.at >= ttlMs) {
        const [entries, domains] = await Promise.all([
          templates.approved(tenantId),
          withTenant(db, tenantId, (tx) =>
            tx.execute(sql`
              select name from core.domains
               where tenant_id = ${tenantId}::uuid and verified_at is not null
                 and status <> 'failed' and displaced_at is null
            `),
          ) as unknown as Promise<{ name: string }[]>,
        ])
        const parents = new Set(
          domains.map((d) => registrable(String(d.name))).filter(Boolean) as string[],
        )
        mine = { at: now(), entries, parents }
        if (perTenant.size >= maxTenants)
          perTenant.delete(perTenant.keys().next().value!)
        perTenant.set(tenantId, mine)
      }
      return {
        entries: [...mine.entries, ...(await boilerplateEntries())],
        ctx: { verifiedParents: mine.parents, verdict },
      }
    },
  }
}

// ─── Judging approvals by their results ──────────────────────────────────────

export interface Revocation {
  template: TrustedTemplate
  /** The customer-facing category, never a threshold. */
  category: "bounces" | "complaints" | "abuse"
  detail: Record<string, number | string>
}

/**
 * Revokes approvals whose own messages bounce or complain past the thresholds,
 * and every approval of a workspace staff labelled abusive since.
 *
 * ⚠ THE SAME LINES THE RULES DRAW (risk/rules.ts): 4% hard bounces, or 0.1%
 * complaints with at least two, over at least 100 sent messages, counted on
 * exactly the messages that got the template's credit, since it was approved
 * (at most 30 days back).
 */
export async function reviewTrusted(
  db: Database,
  store: TrustedTemplateStore,
  tenantId: string,
  now: Date,
): Promise<Revocation[]> {
  const approved = (await store.list(tenantId)).filter((x) => x.status === "approved")
  if (approved.length === 0) return []
  const out: Revocation[] = []

  const [abuse] = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select max(labeled_at) as at from core.risk_labels
       where tenant_id = ${tenantId}::uuid and label = 'abuse'
         and source in ('staff', 'hold_upheld')
    `),
  )) as unknown as { at: string | null }[]
  const abuseAt = abuse?.at ? new Date(abuse.at) : null

  const floor = new Date(now.getTime() - 30 * 86_400_000)
  const ids = `{${approved.map((a) => a.id).join(",")}}`
  const rows = (await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      select b.trusted_template_id as id,
             count(distinct b.message_id) filter (where e.type = 'sent')::int as sends,
             count(distinct b.message_id) filter (
               where e.type = 'bounced' and e.payload->'bounce'->>'bounceType' = 'Permanent')::int as hard,
             count(distinct b.message_id) filter (where e.type = 'complained')::int as complaints
        from core.message_bodies b
        left join core.message_events e
          on e.tenant_id = b.tenant_id and e.message_id = b.message_id
         and e.type in ('sent', 'bounced', 'complained')
       where b.tenant_id = ${tenantId}::uuid
         and b.trusted_template_id = any(${ids}::uuid[])
         and b.created_at > ${floor.toISOString()}::timestamptz
       group by 1
    `),
  )) as unknown as { id: string; sends: number; hard: number; complaints: number }[]

  for (const a of approved) {
    if (abuseAt && a.decidedAt && abuseAt > a.decidedAt) {
      const r = await store.revoke(
        tenantId,
        a.id,
        "risk-score",
        "The workspace was confirmed abusive by our team.",
        { cause: "abuse_label" },
      )
      if (r)
        out.push({ template: r, category: "abuse", detail: { cause: "abuse_label" } })
      continue
    }
    const since = a.decidedAt && a.decidedAt > floor ? a.decidedAt : floor
    const r = rows.find((x) => String(x.id) === a.id)
    if (!r) continue
    const sends = Number(r.sends)
    if (sends < 100) continue
    const hard = Number(r.hard)
    const complaints = Number(r.complaints)
    const bounceRate = Math.round((hard / sends) * 10_000) / 100
    const complaintRate = Math.round((complaints / sends) * 10_000) / 100
    const category =
      complaints >= 2 && complaintRate >= 0.1
        ? "complaints"
        : bounceRate >= 4
          ? "bounces"
          : null
    if (!category) continue
    const detail = {
      sends,
      hardBounces: hard,
      complaints,
      bounceRate,
      complaintRate,
      since: since.toISOString(),
    }
    const revoked = await store.revoke(
      tenantId,
      a.id,
      "risk-score",
      category === "complaints"
        ? "Recipients marked mail sent with this template as spam."
        : "Too many messages sent with this template bounced.",
      detail,
    )
    if (revoked) out.push({ template: revoked, category, detail })
  }
  return out
}
