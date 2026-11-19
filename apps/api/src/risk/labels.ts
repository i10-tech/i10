import { and, eq, gt } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { riskLabels } from "../db/core.js"

/**
 * Labels (#170): what a workspace turned out to be, the ground truth the rules
 * are measured against.
 *
 * ⚠ LABELS COME FROM WHAT ACTUALLY HAPPENED, NEVER FROM THE SCORE ITSELF. A
 * label taken from the score's own holds would only measure the rules against
 * themselves. The sources are a person's verdict, SES or AWS pausing the
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
  setBy: string
  note?: string
}

export interface LabelStore {
  add(input: LabelInput): Promise<void>
  /** Whether this workspace already has a label from this source since a date. */
  has(tenantId: string, source: LabelSource, since: Date): Promise<boolean>
}

export function labelStore(db: Database): LabelStore {
  return {
    async add(i) {
      await withTenant(db, i.tenantId, (tx) =>
        tx.insert(riskLabels).values({
          tenantId: i.tenantId,
          label: i.label,
          source: i.source,
          weight: LABEL_WEIGHTS[i.source],
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
  }
}
