import {
  GetTenantCommand,
  ListTenantsCommand,
  type SESv2Client,
} from "@aws-sdk/client-sesv2"
import { workspaceOfSesTenant } from "../domains/identity.js"
import { SYSTEM_SES_TENANT } from "../system-mail.js"
import { toSendingStatus, type SesSendingStatus } from "./event.js"
import type { StatusService } from "./service.js"
import type { SesStatusStore } from "./store.js"

/**
 * The daily re-read of every tenant's sending status (#157).
 *
 * ⚠ THE NET UNDER THE EVENTS, NOT THE MAIN PATH. EventBridge delivers to SNS at
 * least once but an event can still be lost - a rule edited, a topic policy
 * changed, our endpoint down for longer than SNS retries. A workspace paused by
 * a lost event would keep having its sends accepted and then deferred by SES
 * with nobody told, so once a day this asks SES directly.
 *
 * ⚠ ONLY A DIFFERENCE IS REPORTED. `GetTenant` carries no status timestamp, so
 * a poll-found change is stamped with the time it was found; applying every
 * tenant's unchanged status would stamp a fresh "change" into the history
 * every night.
 */
export interface TenantStatusReader {
  /** Every tenant this code manages: workspace tenants and our own. */
  tenants(): Promise<string[]>
  status(tenant: string): Promise<SesSendingStatus | null>
}

export function sesTenantStatusReader(client: SESv2Client): TenantStatusReader {
  return {
    async tenants() {
      const names: string[] = []
      let token: string | undefined
      do {
        const page = await client.send(new ListTenantsCommand({ NextToken: token }))
        for (const t of page.Tenants ?? []) {
          const name = t.TenantName
          if (name && (name === SYSTEM_SES_TENANT || workspaceOfSesTenant(name))) {
            names.push(name)
          }
        }
        token = page.NextToken
      } while (token)
      return names
    },
    async status(tenant) {
      const out = await client.send(new GetTenantCommand({ TenantName: tenant }))
      return toSendingStatus(out.Tenant?.SendingStatus)
    },
  }
}

export interface PollSummary {
  checked: number
  changed: number
  failed: number
}

export async function pollTenantStatuses({
  reader,
  store,
  service,
  now = () => new Date(),
  log,
}: {
  reader: TenantStatusReader
  store: Pick<SesStatusStore, "current">
  service: StatusService
  now?: () => Date
  log?: { error?: (o: object, m: string) => void }
}): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, changed: 0, failed: 0 }

  for (const tenant of await reader.tenants()) {
    try {
      const status = await reader.status(tenant)
      summary.checked += 1
      if (!status) continue

      const workspace = workspaceOfSesTenant(tenant)
      const known = workspace
        ? ((await store.current(workspace))?.status ?? "enabled")
        : null
      // Our own tenant has no row; only a pause is worth reporting for it.
      if (workspace ? status === known : status !== "disabled") continue

      const outcome = await service.apply(
        {
          sesTenant: tenant,
          status,
          cause: "Found by the daily status check.",
          origin: null,
          changedAt: now(),
        },
        "poll",
      )
      if (outcome === "changed") summary.changed += 1
    } catch (error) {
      summary.failed += 1
      log?.error?.(
        { err: error, tenant },
        "could not read an SES tenant's sending status",
      )
    }
  }
  return summary
}
