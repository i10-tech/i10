import { and, eq, gt, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { riskLabels } from "../db/core.js"
import { train, type LabeledRow, type ModelWeights, type Evaluation } from "./model.js"

/**
 * Labels and models (#170): the memory the model learns from, and the models
 * it produced.
 *
 * ⚠ LABELS COME FROM WHAT ACTUALLY HAPPENED, NEVER FROM THE SCORE ITSELF. A
 * model trained on the score's own holds would learn to agree with the rules
 * and add nothing. The sources are a person's verdict, SES or AWS pausing the
 * workspace, and a long clean record - each weighted by how much it proves.
 */
export type LabelSource =
  "staff" | "hold_upheld" | "hold_released" | "ses_aws_pause" | "tenure"

export const LABEL_WEIGHTS: Readonly<Record<LabelSource, number>> = {
  staff: 2,
  hold_upheld: 2,
  hold_released: 2,
  ses_aws_pause: 1,
  tenure: 0.5,
}

export interface LabelInput {
  tenantId: string
  label: "abuse" | "legit"
  source: LabelSource
  features: Record<string, number>
  setBy: string
  note?: string
}

export interface ModelRecord {
  version: number
  weights: ModelWeights
  evaluation: Evaluation
  active: boolean
  trainedAt: Date
}

export interface LabelStore {
  add(input: LabelInput): Promise<void>
  /** Whether this workspace already has a label from this source since a date. */
  has(tenantId: string, source: LabelSource, since: Date): Promise<boolean>
  count(): Promise<number>
  rows(): Promise<LabeledRow[]>
  model(activeOnly: boolean): Promise<ModelRecord | null>
  saveModel(
    weights: ModelWeights,
    evaluation: Evaluation,
    active: boolean,
  ): Promise<number>
  /** Trains on every label and saves the result, active only if it passed. */
  retrain(): Promise<{ version: number; evaluation: Evaluation; active: boolean }>
}

type Row = Record<string, unknown>

export function labelStore(db: Database): LabelStore {
  const store: LabelStore = {
    async add(i) {
      await withTenant(db, i.tenantId, (tx) =>
        tx.insert(riskLabels).values({
          tenantId: i.tenantId,
          label: i.label,
          source: i.source,
          weight: LABEL_WEIGHTS[i.source],
          features: i.features,
          setBy: i.setBy,
          note: i.note ?? null,
        }),
      )
    },

    async has(tenantId, source, since) {
      const rows = await withTenant(db, tenantId, (tx) =>
        tx
          .select({ id: riskLabels.id })
          .from(riskLabels)
          .where(
            and(
              eq(riskLabels.tenantId, tenantId),
              eq(riskLabels.source, source),
              gt(riskLabels.labeledAt, since),
            ),
          )
          .limit(1),
      )
      return rows.length > 0
    },

    async count() {
      const rows = (await db.execute(
        sql`select core.risk_label_count() as n`,
      )) as unknown as Row[]
      return Number(rows[0]?.n ?? 0)
    },

    async rows() {
      const rows = (await db.execute(
        sql`select label, weight, features from core.risk_training_rows()`,
      )) as unknown as Row[]
      return rows.map((r) => ({
        label: r.label === "abuse" ? "abuse" : "legit",
        weight: Number(r.weight ?? 1),
        features: (r.features ?? {}) as Record<string, number>,
      }))
    },

    async model(activeOnly) {
      const rows = (await db.execute(
        sql`select * from core.risk_model_get(${activeOnly})`,
      )) as unknown as Row[]
      const r = rows[0]
      if (!r) return null
      return {
        version: Number(r.version),
        weights: r.weights as ModelWeights,
        evaluation: r.evaluation as Evaluation,
        active: r.active === true,
        trainedAt: new Date(r.trained_at as string),
      }
    },

    async saveModel(weights, evaluation, active) {
      const rows = (await db.execute(sql`
        select core.risk_model_save(${JSON.stringify(weights)}::jsonb, ${JSON.stringify(evaluation)}::jsonb, ${active}) as v
      `)) as unknown as Row[]
      return Number(rows[0]?.v)
    },

    async retrain() {
      const rows = await store.rows()
      const result = train(rows)
      const version = await store.saveModel(
        result.model,
        result.evaluation,
        result.active,
      )
      return { version, evaluation: result.evaluation, active: result.active }
    },
  }
  return store
}
