import type { Metadata } from "next"
import { UsageView } from "@/components/usage-view"
import { PanelError } from "@/components/panel-error"
import { tryApi } from "@/lib/api"
import { usageShape, type UsageData } from "@/lib/shapes/usage"
import type { BillingState, FeatureUsage, SendingLimit } from "@/lib/types"

export const metadata: Metadata = { title: "Usage" }

/**
 * What this workspace has consumed.
 *
 * ⚠ THE NUMBERS COME FROM THE SAME METER THAT ENFORCES THE LIMIT. A separate
 * read-side query would drift from the one the send path uses, and the failure
 * mode is specific and awful: a dashboard showing 40,000 of 50,000 while
 * sending is being refused.
 *
 * ⚠ SENDING IS SHOWN AS ONE ROW PER WINDOW, LIKE CLAUDE'S SESSION AND WEEKLY
 * LIMITS. A free workspace can be refused by its day OR its month, so both are
 * on screen together; a paid one sees its month and a daily row that says it
 * has no daily limit, so the page reads the same for everybody.
 *
 * ⚠ AND `unentitled` IS RENDERED AS ITSELF, NEVER AS "0 of 0". It means the
 * plan grants nothing for that feature - which is almost always OUR
 * misconfiguration. Showing a full meter would tell a customer who has sent
 * nothing to go and upgrade, and they would, which makes our bug invisible to
 * us.
 */
export default async function UsagePage() {
  const result = await tryApi<{
    usage: FeatureUsage[]
    limits: SendingLimit[]
    billing: BillingState
    members: {
      members: number
      invitations: number
      limit: number
      free: number
    } | null
  }>("/console/usage")

  if (!result.ok) {
    return (
      <PanelError title="Could not load your usage" message={result.error.message} />
    )
  }

  const data: UsageData = result.data

  return <UsageView shape={usageShape.of(data)} data={data} />
}
