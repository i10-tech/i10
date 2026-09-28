import {
  GetReputationEntityCommand,
  ListRecommendationsCommand,
  ListTenantsCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2"
import { workspaceOfSesTenant } from "../domains/identity.js"
import { SYSTEM_SES_TENANT } from "../system-mail.js"
import {
  toImpact,
  toSendingStatus,
  type FindingImpact,
  type SesSendingStatus,
} from "./event.js"
import type { ReputationService, SesFinding } from "./reputation.js"
import type { ReputationStore } from "./reputation-store.js"

/**
 * The daily re-read of every tenant's reputation (#158): findings reconciled,
 * and one snapshot per workspace.
 *
 * ⚠ THE NET UNDER THE ADVISOR EVENTS, as poll.ts is under the status events.
 * It is also the only source of the policy and the aggregate status, which no
 * event carries.
 */
export interface TenantReputation {
  open: SesFinding[]
  sendingStatus: SesSendingStatus | null
  impact: FindingImpact | null
  /** `standard`, `strict`, `none` - the last segment of the policy ARN. */
  policy: string | null
}

export interface ReputationReader {
  tenants(): Promise<{ name: string; arn: string }[]>
  read(arn: string): Promise<TenantReputation>
}

export function sesReputationReader(client: SESv2Client): ReputationReader {
  return {
    async tenants() {
      const out: { name: string; arn: string }[] = []
      let token: string | undefined
      do {
        const page = await client.send(new ListTenantsCommand({ NextToken: token }))
        for (const t of page.Tenants ?? []) {
          const name = t.TenantName
          if (
            name &&
            t.TenantArn &&
            (name === SYSTEM_SES_TENANT || workspaceOfSesTenant(name))
          ) {
            out.push({ name, arn: t.TenantArn })
          }
        }
        token = page.NextToken
      } while (token)
      return out
    },

    async read(arn) {
      const open: SesFinding[] = []
      let token: string | undefined
      do {
        // ⚠ FILTERED BY RESOURCE ONLY. The API accepts RESOURCE_ARN alone or
        // STATUS with IMPACT or TYPE, not RESOURCE_ARN with STATUS - so the
        // resolved ones come back too and are dropped here.
        const page = await client.send(
          new ListRecommendationsCommand({
            Filter: { RESOURCE_ARN: arn },
            PageSize: 100,
            NextToken: token,
          }),
        )
        for (const r of page.Recommendations ?? []) {
          const impact = toImpact(r.Impact)
          if (r.Status !== "OPEN" || !r.Type || !impact) continue
          open.push({
            type: r.Type.toLowerCase(),
            impact,
            description: r.Description ?? null,
            createdAt: r.CreatedTimestamp ?? r.LastUpdatedTimestamp ?? new Date(),
          })
        }
        token = page.NextToken
      } while (token)

      const entity = (
        await client.send(
          new GetReputationEntityCommand({
            ReputationEntityType: "RESOURCE",
            ReputationEntityReference: arn,
          }),
        )
      ).ReputationEntity

      return {
        open,
        sendingStatus: toSendingStatus(entity?.SendingStatusAggregate),
        impact: toImpact(entity?.ReputationImpact),
        policy:
          entity?.ReputationManagementPolicy?.split("/").pop()?.toLowerCase() ?? null,
      }
    },
  }
}

export interface ReputationPollSummary {
  checked: number
  opened: number
  resolved: number
  snapshots: number
  failed: number
}

const DAY = 24 * 60 * 60 * 1000

export async function pollReputation({
  reader,
  service,
  store,
  now = () => new Date(),
  log,
}: {
  reader: ReputationReader
  service: ReputationService
  store: Pick<ReputationStore, "counts" | "snapshot">
  now?: () => Date
  log?: { error?: (o: object, m: string) => void }
}): Promise<ReputationPollSummary> {
  const summary: ReputationPollSummary = {
    checked: 0,
    opened: 0,
    resolved: 0,
    snapshots: 0,
    failed: 0,
  }

  for (const tenant of await reader.tenants()) {
    try {
      const at = now()
      const reputation = await reader.read(tenant.arn)
      summary.checked += 1

      const found = await service.reconcile(tenant.name, reputation.open, at)
      summary.opened += found.opened
      summary.resolved += found.resolved

      // Our own tenant has no workspace to snapshot against; its findings
      // went to Sentry in reconcile.
      const tenantId = workspaceOfSesTenant(tenant.name)
      if (!tenantId) continue
      const [day1, day7] = await Promise.all([
        store.counts(tenantId, new Date(at.getTime() - DAY)),
        store.counts(tenantId, new Date(at.getTime() - 7 * DAY)),
      ])
      await store.snapshot({
        tenantId,
        day: at.toISOString().slice(0, 10),
        sendingStatus: reputation.sendingStatus,
        impact: reputation.impact,
        policy: reputation.policy,
        day1,
        day7,
      })
      summary.snapshots += 1
    } catch (error) {
      // A workspace deleted while its SES tenant lingers: nothing to snapshot.
      if ((error as { code?: string }).code === "23503") continue
      summary.failed += 1
      log?.error?.(
        { err: error, tenant: tenant.name },
        "could not read an SES tenant's reputation",
      )
    }
  }
  return summary
}
