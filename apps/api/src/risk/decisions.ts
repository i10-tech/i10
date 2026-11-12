import { sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { DECISION_MEMORY_DAYS, evaluate, type Evaluated } from "./engine.js"
import { loadFacts, type OwnerInfo } from "./facts.js"
import type { HoldStore } from "./holds.js"
import type { SnapshotStore } from "./snapshot.js"
import type { AssessmentStore, Tx } from "./store.js"
import {
  bandRank,
  type Band,
  type Concern,
  type Contribution,
  type DecisionKind,
  type Rule,
} from "./types.js"

/**
 * Staff decisions and the concerns they covered: the engine's memory of what
 * a person already weighed (docs/decisions/risk.md, "Decision memory").
 *
 * ⚠ A DECISION IS RECORDED IN THE SAME TRANSACTION AS WHAT IT DECIDED, with a
 * forced fact snapshot of the facts it was made on. A release that committed
 * without its record would re-raise the very concern it cleared once the pause
 * ended, which is the promise in section 10 of the acceptable use policy
 * broken.
 */
export interface StoredDecision {
  id: string
  tenantId: string
  kind: DecisionKind
  decidedBy: string
  note: string
  decidedAt: Date
  score: number
  band: Band
  rulesetVersion: number
  held: boolean
  inView: Contribution[]
  covers: Concern[]
  expiresAt: Date
  snapshotId: string | null
  revokedAt: Date | null
  revokedBy: string | null
  revokeNote: string | null
}

type Executor = Pick<Database, "execute">

export interface DecisionStore {
  save(
    through: Executor,
    input: Omit<StoredDecision, "id" | "revokedAt" | "revokedBy" | "revokeNote">,
  ): Promise<string>
  /** One workspace's decisions, or every workspace's; newest first. */
  list(tenantId?: string): Promise<StoredDecision[]>
  /** Revokes a decision's clearing; the workspace it was about, or null if nothing changed. */
  revoke(input: {
    id: string
    by: string
    note: string
    at: Date
  }): Promise<string | null>
}

const date = (v: unknown): Date | null => (v ? new Date(v as string) : null)

export function decisionStore(db: Database): DecisionStore {
  return {
    async save(through, d) {
      const rows = (await through.execute(sql`
        select core.risk_decision_save(
          ${d.tenantId}::uuid, ${d.kind}::core.risk_decision_kind, ${d.decidedBy}, ${d.note},
          ${d.decidedAt.toISOString()}::timestamptz, ${d.score}, ${d.band}::core.risk_band,
          ${d.rulesetVersion}, ${d.held}, ${JSON.stringify(d.inView)}::jsonb,
          ${JSON.stringify(d.covers)}::jsonb, ${d.expiresAt.toISOString()}::timestamptz,
          ${d.snapshotId}::uuid
        ) as id
      `)) as unknown as { id: string }[]
      return String(rows[0]!.id)
    },

    async list(tenantId) {
      const rows = (await db.execute(
        sql`select * from core.risk_decisions_list(${tenantId ?? null}::uuid)`,
      )) as unknown as Record<string, unknown>[]
      return rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        kind: r.kind as DecisionKind,
        decidedBy: String(r.decided_by),
        note: String(r.note),
        decidedAt: date(r.decided_at)!,
        score: Number(r.score),
        band: r.band as Band,
        rulesetVersion: Number(r.ruleset_version),
        held: r.held === true,
        inView: r.in_view as Contribution[],
        covers: r.covers as Concern[],
        expiresAt: date(r.expires_at)!,
        snapshotId: r.snapshot_id ? String(r.snapshot_id) : null,
        revokedAt: date(r.revoked_at),
        revokedBy: (r.revoked_by as string | null) ?? null,
        revokeNote: (r.revoke_note as string | null) ?? null,
      }))
    },

    async revoke({ id, by, note, at }) {
      const rows = (await db.execute(sql`
        select core.risk_decision_revoke(${id}::uuid, ${by}, ${note}, ${at.toISOString()}::timestamptz) as tenant_id
      `)) as unknown as { tenant_id: string | null }[]
      return rows[0]?.tenant_id ? String(rows[0].tenant_id) : null
    },
  }
}

/**
 * What a release or pin covers: every live concern in view, or the ones
 * staff named.
 *
 * ⚠ ONLY POSITIVE CONTRIBUTIONS ARE CONCERNS. Clearing earned trust would raise
 * the score. A named rule that is not a live concern right now is refused, so
 * a typo never silently clears nothing.
 */
export function concernsFor(
  contributions: readonly Contribution[],
  only?: readonly string[],
): Concern[] {
  const live = contributions.filter((c) => c.points > 0)
  if (only) {
    const missing = only.filter((id) => !live.some((c) => c.rule === id))
    if (missing.length > 0)
      throw new RangeError(`not a live concern right now: ${missing.join(", ")}`)
  }
  return live
    .filter((c) => !only || only.includes(c.rule))
    .map((c) => ({
      rule: c.rule,
      points: c.points,
      ...(c.keys ? { keys: c.keys } : {}),
    }))
}

export interface StaffDecisionDeps {
  db: Database
  freePlanId: string
  ownerInfo: (clerkUserId: string) => Promise<OwnerInfo | null>
  rules: readonly Rule[]
  holds: HoldStore
  assessments: AssessmentStore
  snapshots: SnapshotStore
  decisions: DecisionStore
  contentModel?: string
  /** The content judge's first model, when one is configured. */
  judgeModel?: string
  now?: () => Date
}

export interface StaffDecisionInput {
  tenantId: string
  kind: DecisionKind
  by: string
  note: string
  /** Release or pin only: clear just these rules' concerns. All live ones when absent. */
  rules?: readonly string[]
  /** Release: how long automatic actions pause. Pin: until when. */
  pauseUntil?: Date
  pauseDays?: number
  /** Hold only. */
  hold?: Pick<Parameters<HoldStore["hold"]>[0], "category" | "scope">
}

export type StaffDecisionResult =
  | { status: "recorded"; id: string; evaluated: Evaluated; covers: Concern[] }
  | { status: "not_held" | "already_held" | "no_assessment" }

/**
 * Makes a staff decision and records it: release, uphold, pin or hold.
 *
 * ⚠ THE CONCERNS IN VIEW ARE THE ENGINE'S ANSWER RIGHT NOW, with every earlier
 * decision applied: what `risk-admin explain` shows, and exactly what the
 * forced snapshot will replay to.
 */
export async function staffDecision(
  deps: StaffDecisionDeps,
  input: StaffDecisionInput,
): Promise<StaffDecisionResult> {
  const { tenantId, kind, by, note } = input
  if (!by.trim() || !note.trim())
    throw new RangeError("a decision needs --by and a note")
  const clears = kind === "release" || kind === "pin"
  if (input.rules && !clears)
    throw new RangeError("only a release or a pin clears concerns")

  const at = deps.now?.() ?? new Date()
  const facts = await loadFacts(tenantId, {
    db: deps.db,
    freePlanId: deps.freePlanId,
    ownerInfo: deps.ownerInfo,
    now: at,
    ...(deps.contentModel ? { contentModel: deps.contentModel } : {}),
    ...(deps.judgeModel ? { judgeModel: deps.judgeModel } : {}),
  })
  const evaluated = evaluate(facts, deps.rules)
  const covers = clears ? concernsFor(evaluated.contributions, input.rules) : []
  const held = (await deps.holds.current(tenantId)) !== null

  let id = ""
  const record = async (tx: Tx) => {
    const snapshotId = await deps.snapshots.record({
      tenantId,
      at,
      trigger: `staff:${kind}`,
      evaluated,
      facts,
      force: true,
      through: tx,
    })
    id = await deps.decisions.save(tx, {
      tenantId,
      kind,
      decidedBy: by,
      note,
      decidedAt: at,
      score: evaluated.score,
      band: evaluated.band,
      rulesetVersion: evaluated.rulesetVersion,
      held,
      inView: evaluated.contributions.filter((c) => c.points > 0),
      covers,
      expiresAt: new Date(at.getTime() + DECISION_MEMORY_DAYS * 86_400_000),
      snapshotId,
    })
  }

  if (kind === "release" || kind === "uphold") {
    const released = await deps.holds.release({
      tenantId,
      setBy: by,
      reason: note,
      outcome: kind === "release" ? "false_positive" : "upheld",
      ...(input.pauseDays !== undefined ? { pauseDays: input.pauseDays } : {}),
      alsoInTx: record,
    })
    if (!released) return { status: "not_held" }
  } else if (kind === "pin") {
    const until = input.pauseUntil ?? new Date(at.getTime() + 30 * 86_400_000)
    const pinned = await deps.assessments.pause(
      tenantId,
      until,
      at,
      { by, reason: note },
      record,
    )
    if (!pinned) return { status: "no_assessment" }
  } else {
    const placed = await deps.holds.hold({
      tenantId,
      source: "staff",
      reason: note,
      setBy: by,
      category: input.hold?.category ?? "sending_pattern",
      ...(input.hold?.scope ? { scope: input.hold.scope } : {}),
      alsoInTx: record,
    })
    if (!placed) return { status: "already_held" }
  }
  return { status: "recorded", id, evaluated, covers }
}

/** One staff decision as an evaluation case: the engine's view beside the person's. */
export interface DecisionCase {
  decision: string
  tenantId: string
  snapshotId: string | null
  decidedAt: string
  engine: { score: number; band: Band; held: boolean; rulesetVersion: number }
  staff: { kind: DecisionKind; by: string; note: string }
  /** The engine wanted to act and staff let it go, or it saw nothing and staff acted. */
  disagree: boolean
  revoked: boolean
}

/**
 * Whether staff and the engine disagreed: the engine held the workspace or
 * scored it high and staff released or pinned it, or the engine scored it low
 * and staff held it or upheld a hold.
 */
export function disagrees(d: Pick<StoredDecision, "kind" | "band" | "held">): boolean {
  if (d.kind === "release" || d.kind === "pin")
    return d.held || bandRank(d.band) >= bandRank("high")
  return d.band === "low"
}

/** The cases, disagreements first, then newest first. */
export function decisionCases(decisions: readonly StoredDecision[]): DecisionCase[] {
  return decisions
    .map((d) => ({
      decision: d.id,
      tenantId: d.tenantId,
      snapshotId: d.snapshotId,
      decidedAt: d.decidedAt.toISOString(),
      engine: {
        score: d.score,
        band: d.band,
        held: d.held,
        rulesetVersion: d.rulesetVersion,
      },
      staff: { kind: d.kind, by: d.decidedBy, note: d.note },
      disagree: disagrees(d),
      revoked: d.revokedAt !== null,
    }))
    .sort(
      (a, b) =>
        Number(b.disagree) - Number(a.disagree) ||
        b.decidedAt.localeCompare(a.decidedAt),
    )
}
